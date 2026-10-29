// Real Chromium service-worker test, using synthetic app/engine bytes, not game data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { chromium } = require('../web/node_modules/playwright');
const version = '1234567890abcdef12345678';
const worker = fs.readFileSync('web/public/offline-sw.js', 'utf8')
  .replace('__SHELL_VERSION__', 'browser-fixture').replace('__SHELL_FILES__', JSON.stringify(['/', '/assets/app.js']));
const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Offline fixture</title><script src="/assets/app.js"></script>');
  }
  if (req.url === '/offline-sw.js' || req.url === '/assets/app.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(req.url === '/offline-sw.js' ? worker : 'window.shellLoaded = true;');
  }
  if (req.url === '/engine-worker/build-info.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ format: 1, version, modulePath: `${version}/doom3_bfg_web.js`, wasmPath: `${version}/doom3_bfg_web.wasm` }));
  }
  if (req.url === `/engine-worker/${version}/doom3_bfg_web.js`) {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(`self.onmessage = async () => { const bytes = await (await fetch('/engine-worker/${version}/doom3_bfg_web.wasm')).arrayBuffer(); await WebAssembly.compile(bytes); postMessage(bytes.byteLength); };`);
  }
  if (req.url === `/engine-worker/${version}/doom3_bfg_web.wasm`) {
    res.setHeader('Content-Type', 'application/wasm'); return res.end(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  }
  res.statusCode = 401; res.end('Private API');
});
(async () => {
  let browser;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/offline-sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const prepared = await page.evaluate(version => new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => resolve(event.data);
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_ENGINE', version }, [channel.port2]);
    }), version);
    assert.equal(prepared.ok, true);
    await context.setOffline(true);
    await page.reload();
    assert.equal(await page.evaluate(() => window.shellLoaded && crossOriginIsolated), true);
    const engine = await page.evaluate(async version => {
      const manifest = await (await fetch('/engine-worker/build-info.json', { cache: 'no-store' })).json();
      const head = await fetch(`/engine-worker/${version}/doom3_bfg_web.js`, { method: 'HEAD' });
      const wasm = await fetch(`/engine-worker/${version}/doom3_bfg_web.wasm`);
      return { version: manifest.version, head: head.status, bytes: [...new Uint8Array(await wasm.arrayBuffer())] };
    }, version);
    assert.equal(engine.version, version); assert.equal(engine.head, 200);
    assert.deepEqual(engine.bytes, [0, 97, 115, 109, 1, 0, 0, 0]);
    const workerBytes = await page.evaluate(version => new Promise((resolve, reject) => {
      const worker = new Worker(`/engine-worker/${version}/doom3_bfg_web.js`);
      worker.onmessage = event => { worker.terminate(); resolve(event.data); };
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage('load');
    }), version);
    assert.equal(workerBytes, 8, 'an actual offline worker must be able to load and compile cached Wasm');
    assert.equal(await page.evaluate(() => fetch('/__session/status').then(() => false, () => true)), true);
    console.log('Chromium offline reload passed: cached launcher + scripts, crossOriginIsolated, engine manifest/HEAD/Wasm; private API remains unreachable (synthetic engine, not gameplay).');
  } finally {
    if (browser) await browser.close();
    server.close(); await once(server, 'close');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
