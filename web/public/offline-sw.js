/* Public application shell only. Game data stays under the selected OPFS policy.
 * Build replaces these tokens; never cache account, save, relay or game API data. */
const SHELL_CACHE = 'doom3-shell-__SHELL_VERSION__';
const ENGINE_CACHE = 'doom3-engine-offline-v1';
const SHELL_FILES = __SHELL_FILES__;
const shellPaths = new Set(SHELL_FILES);
const enginePath = /^\/engine-worker\/[a-f0-9]{24}\/doom3_bfg_web\.(?:js|wasm)$/;
const pendingEngineFiles = new Map();

async function loadEngineFile(path) {
  const cache = await caches.open(ENGINE_CACHE);
  const saved = await cache.match(path);
  if (saved) return saved;
  let pending = pendingEngineFiles.get(path);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(path, { credentials: 'same-origin' });
      if (response.ok && !response.redirected) await cache.put(path, response.clone());
      return response;
    })().finally(() => pendingEngineFiles.delete(path));
    pendingEngineFiles.set(path, pending);
  }
  return (await pending).clone();
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // A failed/partial install must not replace the working offline shell.
    await cache.addAll(SHELL_FILES.map(path => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    for (const name of await caches.keys()) {
      if (name.startsWith('doom3-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
  })());
});

async function cacheEngine(version) {
  if (!/^[a-f0-9]{24}$/.test(version)) throw new Error('Invalid engine version');
  const response = await fetch('/engine-worker/build-info.json', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Engine authorization/download unavailable');
  const build = await response.clone().json();
  if (build.format !== 1 || build.version !== version ||
      build.modulePath !== `${version}/doom3_bfg_web.js` || build.wasmPath !== `${version}/doom3_bfg_web.wasm`) {
    throw new Error('Engine changed while preparing offline mode; reload');
  }
  const cache = await caches.open(ENGINE_CACHE);
  for (const path of [build.modulePath, build.wasmPath]) {
    const url = `/engine-worker/${path}`;
    const file = await loadEngineFile(url);
    if (!file.ok || file.redirected) throw new Error('Incomplete offline engine');
  }
  // Commit the manifest last: offline boot can never select an incomplete pair.
  await cache.put('/engine-worker/build-info.json', response);
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_ENGINE' || !event.ports[0]) return;
  event.waitUntil(cacheEngine(event.data.version).then(
    () => event.ports[0].postMessage({ ok: true }),
    error => event.ports[0].postMessage({ ok: false, error: String(error) }),
  ));
});

async function networkWithFallback(request, cache, key) {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(4000) });
    if (response.status < 500) return response; // Never mask 401/403 with cached authorization.
    return await cache.match(key) || response;
  } catch (error) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(request.method)) return;
  const navigation = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  const manifest = url.pathname === '/engine-worker/build-info.json';
  const engine = enginePath.test(url.pathname);
  if (!navigation && !manifest && !engine && !shellPaths.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(engine || manifest ? ENGINE_CACHE : SHELL_CACHE);
    const key = navigation ? '/' : url.pathname;
    let response;
    if (navigation || manifest) response = await networkWithFallback(request, cache, key);
    else if (engine) response = await loadEngineFile(key);
    else response = await cache.match(key) || await fetch(request);
    // HEAD is used by the engine probe. Offline it must see the cached GET headers.
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
  })());
});
