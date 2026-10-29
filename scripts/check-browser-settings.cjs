// Regression checks for the real browser bridge, with a small simulated DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const handlers = new Map();
const local = new Map();
let enterCount = 0;
let exitCount = 0;
let finishEnter;
let microphoneRequests = 0;
let stoppedTracks = 0;
let permittedDevices = false;
let selectedSink = null;
const animationFrames = [];
const timeouts = [];
const documentEvents = [];
const setSaveSyncCalls = [];
const mediaDevices = {
  addEventListener() {},
  enumerateDevices: async () => permittedDevices
    ? [{ kind: 'audiooutput', deviceId: 'default', label: 'System default' },
      { kind: 'audiooutput', deviceId: 'headset', label: 'Headset' }]
    : [{ kind: 'audiooutput', deviceId: 'default', label: '' }],
  getUserMedia: async () => {
    ++microphoneRequests; permittedDevices = true;
    return { getTracks: () => [{ stop() { ++stoppedTracks; } }] };
  },
};
const canvas = {
  style: {}, focusCount: 0,
  focus() { ++this.focusCount; document.activeElement = this; },
  getBoundingClientRect: () => ({ width: 1000, height: 600 }),
};
const document = {
  fullscreenElement: null,
  activeElement: null,
  hasFocus: () => true,
  documentElement: { dataset: {}, requestFullscreen: () => {
    ++enterCount;
    return new Promise(resolve => { finishEnter = () => {
      document.fullscreenElement = document.documentElement;
      handlers.get('fullscreenchange')(); resolve();
    }; });
  } },
  exitFullscreen: async () => {
    ++exitCount; document.fullscreenElement = null; handlers.get('fullscreenchange')();
  },
  querySelector: () => canvas,
  getElementById: id => gateElements[id] ?? null,
  addEventListener: (name, handler) => handlers.set(name, handler),
  dispatchEvent: event => { documentEvents.push(event.type); return true; },
};
const gateElements = { 'fullscreen-gate': { hidden: true }, 'fullscreen-message': { textContent: '' }, 'fullscreen-windowed': { hidden: false, addEventListener() {} },
  'play-game': { hidden: true, focus() {} }, 'fullscreen-enter': { hidden: false, focus() {} } };
const storage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
const context = vm.createContext({
  window: {
    devicePixelRatio: 1, addEventListener() {},
    requestAnimationFrame(callback) { animationFrames.push(callback); },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; },
    setInterval() { return 1; },
  }, document,
  navigator: { storage: { estimate: async () => ({ usage: 1234 }) }, mediaDevices },
  screen: { width: 1920, height: 1200 }, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 600,
  localStorage: storage, sessionStorage: storage, SharedArrayBuffer, ArrayBuffer, Int32Array, Atomics,
  DOMException, Event: class { constructor(type) { this.type = type; } }, console, TextEncoder,
  nativeNoticeCount: () => 0, peekNativeNotice: () => '', isBootedOffline: () => false,
  clearAssetCache: async () => {}, setSaveSyncEnabled: (...args) => setSaveSyncCalls.push(args),
  getCurrentAccount: () => null, openProfile() {}, openDeleteAccount() {},
  MultiplayerClient: class { state = { lobby: null }; dispose() {} setPacketCounter() {} },
  createNativeMultiplayerBridge: () => ({ notify() {}, getNumber() { return 0; }, getText() { return ''; } }),
});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../web/src/browserMenuState.ts'), 'utf8').replace(/^export /gm, '')), context);
let source = fs.readFileSync(path.join(__dirname, '../web/src/browserPreferences.ts'), 'utf8');
source = source.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.env.DEV', 'true').replace(/^export /gm, '');
source = stripTypeScriptTypes(source, { mode: 'strip' });
vm.runInContext(source + '\nthis.testing = { bridge, browserPreferences, browserDisplayState, multiplayer };', context);
const { bridge, browserPreferences: preferences, browserDisplayState: state } = context.testing;

(async () => {
  assert.equal(bridge.getNumber('fullscreen'), 0);
  assert.equal(bridge.getText('resolutionName'), 'Windowed');
  assert.equal(Atomics.load(state, 1), 1000);
  assert.equal(Atomics.load(state, 2), 600);
  assert.equal(Atomics.load(state, 0) % 2, 0, 'published sizes must be coherent');
  let animationTime = 1;
  const runCadence = hz => {
    while (animationFrames.length) {
      animationTime += 1000 / hz;
      animationFrames.shift()(animationTime);
    }
  };
  runCadence(60);
  assert.equal(bridge.getNumber('frameRateCount'), 1);
  handlers.get('visibilitychange')();
  runCadence(144);
  assert.equal(bridge.getNumber('frameRateMax'), 144, 'campaign options must follow the current monitor cadence');
  bridge.setNumber('frameRateCap', 144);
  assert.equal(JSON.parse(local.get('doom3-browser-preferences-v1')).frameRateCap, 144, 'chosen cap must be durable before a native restart can reload the page');
  assert.equal(bridge.getNumber('startupFrameRateCap'), 144);
  context.testing.multiplayer.state.lobby = {};
  assert.equal(bridge.getNumber('frameRateMax'), 120, 'multiplayer must respect native BFG timing limits');
  context.testing.multiplayer.state.lobby = null;
  handlers.get('visibilitychange')();
  runCadence(60);
  assert.equal(bridge.getNumber('frameRateCount'), 1, 'moving back to a 60 Hz monitor must remove higher options');
  assert.equal(bridge.getNumber('startupFrameRateCap'), 60, 'startup caps must be bounded by the current display');
  assert.equal(preferences.frameRateCap, 144, 'a slower monitor must not erase the saved higher cap');

  preferences.resolutionIndex = 3;
  bridge.action('fullscreen');
  bridge.action('fullscreen');
  assert.equal(enterCount, 1, 'repeat requests during transition must be coalesced');
  assert.equal(bridge.getNumber('fullscreen'), 0, 'intent is not confirmed fullscreen');
  finishEnter(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.getNumber('fullscreen'), 1);
  assert.equal(bridge.getText('resolutionName'), 'Native 1920 x 1200');
  assert.equal(Atomics.load(state, 3), 1);
  assert.equal(Atomics.load(state, 1), 1920);
  assert.equal(Atomics.load(state, 2), 1200);
  assert.equal(preferences.resolutionIndex, 0, 'entering fullscreen selects native resolution');

  bridge.action('windowed'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(exitCount, 1);
  assert.equal(bridge.getNumber('fullscreen'), 0);
  assert.equal(bridge.getText('resolutionName'), 'Windowed');
  assert.equal(Atomics.load(state, 1), 1000, 'window dimensions must replace screen dimensions');
  assert.equal(Atomics.load(state, 2), 600);
  assert.equal(Atomics.load(state, 3), 0);
  assert.equal(Atomics.load(state, 0) % 2, 0);
  assert(documentEvents.includes('doom3-display-transition'), 'native display changes must announce their transition before unlocking');
  assert(canvas.focusCount > 0, 'leaving fullscreen must restore keyboard focus to the game canvas');
  assert.deepEqual(setSaveSyncCalls, [], 'fullscreen changes must not alter save-sync state');
  assert(Atomics.load(state, 4) > 0, 'settings changes must notify the native menu');
  context.innerWidth = 1920; context.innerHeight = 1200;
  assert.equal(bridge.getNumber('fullscreen'), 0, 'F11 must never be advertised to the engine as game fullscreen');
  assert.equal(bridge.getNumber('fullscreenKind'), 0);
  handlers.get('fullscreenchange')();
  assert.equal(gateElements['fullscreen-gate'].hidden, true, 'localhost testing does not enforce F11 fullscreen');
  const preferencesSource = fs.readFileSync(path.join(__dirname, '../web/src/browserPreferences.ts'), 'utf8');
  const gateSource = preferencesSource.slice(preferencesSource.indexOf('export function updateFullscreenGate()'), preferencesSource.indexOf('export async function holdAssetCacheLease'));
  vm.runInNewContext(stripTypeScriptTypes(gateSource.replace('export ', '')) + '\nupdateFullscreenGate();',
    { document, localBrowserTesting: false, browserF11Active: () => true });
  assert.equal(gateElements['fullscreen-gate'].hidden, false, 'production F11 requires game fullscreen');
  assert.match(gateElements['fullscreen-message'].textContent, /F11.*unsupported/);
  bridge.action('windowed');
  assert.equal(exitCount, 1, 'a page cannot programmatically exit browser F11');
  assert.match(bridge.getText('storageSummary'), /^\d+ MiB$/, 'fullscreen status must never replace the Cached data value');
  context.innerWidth = 1000; context.innerHeight = 600;
  handlers.get('fullscreenchange')();
  assert.equal(gateElements['fullscreen-gate'].hidden, true, 'outside F11 the warning is hidden before Play');
  const mainSource = fs.readFileSync(path.join(__dirname, '../web/src/main.ts'), 'utf8');
  const finish = mainSource.slice(mainSource.indexOf('const finishNativeStartup ='), mainSource.indexOf("playButton.addEventListener('click'"));
  let loaderHidden = false;
  Object.assign(context, { gamePresented: false, gameHasExited: false, nativeInputReady: false,
    playButton: gateElements['play-game'], loadingOverlay: { classList: { add(value) { loaderHidden = value === 'hidden'; } } },
    updateLoadingProgress() {},
  });
  vm.runInContext(stripTypeScriptTypes(finish) + '\nfinishNativeStartup();', context);
  assert.equal(loaderHidden, true, 'native readiness removes the login/loading surface');
  assert.equal(gateElements['fullscreen-gate'].hidden, false, 'Play appears over the canvas before presentation');
  assert.equal(gateElements['play-game'].hidden, false);
  assert.equal(gateElements['fullscreen-enter'].hidden, true, 'only the Play button is offered before entry');
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert(html.indexOf('id="play-game"') > html.indexOf('id="fullscreen-gate"'), 'Play belongs to the canvas gate, outside the login panel');
  const playCode = mainSource.slice(mainSource.indexOf('function presentGame()'), mainSource.indexOf("document.getElementById('fullscreen-enter')?.addEventListener"));
  let startPlay, requestedFullscreen = 0;
  const playContext = { document, gamePresented: false, nativeInputReady: false, disposeBrowserControls: undefined,
    localBrowserTesting: true, browserF11Active: () => false, console,
    enterGameFullscreen: async () => { ++requestedFullscreen; },
    playButton: { hidden: false, addEventListener: (type, callback) => { startPlay = callback; } },
    loadingOverlay: { classList: { add() {} } }, canvas: { focus() {} }, updateFullscreenGate() {},
    installBrowserControls: (target, options) => {
      assert.equal(options.requireFullscreen(), false, 'local testing remains windowed-capable after entry');
      return () => {};
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(playCode), playContext);
  await startPlay();
  assert.equal(requestedFullscreen, 1, 'opening Play requests game fullscreen even on localhost');
  assert.equal(playContext.gamePresented, true, 'presentation follows the fullscreen request');
  document.documentElement.dataset.doom3AwaitingPlay = '0';
  handlers.get('fullscreenchange')();
  assert.equal(bridge.getNumber('fullscreen'), 0);
  handlers.get('doom3-audio-context')({ detail: { context: {
    setSinkId: async id => { selectedSink = id; },
  } } });
  assert.equal(bridge.getNumber('audioOutputSupported'), 1);
  assert.equal(microphoneRequests, 0, 'boot must not request microphone permission');
  bridge.action('selectAudioOutput');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(microphoneRequests, 1);
  assert.equal(stoppedTracks, 1, 'microphone must be stopped before device selection');
  assert.equal(selectedSink, 'headset');
  assert.equal(bridge.getText('audioOutputName'), 'Headset');
  bridge.action('selectAudioOutput');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(microphoneRequests, 1, 'repeat selection must not prompt again');
  assert.equal(selectedSink, '');
  console.log('Browser settings: confirmed fullscreen, repeat coalescing, native resolution and window resize checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
