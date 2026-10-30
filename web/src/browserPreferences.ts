import { clearAssetCache } from './assetPolicy';
import { createFocusAudioPolicy } from './focusAudio';
import { setOfflinePlaybackAllowed } from './offlinePolicy';
import { MENU_STATE_WORDS, publishBrowserMenuState } from './browserMenuState';
import { MultiplayerClient } from './multiplayerClient';
import { createNativeMultiplayerBridge } from './nativeMultiplayer';
import { announceReconnected, dismissNativeNotice, nativeNoticeCount, nativeNoticeMainMenuOnly, peekNativeNotice, queueNativeNotice } from './nativeNotices';
import { setSaveSyncEnabled } from './saveSync';
import { getCurrentAccount, setCurrentAccount, logoutAccount, openProfile, openDeleteAccount } from './privateAccess';

export interface BrowserPreferences {
  cacheMode: number;
  persistSaves: number;
  browserSync: number;
  developerMenu: number;
  enableConsole: number;
  aspect: number;
  resolutionIndex: number;
  audioOutput: number;
  frameRateCap: number;
  skipIntro: number;
  pauseAudioUnfocused: number;
}

const preferenceKey = 'doom3-browser-preferences-v1';
const defaults: BrowserPreferences = {
  cacheMode: 1, persistSaves: 1, browserSync: 0, developerMenu: 0, enableConsole: 0,
  aspect: 0, resolutionIndex: 0, audioOutput: 0, frameRateCap: 60, skipIntro: 1, pauseAudioUnfocused: 1,
};
export const browserPreferences: BrowserPreferences = { ...defaults };
let multiplayerEnabled = true;
export async function applyServerBrowserDefaults(): Promise<void> {
  if (navigator.onLine === false) return;
  try {
    const response = await fetch('/__server_config', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const config = await response.json();
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}');
    for (const key of Object.keys(defaults) as (keyof BrowserPreferences)[]) {
      if (!Number.isSafeInteger(saved[key]) && Number.isSafeInteger(config.browserDefaults?.[key])) browserPreferences[key] = config.browserDefaults[key];
    }
    multiplayerEnabled = config.multiplayer !== false;
    setOfflinePlaybackAllowed(config.offlinePlaybackAllowed !== false);
    focusAudio.sync();
    notifySettingsChanged();
  } catch { /* Optional defaults must not prevent cached/offline play. */ }
}
export const localBrowserTesting = import.meta.env.DEV || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location?.hostname);
try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}');
  for (const key of Object.keys(defaults) as (keyof BrowserPreferences)[]) {
    if (Number.isSafeInteger(saved[key])) browserPreferences[key] = saved[key];
  }
} catch { /* Storage preferences are optional. */ }
browserPreferences.cacheMode = Math.max(0, Math.min(3, browserPreferences.cacheMode));
browserPreferences.aspect = Math.max(0, Math.min(4, browserPreferences.aspect));
for (const key of ['persistSaves', 'browserSync', 'developerMenu', 'enableConsole', 'skipIntro', 'pauseAudioUnfocused'] as const) {
  browserPreferences[key] = browserPreferences[key] ? 1 : 0;
}

try { localStorage.removeItem('doom3-last-session-v1'); } catch { /* Obsolete resume hint. */ }

const audioContexts = new Set<AudioContext & { setSinkId?: (id: string) => Promise<void> }>();
const focusAudio = createFocusAudioPolicy(() => browserPreferences.pauseAudioUnfocused === 1,
  () => !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus()));
let audioDevices: { deviceId: string; label: string }[] = [{ deviceId: 'default', label: 'System default' }];
let storageBytes = 0;
let statusMessage = '';
let accountBusy = false;
let accountStatus = '';

async function nativeAccountAction(command: string): Promise<void> {
  if (accountBusy) return;
  accountBusy = true;
  accountStatus = 'Please wait...';
  notifySettingsChanged();
  try {
    if (command === 'accountLogout') { await logoutAccount(); return; }
    const separator = command.indexOf('|');
    const operation = command.slice(0, separator);
    const values = JSON.parse(command.slice(separator + 1)) as string[];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('Invalid profile request.');
    const path = operation === 'accountPassword' ? '/__session/password' : '/__session/profile';
    const deleting = operation === 'accountDelete';
    let body: object;
    if (operation === 'accountSave') body = { name: values[0], email: values[1] };
    else if (operation === 'accountPassword') {
      if (values[1] !== values[2]) throw new Error('New passwords do not match.');
      body = { currentPassword: values[0], newPassword: values[1] };
    } else if (deleting) body = { password: values[0], confirm: 'DELETE' };
    else throw new Error('Unknown profile request.');
    const response = await fetch(path, { method: deleting ? 'DELETE' : operation === 'accountSave' ? 'PATCH' : 'POST',
      credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Profile request failed.');
    if (deleting) {
      (window as Window & { doom3AfterAccountDelete?: () => void }).doom3AfterAccountDelete?.();
      setCurrentAccount(null);
      window.location.replace('/');
      return;
    }
    if (result.user) setCurrentAccount(result.user);
    accountStatus = operation === 'accountPassword' ? 'Password changed.' : 'Profile saved.';
  } catch (error) { accountStatus = error instanceof Error ? error.message : 'Profile request failed.'; }
  finally { accountBusy = false; notifySettingsChanged(); }
}
let refreshStoragePending = false;
let assetLeaseRelease: (() => void) | null = null;
let fullscreenRequestPending = false;
let monitorRefreshRate = 60;
let refreshProbePending = false;
let refreshProbeFinished = false;
const refreshWaiters = new Set<() => void>();
let audioSelectionPending = false;
let audioPermissionAttempted = false;
let selectedAudioDeviceId = '';
try { selectedAudioDeviceId = localStorage.getItem('doom3-audio-output-v1') ?? ''; } catch { /* Optional preference. */ }

// Shared with the engine pthread. Atomic publication keeps a resize coherent
// without recreating WebGL or assigning a transferred canvas on the DOM thread.
export const browserDisplayState = new Int32Array(typeof SharedArrayBuffer !== 'undefined'
  ? new SharedArrayBuffer(MENU_STATE_WORDS * Int32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(MENU_STATE_WORDS * Int32Array.BYTES_PER_ELEMENT));

let menuBridgeReady = false;
function notifySettingsChanged(): void {
  Atomics.add(browserDisplayState, 4, 1);
  if (menuBridgeReady) publishBrowserMenuState(browserDisplayState, bridge);
}

function probeDisplayRefresh(): void {
  if (refreshProbePending || typeof window.requestAnimationFrame !== 'function' || document.hidden) return;
  refreshProbePending = true;
  const intervals: number[] = [];
  let previous = 0;
  let frames = 0;
  const sample = (time: number): void => {
    if (document.hidden) { refreshProbePending = false; return; }
    const elapsed = time - previous;
    if (previous && elapsed > 0 && elapsed < 100) intervals.push(elapsed);
    previous = time;
    if (++frames < 90) { window.requestAnimationFrame(sample); return; }
    refreshProbePending = false;
    refreshProbeFinished = true;
    intervals.sort((a, b) => a - b);
    if (intervals.length >= 60) {
      const median = intervals[Math.floor(intervals.length / 2)];
      const measured = 1000 / median;
      const rates = [60, 75, 90, 100, 120, 144, 165, 180, 200, 240, 360];
      const nearest = rates.reduce((a, b) => Math.abs(a - measured) < Math.abs(b - measured) ? a : b);
      const stable = intervals[Math.floor(intervals.length * 0.9)] < median * 1.15;
      if (stable && Math.abs(nearest - measured) / nearest < 0.04 && nearest !== monitorRefreshRate) {
        monitorRefreshRate = nearest;
        notifySettingsChanged();
      }
    }
    for (const resolve of refreshWaiters) resolve();
    refreshWaiters.clear();
  };
  window.requestAnimationFrame(sample);
}

export async function waitForDisplayCadence(): Promise<void> {
  if (refreshProbeFinished || document.hidden) return;
  probeDisplayRefresh();
  await new Promise<void>(resolve => {
    const finish = () => { window.clearTimeout(timer); refreshWaiters.delete(finish); resolve(); };
    const timer = window.setTimeout(finish, 2000);
    refreshWaiters.add(finish);
  });
}

// Construction is offline. A multiplayer screen must explicitly connect; boot,
// campaign and classic games never open a game-network connection.
const multiplayer = new MultiplayerClient(state => {
  Atomics.store(browserDisplayState, 5, 0);
  Atomics.store(browserDisplayState, 6, state.peerId ?? 0);
  Atomics.store(browserDisplayState, 7, state.lobby?.hostPeerId ?? 0);
  if (state.status === 'connected' && state.lobby) Atomics.store(browserDisplayState, 5, 1);
  nativeMultiplayer.notify();
  notifySettingsChanged();
});
(window as unknown as { doom3Multiplayer: MultiplayerClient }).doom3Multiplayer = multiplayer;
multiplayer.setPacketCounter(browserDisplayState);
const nativeMultiplayer = createNativeMultiplayerBridge(multiplayer, notifySettingsChanged);

function frameRates(): number[] {
  // Competitive BFG locks simulation to 60/120; the campaign scheduler also
  // supports the measured screen cadence. Keep defaults and gameplay rules.
  const values = [60];
  if (monitorRefreshRate >= 120) values.push(120);
  if (!multiplayer.state.lobby && monitorRefreshRate > 60 && !values.includes(monitorRefreshRate)) values.push(monitorRefreshRate);
  return values.sort((a, b) => a - b);
}

function systemSize(): [number, number] {
  const ratio = window.devicePixelRatio || 1;
  return [Math.max(1, Math.round(screen.width * ratio)), Math.max(1, Math.round(screen.height * ratio))];
}
function fullscreenKind(): number {
  return document.fullscreenElement ? 1 : 0;
}
export function browserF11Active(): boolean {
  if (document.fullscreenElement) return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: fullscreen)').matches) return true;
  const browserFullscreen = (window as Window & { fullScreen?: boolean }).fullScreen;
  if (typeof browserFullscreen === 'boolean') return browserFullscreen;
  // Chromium doesn't expose its F11 state. A browser viewport occupying the
  // whole physical screen is the observable signal; maximized windows still
  // reserve browser chrome and therefore have a smaller innerHeight.
  return screen.width > 0 && screen.height > 0 &&
    Math.abs(innerWidth - screen.width) <= 2 && Math.abs(innerHeight - screen.height) <= 2;
}
function chosenAspect(): number {
  const [w, h] = systemSize();
  return [w / h, 4 / 3, 16 / 10, 16 / 9, 21 / 9][browserPreferences.aspect] ?? w / h;
}
function resolutionModes(): [number, number][] {
  const [sw, sh] = systemSize();
  const aspect = chosenAspect();
  const fitW = Math.min(sw, Math.round(sh * aspect));
  const fitH = Math.round(fitW / aspect);
  const modes: [number, number][] = [[fitW, fitH]];
  for (const height of [480, 600, 720, 768, 800, 900, 1080, 1200, 1440, 1600, 1800, 2160]) {
    const width = Math.round(height * aspect / 2) * 2;
    if (width <= fitW && height <= fitH && (width !== fitW || height !== fitH)) modes.push([width, height]);
  }
  return modes;
}

export function publishDisplaySize(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  if (!canvas) return;
  let width: number, height: number;
  const fullscreen = fullscreenKind() !== 0;
  document.documentElement.dataset.doom3Fullscreen = fullscreen ? '1' : '0';
  if (fullscreen) {
    const aspect = chosenAspect();
    const cssWidth = Math.min(innerWidth, innerHeight * aspect);
    const cssHeight = Math.min(innerHeight, innerWidth / aspect);
    Object.assign(canvas.style, {
      width: `${cssWidth}px`, height: `${cssHeight}px`, left: `${(innerWidth - cssWidth) / 2}px`,
      top: `${(innerHeight - cssHeight) / 2}px`, right: 'auto', bottom: 'auto',
    });
    const modes = resolutionModes();
    const index = Math.max(0, Math.min(modes.length - 1, browserPreferences.resolutionIndex));
    if (index !== browserPreferences.resolutionIndex) {
      browserPreferences.resolutionIndex = index;
      persistPreferences();
    }
    [width, height] = modes[index];
  } else {
    Object.assign(canvas.style, { width: '100vw', height: '100vh', left: '0', top: '0', right: 'auto', bottom: 'auto' });
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width * (devicePixelRatio || 1)));
    height = Math.max(1, Math.round(rect.height * (devicePixelRatio || 1)));
  }
  // Odd sequences are in-progress; the engine accepts only a stable even snapshot.
  Atomics.add(browserDisplayState, 0, 1);
  Atomics.store(browserDisplayState, 1, width);
  Atomics.store(browserDisplayState, 2, height);
  Atomics.store(browserDisplayState, 3, fullscreen ? 1 : 0);
  Atomics.add(browserDisplayState, 0, 1);
}

let nextStorageProbe = 0;
async function refreshStorage(): Promise<void> {
  if (refreshStoragePending || Date.now() < nextStorageProbe) return;
  nextStorageProbe = Date.now() + 5000;
  refreshStoragePending = true;
  try {
    const next = (await navigator.storage.estimate()).usage ?? 0;
    if (next !== storageBytes) { storageBytes = next; notifySettingsChanged(); }
  }
  catch { /* Keep the previous measurement. */ }
  finally { refreshStoragePending = false; }
}

async function refreshAudioDevices(): Promise<void> {
  const selectedId = selectedAudioDeviceId || audioDevices[browserPreferences.audioOutput]?.deviceId;
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    audioDevices = [{ deviceId: 'default', label: 'System default' }];
    for (const device of devices ?? []) {
      if (device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default') {
        audioDevices.push({ deviceId: device.deviceId, label: device.label || `Audio output ${audioDevices.length}` });
      }
    }
    browserPreferences.audioOutput = Math.max(0, audioDevices.findIndex(device => device.deviceId === selectedId));
    notifySettingsChanged();
  } catch { /* Default output remains available without microphone permission. */ }
}

function persistPreferences(): void {
  try { localStorage.setItem(preferenceKey, JSON.stringify(browserPreferences)); }
  catch { statusMessage = 'Browser settings could not be saved.'; }
  notifySettingsChanged();
}

async function selectAudioOutput(index: number): Promise<void> {
  const output = audioDevices[index];
  if (!output || !audioContexts.size) return;
  const contexts = [...audioContexts];
  if (contexts.some((context) => typeof context.setSinkId !== 'function')) return;
  try {
    await Promise.all(contexts.map((context) => context.setSinkId!(output.deviceId === 'default' ? '' : output.deviceId)));
    browserPreferences.audioOutput = index;
    selectedAudioDeviceId = output.deviceId === 'default' ? '' : output.deviceId;
    try { localStorage.setItem('doom3-audio-output-v1', selectedAudioDeviceId); } catch { /* Optional preference. */ }
    persistPreferences();
  } catch (error) { statusMessage = `Audio output could not be selected: ${String(error)}`; notifySettingsChanged(); }
}

type OutputMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

async function chooseAudioOutput(): Promise<void> {
  const media = navigator.mediaDevices as OutputMediaDevices | undefined;
  if (!media || audioSelectionPending) return;
  audioSelectionPending = true;
  try {
    await refreshAudioDevices();
    if (audioDevices.length > 1) {
      await selectAudioOutput((browserPreferences.audioOutput + 1) % audioDevices.length);
      return;
    }
    if (media.selectAudioOutput) {
      // Browser-owned chooser grants speaker access without requesting a microphone.
      const device = await media.selectAudioOutput();
      await refreshAudioDevices();
      let index = audioDevices.findIndex(output => output.deviceId === device.deviceId);
      if (index < 0) { index = audioDevices.length; audioDevices.push(device); }
      await selectAudioOutput(index);
    } else {
      await refreshAudioDevices();
      if (audioDevices.length <= 1 && media.getUserMedia && !audioPermissionAttempted) {
        audioPermissionAttempted = true;
        // Chromium gates device enumeration on microphone permission. Open no
        // recorder or media connection, and stop every track before enumerating.
        const stream = await media.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        await refreshAudioDevices();
      }
      if (audioDevices.length > 1) await selectAudioOutput((browserPreferences.audioOutput + 1) % audioDevices.length);
    }
  } catch (error) {
    statusMessage = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Audio device permission was declined. System output is active.'
      : `Audio output could not be selected: ${String(error)}`;
    notifySettingsChanged();
  } finally { audioSelectionPending = false; }
}

async function setFullscreen(enabled: boolean, offerGesture = true): Promise<void> {
  const kind = fullscreenKind();
  if (fullscreenRequestPending || Boolean(kind) === enabled) return;
  fullscreenRequestPending = true;
  document.documentElement.dataset.doom3DisplayTransition = '1';
  document.dispatchEvent(new Event('doom3-display-transition'));
  try {
    if (enabled) {
      browserPreferences.resolutionIndex = 0;
      await document.documentElement.requestFullscreen();
    } else await document.exitFullscreen();
  } catch (error) {
    statusMessage = `Full screen requires a click: ${String(error)}`;
    if (enabled && offerGesture) {
      const gate = document.getElementById('fullscreen-gate');
      if (gate) gate.hidden = false;
      document.getElementById('fullscreen-enter')?.focus();
    }
  } finally {
    fullscreenRequestPending = false;
    publishDisplaySize();
    notifySettingsChanged();
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    if (document.documentElement.dataset.doom3Exited !== '1') canvas?.focus({ preventScroll: true });
    window.setTimeout(() => {
      delete document.documentElement.dataset.doom3DisplayTransition;
      if (document.hasFocus() && document.documentElement.dataset.doom3Exited !== '1') canvas?.focus({ preventScroll: true });
    }, 350);
  }
}

export function requestStartupFullscreen(): void { void setFullscreen(true, false); }
export async function enterGameFullscreen(): Promise<void> {
  await setFullscreen(true, false);
  if (!document.fullscreenElement) throw new Error('Use Enter full screen to allow the game to enter fullscreen.');
}
export function updateFullscreenGate(): void {
  const gate = document.getElementById('fullscreen-gate');
  if (!gate || document.documentElement.dataset.doom3Exited === '1') return;
  const f11 = !localBrowserTesting && browserF11Active();
  const awaitingPlay = document.documentElement.dataset.doom3AwaitingPlay === '1';
  const wasHidden = gate.hidden;
  gate.hidden = !awaitingPlay && !f11;
  const play = document.getElementById('play-game');
  const enter = document.getElementById('fullscreen-enter');
  if (play) play.hidden = !awaitingPlay;
  if (enter) enter.hidden = awaitingPlay;
  if (!gate.hidden && wasHidden) {
    if (document.pointerLockElement) document.exitPointerLock();
    (awaitingPlay ? play : enter)?.focus({ preventScroll: true });
  }
  const message = document.getElementById('fullscreen-message');
  if (message) message.textContent = f11
    ? 'F11 browser fullscreen is unsupported. Enter game fullscreen for reliable mouse and Escape controls.'
    : 'Ready to play.';
  const windowed = document.getElementById('fullscreen-windowed');
  if (windowed) windowed.hidden = !awaitingPlay || f11;
}

export async function holdAssetCacheLease(): Promise<void> {
  if (!navigator.locks || assetLeaseRelease) return;
  let granted: () => void = () => {};
  const ready = new Promise<void>((resolve) => { granted = resolve; });
  void navigator.locks.request('doom3-bfg-active-assets-v1', { mode: 'shared' }, async () => {
    await new Promise<void>((resolve) => { assetLeaseRelease = resolve; granted(); });
  });
  await ready;
}

export async function applyPendingAssetClear(): Promise<void> {
  if (localStorage.getItem('doom3-clear-all') === '1') {
    if (!navigator.locks) throw new Error('Close all other game tabs before clearing local data.');
    await navigator.locks.request('doom3-bfg-active-assets-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Close the other game tabs, then reload to clear all local game data.');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('/doom3_save_data');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Another game tab is using your profile. Close it and reload.'));
      });
      const root = await navigator.storage.getDirectory();
      for (const name of ['permanent', 'map-cache', 'sessions']) {
        try { await root.removeEntry(name, { recursive: true }); }
        catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      }
      const response = await fetch('/__session/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok && !import.meta.env.DEV) throw new Error('Could not revoke device trust. Reload to retry clearing data.');
      for (const key of Object.keys(localStorage)) if (key.startsWith('doom3-')) localStorage.removeItem(key);
      sessionStorage.clear();
      window.location.replace('/');
    });
    throw new Error('Restarting after clearing local game data…');
  }
  if (localStorage.getItem('doom3-clear-assets') !== '1') return;
  if (!navigator.locks) throw new Error('Close other game tabs before clearing the asset cache in this browser.');
  await navigator.locks.request('doom3-bfg-active-assets-v1', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Close the other game tabs, then reload to clear cached game assets.');
    await clearAssetCache();
    localStorage.removeItem('doom3-clear-assets');
  });
}

const bridge = {
  getNumber(key: string): number {
    if (key === 'nativeNoticeMainMenuOnly') return nativeNoticeMainMenuOnly();
    if (key === 'accountBusy') return accountBusy ? 1 : 0;
    if (key === 'nativeNoticeCount') return nativeNoticeCount();
    if (key === 'offline') return navigator.onLine === false ? 1 : 0;
    if (key.startsWith('mp')) return nativeMultiplayer.getNumber(key);
    if (key === 'fullscreen') return fullscreenKind() ? 1 : 0;
    if (key === 'fullscreenKind') return fullscreenKind();
    if (key === 'resolutionCount') return resolutionModes().length;
    if (key === 'frameRateCount') return frameRates().length;
    if (key === 'frameRateMax') return frameRates().at(-1) ?? 60;
    if (key === 'startupFrameRateCap') {
      const cap = browserPreferences.frameRateCap;
      return frameRates().filter(rate => rate <= cap).at(-1) ?? 60;
    }
    if (/^frameRateValue\d$/.test(key)) return frameRates()[Number(key.slice(-1))] ?? 60;
    if (key === 'audioOutputCount') return audioDevices.length;
    if (key === 'audioOutputSupported') return audioContexts.size &&
      [...audioContexts].every(c => typeof c.setSinkId === 'function') &&
      ((navigator.mediaDevices as OutputMediaDevices | undefined)?.selectAudioOutput ||
        typeof navigator.mediaDevices?.getUserMedia === 'function' || audioDevices.length > 1) ? 1 : 0;
    if (key === 'audioSplitSupported') return 1;
    if (key === 'storageBytes') { void refreshStorage(); return storageBytes; }
    return Number(browserPreferences[key as keyof BrowserPreferences] ?? 0);
  },
  publishSnapshot(): void { publishBrowserMenuState(browserDisplayState, bridge); },
  getText(key: string): string {
    if (key === 'nativeNoticeText') return peekNativeNotice();
    if (key === 'connectionStatus') return navigator.onLine === false ? 'Offline' : '';
    if (key.startsWith('mp')) return nativeMultiplayer.getText(key);
    if (key === 'statusMessage') return statusMessage;
    if (key === 'profileName') return getCurrentAccount()?.name || localStorage.getItem('doom3-profile-name-v1') || 'Marine';
    if (key === 'profileEmail') return getCurrentAccount()?.email || '';
    if (key === 'accountStatus') return accountStatus;
    if (key === 'rendererName') return 'WebGL 2';
    if (key === 'audioOutputName') return audioDevices[browserPreferences.audioOutput]?.label ?? 'System default';
    if (key === 'resolutionName') {
      if (!fullscreenKind()) return 'Windowed';
      const modes = resolutionModes();
      const index = Math.max(0, Math.min(modes.length - 1, browserPreferences.resolutionIndex));
      return `${index === 0 ? 'Native ' : ''}${modes[index][0]} x ${modes[index][1]}`;
    }
    if (key === 'aspectName') return ['System', '4:3', '16:10', '16:9', '21:9'][browserPreferences.aspect];
    if (key === 'storageSummary') {
      void refreshStorage();
      return `${(storageBytes / 1048576).toFixed(0)} MiB`;
    }
    return '';
  },
  setNumber(key: string, value: number): void {
    if (!Number.isSafeInteger(value)) return;
    const ranges: Record<string, [number, number]> = {
      cacheMode: [0, 3], persistSaves: [0, 1], developerMenu: [0, 1], enableConsole: [0, 1], skipIntro: [0, 1], pauseAudioUnfocused: [0, 1],
      aspect: [0, 4], resolutionIndex: [0, resolutionModes().length - 1],
      frameRateCap: [60, 360],
    };
    if (key === 'audioOutput') { void selectAudioOutput(value); return; }
    if (key === 'fullscreen') { bridge.action(value ? 'fullscreen' : 'windowed'); return; }
    const range = ranges[key];
    if (!range) return;
    if (key === 'frameRateCap' && !frameRates().includes(value)) return;
    browserPreferences[key as keyof BrowserPreferences] = Math.max(range[0], Math.min(range[1], value));
    if (key === 'pauseAudioUnfocused') focusAudio.sync();
    if (key === 'browserSync') {
      if (value) browserPreferences.persistSaves = 1;
      // Restoration happens before the engine mounts IDBFS, never over its live FS.
      setSaveSyncEnabled(false);
      statusMessage = value ? 'Restart to enable save sync.' : 'Save sync disabled.';
    }
    if (key === 'persistSaves' && !value && !getCurrentAccount()) {
      browserPreferences.browserSync = 0;
      setSaveSyncEnabled(false);
    }
    if (key === 'aspect') browserPreferences.resolutionIndex = 0;
    persistPreferences();
    if (key === 'aspect' || key === 'resolutionIndex') publishDisplaySize();
  },
  action(name: string): void {
    if (name === 'accountReset') { if (!accountBusy) accountStatus = ''; return; }
    if (name.startsWith('account')) { void nativeAccountAction(name); return; }
    if (name === 'nativeNoticeDismiss') { dismissNativeNotice(); return; }
    if (name.startsWith('mp')) {
      if (!multiplayerEnabled && !['mpDisconnect', 'mpLeave', 'mpCancelPending', 'mpClearError'].includes(name)) {
        queueNativeNotice('Multiplayer is disabled by this server.'); return;
      }
      nativeMultiplayer.action(name); return;
    }
    if (name === 'manageProfile') openProfile();
    else if (name === 'deleteAccount') openDeleteAccount();
    else if (name === 'restart') window.location.reload();
    else if (name === 'clearData') {
      setSaveSyncEnabled(false);
      localStorage.setItem('doom3-clear-all', '1');
      window.location.replace('/');
    } else if (name.startsWith('setProfileName|')) {
      const value = name.slice('setProfileName|'.length).trim();
      if (value.length > 0 && value.length <= 32 && !/[\x00-\x1f\x7f|]/.test(value)) {
        localStorage.setItem('doom3-profile-name-v1', value);
        notifySettingsChanged();
      }
    }
    else if (name === 'clearAssetCache') {
      localStorage.setItem('doom3-clear-assets', '1');
      window.location.reload();
    } else if (name === 'windowed') void setFullscreen(false);
    else if (name === 'fullscreen') void setFullscreen(true);
    else if (name === 'selectAudioOutput') void chooseAudioOutput();
    else if (name === 'previousAudioOutput') {
      if (audioDevices.length > 1) void selectAudioOutput((browserPreferences.audioOutput - 1 + audioDevices.length) % audioDevices.length);
      else void chooseAudioOutput();
    }
  },
};

(window as unknown as { doom3BrowserBridge: typeof bridge }).doom3BrowserBridge = bridge;
menuBridgeReady = true;
publishBrowserMenuState(browserDisplayState, bridge);
window.setInterval(() => publishBrowserMenuState(browserDisplayState, bridge), 250);
// Connectivity changes must reach the native menus: they show an Offline
// indicator and the "Connected to internet" confirmation after an offline boot.
window.addEventListener('online', () => {
  announceReconnected(true);
  nativeMultiplayer.notify();
  notifySettingsChanged();
});
window.addEventListener('offline', () => {
  nativeMultiplayer.notify();
  notifySettingsChanged();
});
document.addEventListener('doom3-audio-context', (event) => {
  const context = (event as CustomEvent<{ context: AudioContext }>).detail?.context;
  if (context) {
    audioContexts.add(context);
    focusAudio.register(context);
    if (selectedAudioDeviceId) {
      void refreshAudioDevices().then(() => {
        const index = audioDevices.findIndex(device => device.deviceId === selectedAudioDeviceId);
        if (index >= 0) void selectAudioOutput(index);
      });
    }
    notifySettingsChanged();
  }
});
document.addEventListener('doom3-sync-status', event => {
  statusMessage = (event as CustomEvent<string>).detail;
  notifySettingsChanged();
});
document.addEventListener('doom3-profile-name', event => {
  const name = (event as CustomEvent<string>).detail?.trim();
  if (name && name.length <= 32 && !/[\x00-\x1f\x7f|]/.test(name)) localStorage.setItem('doom3-profile-name-v1', name);
  notifySettingsChanged();
});
document.addEventListener('doom3-single-player', () => multiplayer.disconnect());
document.addEventListener('doom3-engine-stopped', () => multiplayer.disconnect());
window.addEventListener('resize', () => { publishDisplaySize(); notifySettingsChanged(); probeDisplayRefresh(); });
window.addEventListener('focus', publishDisplaySize);
window.addEventListener('focus', () => focusAudio.sync());
window.addEventListener('blur', () => focusAudio.sync());
window.addEventListener('pointerdown', () => focusAudio.sync());
window.addEventListener('keydown', (event) => {
  if (event.key === 'F11') {
    document.documentElement.dataset.doom3DisplayTransition = '1';
    document.dispatchEvent(new Event('doom3-display-transition'));
    // Observe after the browser applies its default action. Never swallow F11.
    window.setTimeout(publishDisplaySize, 100);
    window.setTimeout(publishDisplaySize, 500);
    window.setTimeout(() => { delete document.documentElement.dataset.doom3DisplayTransition; }, 1200);
  }
});
document.addEventListener('fullscreenchange', () => { publishDisplaySize(); notifySettingsChanged(); probeDisplayRefresh(); updateFullscreenGate(); });
window.addEventListener('resize', updateFullscreenGate);
document.addEventListener('doom3-account-changed', notifySettingsChanged);
document.addEventListener('visibilitychange', () => { focusAudio.sync(); if (!document.hidden) probeDisplayRefresh(); });
navigator.mediaDevices?.addEventListener('devicechange', () => { void refreshAudioDevices(); });
let monitorProbeTimer: number | undefined;
let lastScreen = `${screen.width}:${screen.height}:${devicePixelRatio}`;
if (typeof window.setInterval === 'function') {
  monitorProbeTimer = window.setInterval(() => {
    if (document.hidden) return;
    const currentScreen = `${screen.width}:${screen.height}:${devicePixelRatio}`;
    if (currentScreen !== lastScreen) { lastScreen = currentScreen; publishDisplaySize(); }
    // Moving between monitors with identical dimensions can still change Hz.
    probeDisplayRefresh();
  }, 10000);
}
window.addEventListener('pagehide', () => {
  assetLeaseRelease?.(); assetLeaseRelease = null;
  multiplayer.dispose();
  if (monitorProbeTimer !== undefined) window.clearInterval(monitorProbeTimer);
});
void refreshAudioDevices();
void refreshStorage();
publishDisplaySize();
probeDisplayRefresh();
