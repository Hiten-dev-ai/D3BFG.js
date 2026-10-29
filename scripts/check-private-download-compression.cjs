// Exercise the real private file handler with precompressed and range responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { pipeline } = require('node:stream');
const { createGzip, gunzipSync } = require('node:zlib');
const source = fs.readFileSync(path.join(__dirname, '../web/server.js'), 'utf8');
const handler = source.slice(source.indexOf('function handleGameFile('), source.indexOf('function handleStaticFile('));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-private-gzip-'));
const relative = 'base/_sound_pc.resources';
const bytes = Buffer.from('Campaign resource sample\n'.repeat(20000));
fs.mkdirSync(path.join(folder, 'base')); fs.writeFileSync(path.join(folder, relative), bytes);
let lookedUp = 0;
let server;
(async () => {
  try {
    const { prepareEncodedAsset, findEncodedAsset } = await import('../web/assetCompression.js');
    const cache = path.join(folder, 'encoded');
    await prepareEncodedAsset(cache, folder, relative);
    const stat = fs.statSync(path.join(folder, relative));
    const entry = { path: relative, size: stat.size, etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"` };
    const context = vm.createContext({ fs, path, pipeline, createGzip, process, serverConfig: { sharedAssetCache: true },
      GAME_DIR: folder, ENCODED_ROOT: cache, RENDERER_SHADER_DIR: folder, RENDERER_SHADER_PATH_PREFIX: 'base/renderprogs/',
      findEncodedAsset(...args) { ++lookedUp; return findEncodedAsset(...args); },
      getPrivateManifest: () => ({ files: [entry], gamePaths: new Set([relative]) }),
      computeEtag: (size, mtime) => `"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`,
      invalidatePrivateManifest() {},
    });
    vm.runInContext(handler + ';this.handle = handleGameFile;', context);
    server = http.createServer((req, res) => context.handle(req, res, new URL(req.url, 'http://localhost')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port,
        path: '/__local_game/file?path=' + relative, headers, method }, res => {
        const chunks = [];res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
        res.on('error', reject);
      });req.on('error', reject); req.end();
    });
    const encoded = await request({ 'Accept-Encoding': 'gzip' });
    assert.equal(encoded.status, 200); assert.equal(encoded.headers['content-encoding'], 'gzip');
    assert.equal(Number(encoded.headers['content-length']), encoded.bytes.length);
    assert.equal(encoded.headers['cache-control'], 'no-store'); assert.deepEqual(gunzipSync(encoded.bytes), bytes);
    assert.equal(lookedUp, 1);
    const ranged = await request({ 'Accept-Encoding': 'gzip', Range: 'bytes=12-23' });
    assert.equal(ranged.status, 206); assert.equal(ranged.headers['content-encoding'], undefined);
    assert.deepEqual(ranged.bytes, bytes.subarray(12,24)); assert.equal(lookedUp,1);
    const head = await request({ 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.bytes.length,0); assert.equal(head.headers['content-length'],encoded.headers['content-length']);
    console.log('Private downloads: precompressed full responses preserve bytes; ranges stay unencoded; no-store and HEAD lengths pass.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(folder.startsWith(path.join(os.tmpdir(), 'doom-private-gzip-')));
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exitCode=1; });
