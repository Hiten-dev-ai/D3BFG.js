const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'apply-emsdk-patches.ps1'), 'utf8');
const begin = source.indexOf('$mapStagingRuntimeBlock = @"');
const start = source.indexOf('\n', begin) + 1;
const end = source.indexOf('\n"@', start);
assert.ok(begin >= 0 && end > start);
const runtime = source.slice(start, end);
const metadata = { manifestUrl: '/__local_game/manifest', cacheMode: 1 };
const boot = mapStaging => {
  const context = { Module: {}, msgData: { mapStaging }, FS: {}, WORKERFS: {} };
  vm.runInNewContext(runtime, context);
  return context.Module;
};
const initial = boot(metadata);
const child = boot(initial.mapStaging);
const grandchild = boot(child.mapStaging);
for (const module of [initial, child, grandchild]) {
  assert.equal(module.mapStaging, metadata);
  assert.equal(typeof module.stageMapLoadingImage, 'function');
  assert.equal(typeof module.releaseMapLoadingImage, 'function');
}
assert.equal(boot(null).stageMapLoadingImage, undefined);
console.log('Actual SDK runtime: map preview staging survives initial, child and grandchild worker handoffs.');
