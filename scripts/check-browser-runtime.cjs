// Exercise the actual SDK resource helpers without starting a browser or engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const mainSource = fs.readFileSync(path.join(__dirname, '../web/src/main.ts'), 'utf8');
const selectionStart = mainSource.indexOf('function isMapArchive(');
const selectionEnd = mainSource.indexOf('let opfsRootHandle', selectionStart);
assert(selectionStart >= 0 && selectionEnd > selectionStart);
const selection = vm.createContext({ browserPreferences: { cacheMode: 1 } });
vm.runInContext(stripTypeScriptTypes(mainSource.slice(selectionStart, selectionEnd), { mode: 'strip' }), selection);
for (const resource of ['base/maps/mars_city1.resources', 'base/video/uac.bik', 'base/sound/VO/video/pda.bik']) {
  assert.equal(selection.isPermanentBootAsset(resource), false, `${resource} must load on demand`);
}
assert.equal(selection.isPermanentBootAsset('base/_common.resources'), true);
selection.browserPreferences.cacheMode = 3;
assert.equal(selection.isPermanentBootAsset('base/sound/VO/video/pda.bik'), true, 'full-cache opt-in retains videos');
assert.equal(selection.isPermanentBootAsset('base/maps/mars_city1.resources'), false, 'map-cache owns map archives separately');

const source = fs.readFileSync(path.join(__dirname,
  '../.tools/emsdk/upstream/emscripten/src/runtime_pthread.js'), 'utf8');
assert.equal((source.match(/pthread exception:/g) || []).length, 1, 'only the outer worker handler reports exceptions');
assert.match(source, /if \(ex != 'unwind'\) \{\s+const originalWorkerFatal = '\[BFG Engine Error\] pthread exception:/,
  'normal Emscripten unwind must not be reported as a crash');
for (const name of ['stageVideoResource', 'releaseVideoResource', 'stageMapResources',
  'releaseMapResourcesExcept', 'stageMapLoadingImage', 'releaseMapLoadingImage']) {
  assert.equal(source.split(`Module['${name}'] =`).length - 1, 1, `${name} must have one owner`);
}
const start = source.indexOf("Module['stageVideoResource'] =");
const end = source.indexOf("Module['releaseMapResourcesExcept'] =", start);
assert(start >= 0 && end > start);
let destroyed = 0;
const context = vm.createContext({
  Module: {}, stagedVideoFiles: {}, videoStagingPromises: {},
  FS: { destroyNode() { ++destroyed; } }, mapOut() {}, mapErr() {},
});
vm.runInContext(source.slice(start, end), context);

(async () => {
  const key = 'video/test.bik';
  const bytes = new Uint8Array([1, 2, 3]);
  const node = { name: 'test.bik', parent: { contents: {} }, contents: bytes };
  node.parent.contents[node.name] = node;
  context.stagedVideoFiles[key] = { bytes, node, path: key, references: 1 };
  assert.equal(await context.Module.stageVideoResource(key), true);
  assert.equal(context.stagedVideoFiles[key].references, 2);
  assert.equal(context.Module.releaseVideoResource(key), 0);
  assert.deepEqual([...bytes], [1, 2, 3], 'a second reader must retain its video');
  assert.equal(destroyed, 0);
  assert.equal(context.Module.releaseVideoResource(key), 3);
  assert.equal(destroyed, 1);
  assert.equal(node.contents, null);
  assert.deepEqual([...bytes], [0, 0, 0]);
  assert.equal(context.Module.releaseVideoResource(key), 0, 'repeat close must be harmless');

  let resolve;
  context.videoStagingPromises[key] = new Promise(done => { resolve = done; });
  const joined = context.Module.stageVideoResource(key);
  context.stagedVideoFiles[key] = { bytes: new Uint8Array(4), references: 1 };
  resolve(true);
  assert.equal(await joined, true);
  assert.equal(context.stagedVideoFiles[key].references, 2, 'pending readers must acquire a reference');
  assert.equal(await context.Module.stageVideoResource('../test.bik'), false);

  // Exercise the actual streaming helper with two matching archives, including
  // decompressed-byte progress and a revisit that already has mounted data.
  const mapStart = source.indexOf("Module['stageMapResources'] =");
  const mapEnd = source.indexOf('var stagedVideoFiles =', mapStart);
  assert(mapStart >= 0 && mapEnd > mapStart);
  const progress = [];
  let fileRequests = 0;
  const files = [{ path: 'base/maps/test.resources', size: 10 },
    { path: 'd3xp/maps/test.resources', size: 30 }];
  const mapContext = vm.createContext({
    Module: {}, mapApi: { manifestUrl: '/manifest', fileUrl: '/file' },
    mapManifestPromise: null, mapManifestController: null, mapCacheMode: 1,
    stagedMapFiles: {}, stagingPromises: {},
    mapEnsureDirectory: () => ({}), mapOut() {}, mapErr() {},
    WORKERFS: { FILE_MODE: 0, stream_ops: {}, createNode: () => ({}) },
    AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      if (url === '/manifest') return { ok: true, json: async () => ({ files }) };
      ++fileRequests;
      const file = files.find(entry => url.endsWith(encodeURIComponent(entry.path)));
      assert(file);
      const chunks = [new Uint8Array(file.size / 2), new Uint8Array(file.size / 2)];
      return { ok: true, status: 200, body: { getReader: () => ({
        read: async () => {
          progress.push(mapContext.Module.webMapDownloadProgress);
          return chunks.length ? { value: chunks.shift(), done: false } : { done: true };
        },
      }) } };
    },
  });
  vm.runInContext(source.slice(mapStart, mapEnd), mapContext);
  assert.equal(await mapContext.Module.stageMapResources('game/test'), true);
  assert.equal(mapContext.Module.webMapDownloadProgress, 1);
  assert.equal(fileRequests, 2);
  assert(progress.some(value => value > 0 && value < 1), 'streamed bytes must report intermediate progress');
  assert(progress.every((value, index) => !index || value >= progress[index - 1]), 'progress must be monotonic across archives');
  assert.equal(Object.keys(mapContext.stagedMapFiles).length, 2);
  assert.equal(await mapContext.Module.stageMapResources('game/test'), true);
  assert.equal(fileRequests, 2, 'mounted archives must not download again');
  assert.equal(mapContext.Module.webMapDownloadProgress, 1);
  console.log('Browser runtime: helper uniqueness, video lifetimes and streamed/mounted map progress checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
