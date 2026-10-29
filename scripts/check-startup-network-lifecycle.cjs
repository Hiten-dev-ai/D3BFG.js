const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync('web/src/main.ts', 'utf8');
function block(signature) {
  const start = source.indexOf(signature), opening = source.indexOf('{', start);
  assert(start >= 0 && opening >= start);
  let end = opening + 1, depth = 1;
  while (depth) { depth += (source[end] === '{') - (source[end] === '}'); end++; }
  return source.slice(start, end);
}
assert(!/await initializeOfflineShell\(/.test(source));
assert(!/await prepareOfflineEngine\(/.test(source));
assert(!/await cacheAllMapArchives\(/.test(source), 'bulk level caching cannot precede the menu');
const listeners = {}, requests = [];
let cacheCalls = 0;
const background = source.slice(source.indexOf('let allMapsCacheController'), source.indexOf('let pageTitle'));
const ctx = vm.createContext({
  browserPreferences: { cacheMode: 3 }, activeManifest: { files: [] }, navigator: { onLine: true }, AbortController,
  cacheAllMapArchives(options) {
    cacheCalls++; requests.push(options);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  },
  console, document: { addEventListener(name, handler) { listeners[name] = handler; } },
});
vm.runInContext(stripTypeScriptTypes(background), ctx);
ctx.cacheAllMapsInBackground(); ctx.cacheAllMapsInBackground();
assert.equal(cacheCalls, 1, 'do not launch duplicate bulk writers');
listeners['doom3-loading-state']({ detail: { loading: true } });
assert(requests[0].signal.aborted, 'level load must cancel the bulk writer and release its exclusive cache lock');
ctx.cacheAllMapsInBackground(); assert.equal(cacheCalls, 1, 'never restart bulk writes during gameplay');

(async () => {
  const sockets = [], notices = [];
  let stopped = 0, replaced = 0, offline = false;
  class Socket {
    static OPEN = 1; readyState = 1; events = {};
    constructor() { sockets.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    close() { this.readyState = 3; }
    emit(name, event) { this.events[name]?.(event); }
  }
  const lease = vm.createContext({
    URL, WebSocket: Socket, gameLease: null, gameLeaseClosing: false, offlineLease: false,
    navigator: { onLine: true }, location: { href: 'https://fixture.test/', protocol: 'https:' },
    window: { setTimeout, clearTimeout, location: { replace() { replaced++; } } }, console,
    isBootedOffline: () => offline, markBootedOffline: value => { offline = value; },
    setSaveSyncEnabled() {}, queueNativeNotice: text => notices.push(text), showGameExit() { stopped++; },
  });
  vm.runInContext(stripTypeScriptTypes(block('async function acquireGameLease(') + '\n' + block('function releaseGameLease(')), lease);
  let pending = lease.acquireGameLease();
  sockets[0].emit('message', { data: '{"type":"acquired"}' }); await pending;
  sockets[0].emit('close', { code: 1006 });
  assert.equal(stopped, 0, 'ordinary network loss must not kill the local engine');
  assert.equal(lease.offlineLease, true); assert.equal(notices.length, 1);
  offline = false;
  pending = lease.acquireGameLease(); sockets[1].emit('message', { data: '{"type":"acquired"}' }); await pending;
  sockets[1].emit('close', { code: 4001 });
  assert.equal(stopped, 1); assert.equal(replaced, 1, 'explicit account replacement must still stop the old instance');
  console.log('Actual startup/lease code: offline and bulk caching are nonblocking, level loads abort bulk writes, ordinary disconnect preserves play, account replacement still stops it.');
})().catch(error => { console.error(error); process.exitCode = 1; });
