// Run the actual boot synchronizer with in-memory network/OPFS fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { File } = require('node:buffer');
const source = fs.readFileSync(`${__dirname}/../web/src/main.ts`, 'utf8');
const policies = source.slice(source.indexOf('function isMapArchive('), source.indexOf('let opfsRootHandle'));
const sync = source.slice(source.indexOf('async function syncAssetsToOpfs('), source.lastIndexOf('/**', source.indexOf('function isSharedMemorySupported(')));
assert(sync.includes('return stagedFiles;'));

async function run(mode, offline, stale = false) {
  const boot = { path: 'base/_common.resources', size: 3, etag: 'current' };
  const manifest = { files: [boot, { path: 'base/maps/test.resources', size: 5, etag: 'map' }], manifestEtag: 'fixture' };
  const meta = { files: { [boot.path]: { size: 3, etag: stale ? 'old' : 'current' } } };
  let downloads = 0, opfsCalls = 0, offlineMarked = false;
  const file = new File([new Uint8Array([1, 2, 3])], '_common.resources');
  const context = vm.createContext({
    console: { log() {}, warn() {} }, navigator: { onLine: !offline },
    browserPreferences: { cacheMode: mode }, performance, Response, TransformStream, File, AbortController, AbortSignal,
    OPFS_PERM_DIR: 'permanent', activeManifest: null, opfsRootHandle: null, discoveredMapArchiveNames: null,
    readCachedManifest: () => manifest, writeCachedManifest() {},
    looksLikeNetworkFailure: () => true, markBootedOffline: value => { offlineMarked = value; }, queueNativeNotice() {},
    updateLoadingProgress() {}, formatBytes: String, formatEta: String, previousEngineStartupSeconds: () => null,
    fetch: async url => {
      if (offline) throw new TypeError('Failed to fetch');
      if (url === '/__local_game/manifest') return Response.json(manifest);
      assert(!url.includes('maps'), 'boot must never fetch level archives');
      downloads++;
      return new Response(new Uint8Array([1, 2, 3]));
    },
    getOpfsRoot: async () => { opfsCalls++; return {}; }, getOpfsSubdir: async () => ({}),
    readStoredMeta: async () => meta, writeStoredMeta: async () => {}, deleteOpfsFile: async () => {},
    verifyOpfsFileExistsAndSize: async () => true,
    collectOpfsFiles: async () => [{ relativePath: boot.path, file }],
    streamFileToOpfs: async (_root, path, _url, progress) => {
      assert.equal(path, boot.path); assert(!offline); downloads++; progress(3);
    },
  });
  vm.runInContext(stripTypeScriptTypes(policies + sync, { mode: 'strip' }), context);
  if (offline && mode === 0) {
    await assert.rejects(context.syncAssetsToOpfs(), /fetch/);
  } else {
    const result = await context.syncAssetsToOpfs();
    assert.equal(result.length, 1);
    assert.equal(result[0].relativePath, boot.path);
  }
  assert.equal(offlineMarked, offline);
  assert.equal(opfsCalls, mode === 0 ? 0 : 1);
  assert.equal(downloads, offline ? 0 : mode === 0 || stale ? 1 : 0);
}

(async () => {
  for (const mode of [0, 1, 2, 3]) {
    await run(mode, false);
    await run(mode, false, true);
    await run(mode, true);
  }
  console.log('Actual boot synchronizer: online cache modes 0–3, stale refresh, offline cached boot, and no boot-time maps passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
