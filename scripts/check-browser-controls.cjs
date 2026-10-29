const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

class Surface {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const callback of this.listeners.get(event.type) ?? []) callback(event);
    return true;
  }
}
class Key {
  constructor(type, fields = {}) { Object.assign(this, { type, repeat: false }, fields); }
  preventDefault() { this.prevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() { this.stopped = true; }
}
let now = 1000;
let timerId = 0;
let exitCount = 0;
let resolveLock;
let canvasFocusCount = 0;
let documentFocused = true;
let pointerRequests = 0;
const pointerRequestPromises = [];
const completePointerRequest = () => pointerRequestPromises.at(-1)?.resolve();
const rejectPointerRequest = index => pointerRequestPromises[index]?.reject(new Error('late pointer lock rejection'));
const userActivation = { isActive: false };
const timers = new Map();
const gate = { hidden: true, contains: () => false };
const canvas = new Surface();
canvas.focus = () => {};
const document = new Surface();
canvas.focus = () => { ++canvasFocusCount; document.activeElement = canvas; };
canvas.requestPointerLock = () => {
  ++pointerRequests;
  return new Promise((resolve, reject) => { pointerRequestPromises.push({ resolve, reject }); });
};
Object.assign(document, {
  fullscreenElement: null, pointerLockElement: null, activeElement: canvas,
  documentElement: { dataset: { doom3RelativeMouse: '1', doom3InputReady: '1' } },
  hasFocus: () => documentFocused, getElementById: id => id === 'fullscreen-gate' ? gate : null,
  exitPointerLock() { this.pointerLockElement = null; },
  async exitFullscreen() { ++exitCount; this.fullscreenElement = null; },
});
const window = new Surface();
Object.assign(window, {
  setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
const context = vm.createContext({
  document, window, navigator: { userActivation, keyboard: {
    lock: () => new Promise(resolve => { resolveLock = resolve; }), unlock() {},
  } },
  KeyboardEvent: Key, Node: Surface, console, performance: { now: () => now },
});
let source = fs.readFileSync(path.join(__dirname, '../web/src/browserControls.ts'), 'utf8').replace(/^export /gm, '');
source = stripTypeScriptTypes(source, { mode: 'strip' });
vm.runInContext(source + '\nthis.cleanup = installBrowserControls(document.activeElement);', context);
const press = type => canvas.dispatchEvent(new Key(type, { key: 'Escape', code: 'Escape' }));
const fireTimers = delay => {
  for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
};

(async () => {
  document.fullscreenElement = document.documentElement;
  document.dispatchEvent({ type: 'fullscreenchange' });
  press('keydown');
  assert.equal(timers.size, 0, 'pending keyboard lock must not enable held-Escape exit');
  press('keyup');
  resolveLock(); await new Promise(resolve => setImmediate(resolve));
  press('keydown');
  assert([...timers.values()].some(timer => timer.delay === 2000));
  window.dispatchEvent({ type: 'blur' });
  fireTimers(2000);
  assert.equal(exitCount, 0, 'lost key-up on blur must not exit fullscreen later');
  press('keydown'); press('keyup');
  fireTimers(2000);
  assert.equal(exitCount, 0);

  document.fullscreenElement = null;
  document.dispatchEvent({ type: 'fullscreenchange' });
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  now += 1000;
  let recovered = 0;
  canvas.addEventListener('keydown', event => { if (event.key === 'Escape') ++recovered; });
  document.pointerLockElement = null;
  document.dispatchEvent({ type: 'pointerlockchange' });
  fireTimers(50);
  assert.equal(recovered, 1, 'browser-consumed Escape must reach native pause exactly once');

  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  press('keydown'); press('keyup');
  document.pointerLockElement = null;
  document.dispatchEvent({ type: 'pointerlockchange' });
  const before = recovered;
  fireTimers(50);
  assert.equal(recovered, before, 'an Escape already delivered must not be replayed');

  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  document.dispatchEvent({ type: 'doom3-display-transition' });
  document.pointerLockElement = null;
  document.dispatchEvent({ type: 'pointerlockchange' });
  fireTimers(50);
  assert.equal(recovered, before, 'programmatic fullscreen exit must not synthesize Escape or back');

  document.fullscreenElement = null;
  document.dispatchEvent({ type: 'fullscreenchange' });
  assert.equal(document.activeElement, canvas);
  assert(canvasFocusCount > 0, 'fullscreen exit must return keyboard focus to the canvas');
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  document.activeElement = {};
  now += 2000;
  document.pointerLockElement = null;
  document.dispatchEvent({ type: 'pointerlockchange' });
  assert.equal(document.activeElement, canvas, 'browser F11 pointer release must preserve canvas keyboard focus');
  fireTimers(50);

  window.dispatchEvent({ type: 'blur' });
  documentFocused = false;
  document.activeElement = {};
  const focusBefore = canvasFocusCount;
  window.dispatchEvent({ type: 'focus' });
  assert.equal(canvasFocusCount, focusBefore, 'never steal focus from another window');
  documentFocused = true;
  document.activeElement = canvas;
  window.dispatchEvent({ type: 'blur' });
  document.activeElement = {};
  window.dispatchEvent({ type: 'focus' });
  assert.equal(document.activeElement, canvas, 'returning from browser chrome must restore prior game focus');

  window.dispatchEvent({ type: 'blur' });
  document.documentElement.dataset.doom3Exited = '1';
  document.activeElement = {};
  window.dispatchEvent({ type: 'focus' });
  assert.notEqual(document.activeElement, canvas, 'restart screen must retain its own button focus');

  delete document.documentElement.dataset.doom3Exited;
  document.documentElement.dataset.doom3DomPointerLockReady = '1';
  document.activeElement = canvas;
  const intent = enabled => document.dispatchEvent({ type: 'doom3-relative-mouse', detail: { enabled } });
  intent(false);
  canvas.dispatchEvent({ type: 'pointerdown', isTrusted: true });
  assert.equal(pointerRequests, 0, 'menus must never capture the pointer');
  intent(true);
  assert.equal(pointerRequests, 0, 'intent without user activation must not request capture');
  canvas.dispatchEvent(new Key('keydown', { key: 'Escape', code: 'Escape', isTrusted: true }));
  assert.equal(pointerRequests, 0, 'Escape release must not immediately recapture');
  canvas.dispatchEvent(new Key('keydown', { key: 'w', code: 'KeyW', isTrusted: true }));
  assert.equal(pointerRequests, 1, 'a real gameplay key must restore capture without an extra click');
  canvas.dispatchEvent({ type: 'pointerdown', isTrusted: true });
  assert.equal(pointerRequests, 1, 'overlapping gestures must not duplicate capture requests');
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  completePointerRequest();
  await new Promise(resolve => setImmediate(resolve));
  intent(false);
  document.dispatchEvent({ type: 'pointerlockchange' });
  userActivation.isActive = true;
  intent(true);
  assert.equal(pointerRequests, 2, 'Resume must reuse its active gesture after the worker responds');
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  completePointerRequest();
  await new Promise(resolve => setImmediate(resolve));
  intent(false);
  document.dispatchEvent({ type: 'pointerlockchange' });
  userActivation.isActive = false;
  intent(true);
  canvas.dispatchEvent({ type: 'pointerdown', isTrusted: false });
  assert.equal(pointerRequests, 2, 'synthetic input must never recapture');
  userActivation.isActive = true;
  intent(true);
  assert.equal(pointerRequests, 3);
  intent(false);
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  assert.equal(document.pointerLockElement, null, 'late pointer lock must not capture over an opened menu');
  completePointerRequest();
  await new Promise(resolve => setImmediate(resolve));
  document.dispatchEvent({ type: 'pointerlockchange' });

  // A request may outlive its timeout/menu intent. Its late rejection must not
  // clear the retry timer belonging to a newer request.
  document.pointerLockElement = null;
  document.activeElement = canvas;
  intent(true);
  assert.equal(pointerRequests, 4);
  const staleRequestIndex = pointerRequestPromises.length - 1;
  fireTimers(2000);
  intent(false);
  userActivation.isActive = true;
  intent(true);
  assert.equal(pointerRequests, 5);
  const newerRetryTimer = [...timers].find(([, timer]) => timer.delay === 2000)?.[0];
  assert.notEqual(newerRetryTimer, undefined, 'new request retains its own retry timeout');
  document.dispatchEvent({ type: 'pointerlockerror', name: 'WrongDocumentError' });
  assert(timers.has(newerRetryTimer), 'unversioned stale error event cannot clear the newer Promise request timeout');
  rejectPointerRequest(staleRequestIndex);
  await new Promise(resolve => setImmediate(resolve));
  assert(timers.has(newerRetryTimer), 'stale rejection cannot clear the newer retry timeout');
  document.pointerLockElement = canvas;
  document.dispatchEvent({ type: 'pointerlockchange' });
  completePointerRequest();
  await new Promise(resolve => setImmediate(resolve));
  intent(false);
  document.pointerLockElement = null;
  document.activeElement = canvas;
  document.fullscreenElement = document.documentElement;
  userActivation.isActive = false;
  const beforeFullscreenIntent = pointerRequests;
  intent(true);
  assert.equal(pointerRequests, beforeFullscreenIntent + 1, 'fullscreen worker intent attempts capture without requiring another click');
  completePointerRequest();
  await new Promise(resolve => setImmediate(resolve));
  context.cleanup();
  assert.equal(timers.size, 0);
  console.log('Browser controls: pending lock, lost key-up, blur cleanup and single Escape recovery checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
