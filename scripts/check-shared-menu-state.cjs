const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const context = vm.createContext({ TextEncoder });
vm.runInContext(stripTypeScriptTypes(fs.readFileSync('web/src/browserMenuState.ts', 'utf8').replace(/^export /gm, '')) + '\nthis.words=MENU_STATE_WORDS;', context);
const shared = new Int32Array(new SharedArrayBuffer(context.words * 4));
let status = 0, name = 'Marine Ω';
const bridge = {
  getNumber(key) { return key === 'mpStatus' ? status : key === 'mpLobbyCount' ? 2 : 0; },
  getText(key) { return key === 'profileName' ? name : key.startsWith('mpLobbyName') ? `Room ${key.at(-1)}` : ''; },
};
const header = fs.readFileSync('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_BrowserBridge.h', 'utf8');
const start = header.indexOf('EM_ASM({', header.indexOf('static void BrowserBridge_RefreshSnapshot')) + 'EM_ASM({'.length;
const body = header.slice(start, header.indexOf('\n    });', start));
const worker = vm.createContext({ Module: { browserDisplayState: shared }, TextDecoder });
const refresh = () => vm.runInContext(`(function(){${body}\n})()`, worker);
context.publishBrowserMenuState(shared, bridge); refresh();
assert.equal(worker.Module.webMenuSnapshot.texts.profileName, 'Marine Ω');
assert.equal(worker.Module.webMenuSnapshot.texts.mpLobbyName1, 'Room 1');
assert.equal(worker.Module.webMenuSnapshot.numbers.mpStatus, 0);
const version = Atomics.load(shared, 9);
context.publishBrowserMenuState(shared, bridge);
assert.equal(Atomics.load(shared, 9), version, 'unchanged state does not force reparsing each frame');
Atomics.add(shared, 9, 1); refresh();
assert.equal(worker.Module.webMenuVersion, version, 'readers keep their complete snapshot instead of waiting on a busy DOM writer');
Atomics.store(shared, 9, version); status = 2;
context.publishBrowserMenuState(shared, bridge); refresh();
assert.equal(worker.Module.webMenuSnapshot.numbers.mpStatus, 2);
name = 'x'.repeat(70000);
context.publishBrowserMenuState(shared, bridge); refresh();
assert.equal(worker.Module.webMenuSnapshot.texts.profileName, 'Marine Ω', 'oversized state never corrupts the last good snapshot');
const getters = header.slice(header.indexOf('static int BrowserBridge_GetNumber'), header.indexOf('static void BrowserBridge_SetNumber'));
assert(!getters.includes('MAIN_THREAD_EM_ASM'), 'pure menu reads must never synchronously proxy to the DOM thread');
console.log('Actual shared menu publisher/worker reader: Unicode, dynamic rooms, stable revisions, nonblocking concurrent publication, bounds and no synchronous DOM reads passed.');
