const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const origin = 'https://offline.test';
const version = '1234567890abcdef12345678';
const listeners = {}, stores = new Map();
let offline = false, denied = false, wasmFails = false;
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const build = { format: 1, version, modulePath: `${version}/doom3_bfg_web.js`, wasmPath: `${version}/doom3_bfg_web.wasm` };
const key = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
const request = class extends Request { constructor(url, init) { super(new URL(url, origin), init); } };
async function fetchMock(value) {
  if (offline) throw new TypeError('offline');
  const url = new URL(key(value));
  if (denied && url.pathname.startsWith('/engine-worker/')) return new Response('Denied', { status: 401 });
  if (wasmFails && url.pathname.endsWith('.wasm')) return new Response('broken', { status: 503 });
  if (url.pathname.endsWith('build-info.json')) return Response.json(build);
  return new Response(url.pathname, { headers });
}
const caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const values = stores.get(name);
    return {
      async match(url) { return values.get(key(url))?.clone(); },
      async put(url, response) { assert(response.ok); values.set(key(url), response.clone()); },
      async addAll(urls) { for (const url of urls) { const r = await fetchMock(url); if (!r.ok) throw Error('precache failed'); values.set(key(url), r); } },
    };
  },
  async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); },
};
const source = fs.readFileSync('web/public/offline-sw.js', 'utf8')
  .replace('__SHELL_VERSION__', 'test').replace('__SHELL_FILES__', JSON.stringify(['/', '/assets/app.js']));
vm.runInNewContext(source, { caches, Request: request, Response, URL, Set, AbortSignal,
  fetch: fetchMock, self: { location: { origin }, clients: { claim: async () => {} }, skipWaiting: async () => {},
    addEventListener: (name, callback) => { listeners[name] = callback; } } });
async function lifecycle(name) { let task; listeners[name]({ waitUntil(value) { task = value; } }); await task; }
async function get(path, options = {}) {
  let task;
  listeners.fetch({ request: { url: origin + path, method: 'GET', ...options }, respondWith(value) { task = value; } });
  return task ? await task : null;
}
async function prepare() {
  let task, result;
  listeners.message({ data: { type: 'CACHE_ENGINE', version }, ports: [{ postMessage(value) { result = value; } }], waitUntil(value) { task = value; } });
  await task;
  return result;
}
(async () => {
  await lifecycle('install'); await lifecycle('activate');
  wasmFails = true;
  assert.equal((await prepare()).ok, false);
  offline = true;
  await assert.rejects(get('/engine-worker/build-info.json'), /offline/, 'never commit a manifest for a partial engine');
  offline = false; wasmFails = false;
  assert.equal((await prepare()).ok, true);
  offline = true;
  const page = await get('/', { mode: 'navigate' });
  assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(await page.text(), '/');
  assert.equal((await get('/engine-worker/build-info.json')).status, 200);
  const head = await get(`/engine-worker/${build.modulePath}`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await get(`/engine-worker/${build.wasmPath}`)).status, 200);
  for (const path of ['/__session/status', '/__browser_sync/manifest', '/__local_game/file?path=base/foo', '/__local_game/manifest', '/__multiplayer']) {
    assert.equal(await get(path), null, 'private account/save/game/relay APIs must never be intercepted');
  }
  assert.equal(await get('/assets/app.js', { method: 'POST' }), null);
  offline = false; denied = true;
  assert.equal((await get('/engine-worker/build-info.json')).status, 401, 'do not hide a real authorization failure');
  console.log('Offline shell: isolated navigation, JS/Wasm pair + HEAD, atomic manifest, and private API exclusion passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
