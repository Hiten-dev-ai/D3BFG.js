// Run the actual static handler against HTTP, including encoded and range bodies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pipeline } = require('node:stream');
const { createGzip, gunzipSync } = require('node:zlib');
const source = fs.readFileSync(path.join(__dirname, '../web/server.js'), 'utf8');
const handler = source.slice(source.indexOf('function handleStaticFile('), source.indexOf('const server = http.createServer'));
const etag = source.slice(source.indexOf('function computeEtag('), source.indexOf('function scanGameDirManifest('));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-static-gzip-'));
const bytes = Buffer.from('DOOM3BFG engine bytes '.repeat(10000));
fs.writeFileSync(path.join(folder, 'engine.wasm'), bytes);
fs.writeFileSync(path.join(folder, 'index.html'), 'launcher');
const context = vm.createContext({ fs, path, pipeline, createGzip, STATIC_ROOT: folder,
  MIME_TYPES: { '.wasm': 'application/wasm', '.html': 'text/html' } });
vm.runInContext(etag + handler + ';this.handle = handleStaticFile;', context);
const server = http.createServer((req, res) => context.handle(req, res, new URL(req.url, 'http://localhost').pathname));
const request = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/engine.wasm', method, headers, agent: false }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject); req.end();
});
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const gzip = await request({ 'Accept-Encoding': 'gzip' });
    assert.equal(gzip.status, 200); assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(gzip.headers['content-type'], 'application/wasm');
    assert.equal(gzip.headers.vary, 'Accept-Encoding');
    assert.deepEqual(gunzipSync(gzip.body), bytes);
    assert(gzip.body.length < bytes.length / 10);
    const raw = await request({ 'Accept-Encoding': 'gzip;q=0' });
    assert.equal(raw.headers['content-encoding'], undefined); assert.deepEqual(raw.body, bytes);
    assert.notEqual(gzip.headers.etag, raw.headers.etag);
    const range = await request({ 'Accept-Encoding': 'gzip', Range: 'bytes=11-127' });
    assert.equal(range.status, 206); assert.equal(range.headers['content-encoding'], undefined);
    assert.equal(range.headers['content-range'], `bytes 11-127/${bytes.length}`);
    assert.deepEqual(range.body, bytes.subarray(11, 128));
    const cached = await request({ 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag });
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
    const head = await request({ 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.headers['content-encoding'], 'gzip'); assert.equal(head.body.length, 0);
    console.log('Static compression: lossless gzip, negotiation, Wasm MIME, identity ranges, representation ETags, HEAD and 304 passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
