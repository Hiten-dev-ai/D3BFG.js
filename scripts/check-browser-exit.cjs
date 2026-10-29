const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(require('node:path').join(__dirname, '../web/src/main.ts'), 'utf8');
assert.match(source, /function showLoadingError\(message: string\): void \{[\s\S]*?if \(!isEngineStarted\) releaseGameLease\(\);/,
  'pre-engine startup failure must release the account reservation');
assert.match(source, /if \(isEngineStarted \|\| gameHasExited \|\| !hasGameLease\(\)\) return;/,
  'downloads finishing after lease loss must not launch the engine');
assert.match(source, /await waitForDisplayCadence\(\);\s*if \(gameHasExited \|\| !hasGameLease\(\)\) return;/,
  'display cadence wait must recheck the lease');
assert.match(source, /throw new Error\('Emscripten module factory was not exported by the loaded script\.'\);\s*\}\s*if \(gameHasExited \|\| !hasGameLease\(\)\) return;/,
  'worker module import must recheck the lease before instantiation');
assert.match(source, /const hasGameLease = \(\): boolean => offlineLease \|\| gameLease\?\.readyState === WebSocket\.OPEN;/,
  'an offline boot substitutes a local lease for the account reservation');
const exit = source.slice(source.indexOf('function showGameExit('), source.indexOf("playAgainButton.addEventListener('click'"));
const guard = source.slice(source.indexOf('const guardLoadingInput ='), source.indexOf("for (const type of ['keydown', 'keyup', 'keypress'])"));
const pointerLockMarker = "document.addEventListener('pointerlockchange', () => {";
const pointerLockStart = source.indexOf(pointerLockMarker);
assert.notEqual(pointerLockStart, -1, 'main retains a pointer-lock lifecycle listener after controls cleanup');
const pointerLockOpen = source.indexOf('{', pointerLockStart);
let pointerLockDepth = 0;
let pointerLockEnd = -1;
for (let i = pointerLockOpen; i < source.length; i++) {
  if (source[i] === '{') pointerLockDepth++;
  if (source[i] === '}' && --pointerLockDepth === 0) { pointerLockEnd = i; break; }
}
assert.notEqual(pointerLockEnd, -1, 'main pointer-lock listener block is complete');
const pointerLockChange = source.slice(pointerLockStart, pointerLockEnd + 1) + ');';
let disposed = 0;
let unlocked = 0;
let focused = 0;
const stoppedEvents = [];
const dataset = {};
const button = { hidden: true, focus() { ++focused; } };
const canvas = { focus() { ++focused; } };
const status = { textContent: '' };
let pointerLockListener;
const context = vm.createContext({
  gameHasExited: false, nativeInputReady: true,
  disposeBrowserControls: () => { ++disposed; },
  canvas,
  Event,
  document: {
    documentElement: { dataset }, pointerLockElement: {},
    exitPointerLock() { ++unlocked; this.pointerLockElement = null; },
    addEventListener(type, listener) { if (type === 'pointerlockchange') pointerLockListener = listener; },
    dispatchEvent(event) { stoppedEvents.push(event.type); return true; },
    getElementById() { return { setAttribute() {} }; },
  },
  loadingOverlay: { classList: { remove() {} } },
  loadingProgressBar: { parentElement: { setAttribute() {} } },
  loadingStatus: status, loadingDetail: {}, playAgainButton: button, playButton: { hidden: false },
  Element: class Element {}, quarantinedKeys: new Set(),
});
vm.runInContext(stripTypeScriptTypes(pointerLockChange), context);
vm.runInContext(stripTypeScriptTypes(exit + guard), context);
vm.runInContext('showGameExit(false)', context);
assert.equal(disposed, 1);
assert.equal(unlocked, 1);
assert.equal(focused, 1);
assert.equal(button.hidden, false);
assert.equal(dataset.doom3InputReady, '0');
assert.equal(dataset.doom3RelativeMouse, '0');
assert.equal(dataset.doom3Exited, '1');
assert.equal(dataset.doom3AwaitingPlay, '0');
assert.equal(context.playButton.hidden, true);
context.document.pointerLockElement = canvas;
pointerLockListener();
assert.equal(context.document.pointerLockElement, null, 'late pointer lock after exit is immediately released');
assert.equal(unlocked, 2);
assert.equal(focused, 1, 'late pointer lock after exit does not steal restart-button focus');
vm.runInContext('showGameExit(true)', context);
assert.equal(status.textContent, 'Game closed', 'late worker abort must not replace a normal exit');
assert.equal(disposed, 1, 'exit cleanup must be idempotent');
assert.deepEqual(stoppedEvents, ['doom3-engine-stopped'], 'engine failure/exit retires its multiplayer transport exactly once');

for (const type of ['keydown', 'keypress', 'keyup']) {
  const event = {
    type, target: button, key: ' ', code: 'Space',
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  context.event = event;
  vm.runInContext('guardLoadingInput(event)', context);
  assert.equal(event.stopped, true, 'restart button keys must not reach SDL');
  assert.notEqual(event.prevented, true, 'restart button keyboard activation must remain native');
}
console.log('Browser exit: one cleanup, pointer release, stable exit state and native restart-button keyboard activation passed.');
assert.match(source, /for \(const type of \['keydown', 'keyup', 'keypress'\]\) window\.addEventListener\(type, guardLoadingInput/,
  'loading quarantine must capture at Window before SDL, not later on Document');
context.nativeInputReady = false;
const key = (type, target) => ({ type, target, key: 'Enter', code: 'Enter',
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
context.event = key('keydown', context.playButton);
vm.runInContext('guardLoadingInput(event)', context);
assert.equal(context.event.prevented, undefined, 'Play button retains native activation');
context.nativeInputReady = true;
for (const type of ['keydown', 'keypress', 'keyup']) {
  context.event = key(type, canvas);
  vm.runInContext('guardLoadingInput(event)', context);
  assert.equal(context.event.stopped, true, 'held startup/Play activation must remain quarantined through release');
}
context.event = key('keydown', canvas);
vm.runInContext('guardLoadingInput(event)', context);
assert.equal(context.event.stopped, undefined, 'a fresh post-load press reaches the native UI');
console.log('Splash input: Window capture and held Play-key quarantine prevent queued activation from reaching the game.');
