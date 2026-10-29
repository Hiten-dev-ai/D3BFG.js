import './style.css';
import { initializeOfflineShell, prepareOfflineEngine } from './offlineShell';
import { installBrowserControls } from './browserControls';
import { browserPreferences, browserDisplayState, publishDisplaySize, enterGameFullscreen, updateFullscreenGate, browserF11Active, localBrowserTesting, waitForDisplayCadence, applyPendingAssetClear, holdAssetCacheLease, applyServerBrowserDefaults } from './browserPreferences';
import { requirePrivateAccess, getCurrentAccount } from './privateAccess';
import { prepareSaveSync, setSaveSyncEnabled, accountSavePath, flushSaveSync, applyPendingAccountRemoval } from './saveSync';
import { cacheAllMapArchives } from './assetPolicy';
import { markBootedOffline, isBootedOffline, queueNativeNotice } from './nativeNotices';
import {
  type ScannedFile,
  validateGameData,
} from './gameDataValidator';
import {
  getOpfsRoot,
  getOpfsSubdir,
  readStoredMeta,
  writeStoredMeta,
  verifyOpfsFileExistsAndSize,
  streamFileToOpfs,
  deleteOpfsFile,
  collectOpfsFiles,
  OPFS_PERM_DIR,
  type StoredMetaMap,
} from './opfsCache';

interface ManifestEntry {
  path: string;
  size: number;
  etag: string;
}

interface ManifestResponse {
  gameDir: string;
  manifestEtag: string;
  files: ManifestEntry[];
}

// UI Elements
const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
const loadingProgressBar = document.getElementById('loading-progress-bar') as HTMLDivElement;
const loadingStatus = document.getElementById('loading-status') as HTMLParagraphElement;
const loadingDetail = document.getElementById('loading-detail') as HTMLParagraphElement;
const loadingError = document.getElementById('loading-error') as HTMLDivElement;
const playAgainButton = document.getElementById('play-again') as HTMLButtonElement;

const canvas = document.querySelector<HTMLCanvasElement>('#canvas') as HTMLCanvasElement;
// Negotiate capture ownership with the engine; older builds keep SDL's path.
document.documentElement.dataset.doom3DomPointerLockRequested = '1';
const isDevelopmentBuild = import.meta.env.DEV;
let activeManifest: ManifestResponse | null = null;
let allMapsCacheController: AbortController | null = null;
let allMapsCacheComplete = false;
let levelLoadingOrPlaying = false;

function cacheAllMapsInBackground(): void {
  if (browserPreferences.cacheMode !== 3 || !activeManifest || navigator.onLine === false ||
      allMapsCacheController || allMapsCacheComplete || levelLoadingOrPlaying) return;
  const controller = new AbortController();
  allMapsCacheController = controller;
  void cacheAllMapArchives({ manifest: activeManifest, fileUrl: '/__local_game/file', signal: controller.signal })
    .then(() => { allMapsCacheComplete = true; })
    .catch(error => {
      if (!controller.signal.aborted) console.warn('[DOOM 3 cache] Background map caching paused:', error);
    })
    .finally(() => { if (allMapsCacheController === controller) allMapsCacheController = null; });
}
document.addEventListener('doom3-loading-state', event => {
  if ((event as CustomEvent<{ loading?: boolean }>).detail?.loading) {
    levelLoadingOrPlaying = true;
    // Release the cache lock before the requested level tries to acquire it.
    allMapsCacheController?.abort();
  }
});
document.addEventListener('doom3-menu-ready', () => {
  levelLoadingOrPlaying = false;
  cacheAllMapsInBackground();
});
let pageTitle = 'D3BFG.js';
document.addEventListener('doom3-account-changed', () => {
  const account = getCurrentAccount();
  pageTitle = account ? `${account.name} · D3BFG.js` : 'D3BFG.js';
  document.title = pageTitle;
});
// SDL updates its window caption when switching classic games. Keep the browser
// tab's product name stable while leaving the native game's captions intact.
const titleElement = document.querySelector('title');
if (titleElement) {
  new MutationObserver(() => {
    if (document.title !== pageTitle) document.title = pageTitle;
  }).observe(titleElement, { childList: true, subtree: true, characterData: true });
}
let workerHasReadySignal = false;
let gameHasExited = false;
let disposeBrowserControls: (() => void) | undefined;
let nativeInputReady = false;
let gamePresented = false;
const playButton = document.querySelector<HTMLButtonElement>('#play-game')!;
let gameLease: WebSocket | null = null;
let gameLeaseClosing = false;
// An offline boot has no reservation server to talk to; single-player still runs
// from local data and the lease is taken the next time the network is up.
let offlineLease = false;
const hasGameLease = (): boolean => offlineLease || gameLease?.readyState === WebSocket.OPEN;
async function acquireGameLease(): Promise<void> {
  releaseGameLease();
  gameLeaseClosing = false;
  if (navigator.onLine === false || isBootedOffline()) {
    offlineLease = true;
    console.info('[DOOM 3 BFG Web] Offline: skipping the account reservation for this session.');
    return;
  }
  offlineLease = false;
  const url = new URL('/__session/game-instance', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  gameLease = socket;
  await new Promise<void>((resolve, reject) => {
    let acquired = false;
    const timer = window.setTimeout(() => { socket.close(); reject(new Error('Could not reserve this account. Reload to try again.')); }, 15000);
    socket.addEventListener('message', event => {
      let type = '';
      try { type = JSON.parse(String(event.data)).type; } catch { return; }
      if (type === 'occupied') { window.clearTimeout(timer); socket.close(); reject(new Error('This account is already playing in another browser or tab.')); }
      else if (type === 'acquired' && !acquired) { acquired = true; window.clearTimeout(timer); resolve(); }
    });
    socket.addEventListener('close', event => {
      window.clearTimeout(timer);
      if (gameLease !== socket) return;
      if (!acquired) { reject(new Error('Could not reserve this account. Reload to try again.')); return; }
      if (!gameLeaseClosing) {
        const replaced = event.code === 4001;
        if (replaced) {
          showGameExit(true);
          // Destroy the transferred canvas and every engine worker before the
          // previous device can resume. Revoked credentials already reject any
          // in-flight uploads; local/remote save files are not deleted.
          setSaveSyncEnabled(false);
          window.location.replace('/');
          return;
        }
        offlineLease = true;
        gameLease = null;
        markBootedOffline(true);
        setSaveSyncEnabled(false);
        queueNativeNotice('Connection lost. Cached single-player play and local saves remain available.');
      }
    });
    socket.addEventListener('error', () => { if (!acquired) reject(new Error('Could not connect to the game server.')); });
  });
}
function releaseGameLease(): void { offlineLease = false; gameLeaseClosing = true; gameLease?.close(); gameLease = null; }
window.addEventListener('pagehide', releaseGameLease);
document.addEventListener('doom3-engine-stopped', releaseGameLease);
// The offline boot skipped the reservation. Take it as soon as the network is
// back so multiplayer and cross-device saves can work again.
window.addEventListener('online', () => {
  if (isEngineStarted && !gameLease) {
    void acquireGameLease().catch(error => {
      console.warn('[DOOM 3 BFG Web] The account reservation could not be restored yet:', error);
    });
  }
});
const quarantinedKeys = new Set<string>();
const finishNativeStartup = (): void => {
  nativeInputReady = gamePresented && document.documentElement.dataset.doom3InputReady === '1';
  if (gamePresented || gameHasExited) return;
  updateLoadingProgress(100, 'Ready to play');
  document.documentElement.dataset.doom3AwaitingPlay = '1';
  loadingOverlay.classList.add('hidden');
  updateFullscreenGate();
  playButton.focus({ preventScroll: true });
};
function presentGame(): void {
    gamePresented = true;
    cacheAllMapsInBackground();
    document.documentElement.dataset.doom3AwaitingPlay = '0';
    document.documentElement.dataset.doom3InGame = '1';
    nativeInputReady = document.documentElement.dataset.doom3InputReady === '1';
    loadingOverlay.classList.add('hidden');
    playButton.hidden = true;
    disposeBrowserControls ??= installBrowserControls(canvas, { requireFullscreen: () => !localBrowserTesting && browserF11Active(),
      onError: message => console.warn('[DOOM 3 browser controls]', message) });
    updateFullscreenGate();
    canvas.focus({ preventScroll: true });
}
playButton.addEventListener('click', async () => {
  try {
    await enterGameFullscreen();
    presentGame();
  } catch (error) {
    const message = document.getElementById('fullscreen-message');
    if (message) message.textContent = `Could not enter full screen. ${String(error)}`;
  }
});
document.getElementById('fullscreen-windowed')?.addEventListener('click', () => { if (!gamePresented) presentGame(); });
document.getElementById('fullscreen-enter')?.addEventListener('click', () => {
  if (!gamePresented) void enterGameFullscreen().then(updateFullscreenGate).catch(error => { loadingDetail.textContent = String(error); });
});
(window as Window & { doom3BeforeAccountLeave?: () => Promise<void> }).doom3BeforeAccountLeave = flushSaveSync;
(window as Window & { doom3AfterAccountDelete?: () => void }).doom3AfterAccountDelete = () => {
  const account = getCurrentAccount();
  if (account) localStorage.setItem('doom3-deleted-account-v1', JSON.stringify({ id: account.id, owner: account.owner }));
  setSaveSyncEnabled(false);
};
document.addEventListener('doom3-native-ready', finishNativeStartup);
document.addEventListener('doom3-loading-state', (event) => {
  const loading = (event as CustomEvent<{ loading: boolean }>).detail?.loading;
  nativeInputReady = gamePresented && loading === false;
});
// Do not feed events into SDL while bootstrap or a level transition owns input.
// A key first pressed while loading remains consumed through its physical key-up.
const guardLoadingInput = (event: KeyboardEvent): void => {
  if (event.target instanceof Element && event.target.closest('#access-form, #account-dialog, #account-confirm')) {
    event.stopImmediatePropagation(); return;
  }
  if (event.target === playAgainButton || event.target === playButton ||
      event.target === document.getElementById('fullscreen-enter') ||
      event.target === document.getElementById('fullscreen-windowed')) {
    // Preserve the button's native Enter/Space activation without feeding SDL.
    if (event.type === 'keydown') quarantinedKeys.add(event.code);
    if (event.type === 'keyup') quarantinedKeys.delete(event.code);
    event.stopImmediatePropagation();
    return;
  }
  if (nativeInputReady && !quarantinedKeys.has(event.code) &&
      (event.ctrlKey || event.altKey || event.metaKey || ['F5', 'F11', 'F12'].includes(event.key))) return;
  if (!nativeInputReady || quarantinedKeys.has(event.code)) {
    if (event.type === 'keydown') quarantinedKeys.add(event.code);
    if (event.type === 'keyup') {
      const wasBlocked = quarantinedKeys.delete(event.code);
      if (!wasBlocked) return; // Release a key SDL received before the transition.
    }
    if (!['F5', 'F11', 'F12'].includes(event.key)) event.preventDefault();
    event.stopImmediatePropagation();
  }
};
// SDL registers on Window: a Document capture listener runs too late to stop it.
for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, guardLoadingInput as EventListener, true);

function showGameExit(crashed = false): void {
  if (gameHasExited) return;
  gameHasExited = true;
  document.dispatchEvent(new Event('doom3-engine-stopped'));
  document.documentElement.dataset.doom3AwaitingPlay = '0';
  playButton.hidden = true;
  document.documentElement.dataset.doom3InGame = '0';
  nativeInputReady = false;
  document.documentElement.dataset.doom3Exited = '1';
  document.documentElement.dataset.doom3InputReady = '0';
  document.documentElement.dataset.doom3RelativeMouse = '0';
  disposeBrowserControls?.();
  disposeBrowserControls = undefined;
  if (document.pointerLockElement) document.exitPointerLock();
  document.getElementById('fullscreen-gate')?.setAttribute('hidden', '');
  loadingOverlay.classList.remove('hidden');
  loadingProgressBar.parentElement?.setAttribute('hidden', '');
  loadingStatus.textContent = crashed ? 'The game stopped unexpectedly.' : 'Game closed';
  loadingDetail.textContent = 'Play again to restart D3BFG.js.';
  playAgainButton.hidden = false;
  playAgainButton.focus({ preventScroll: true });
}

playAgainButton.addEventListener('click', () => {
  window.location.reload();
});
document.addEventListener('doom3-game-exit', () => showGameExit());

function updateLoadingProgress(percent: number, status: string, detail = ''): void {
  if (gameHasExited) return;
  const boundedPercent = Math.min(100, Math.max(0, percent));
  if (loadingProgressBar) {
    loadingProgressBar.style.width = `${boundedPercent}%`;
    loadingProgressBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(boundedPercent)));
    loadingProgressBar.parentElement?.setAttribute('aria-valuetext', `${Math.round(boundedPercent)} percent. ${status}`);
  }
  if (loadingStatus) {
    loadingStatus.textContent = status;
  }
  if (loadingDetail) {
    loadingDetail.textContent = detail;
  }
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Estimating time remaining';
  if (seconds < 2) return 'Almost ready';
  if (seconds < 60) return `About ${Math.ceil(seconds)} seconds remaining`;
  return `About ${Math.ceil(seconds / 60)} minutes remaining`;
}

function previousEngineStartupSeconds(): number | null {
  try {
    const saved = Number(localStorage.getItem('doom3-engine-startup-seconds'));
    return saved > 0 && saved < 300 ? saved : null;
  } catch {
    return null;
  }
}

function showLoadingError(message: string): void {
  // Failed preflight/downloads never created a game. Do not leave a live account
  // reservation behind (notably when Chrome rejects SharedArrayBuffer).
  if (!isEngineStarted) releaseGameLease();
  if (!gamePresented) {
    document.documentElement.dataset.doom3AwaitingPlay = '0';
    loadingOverlay.classList.remove('hidden');
    document.getElementById('fullscreen-gate')?.setAttribute('hidden', '');
  }
  if (loadingError) {
    loadingError.textContent = message;
    loadingError.style.display = 'block';
  }
  if (loadingStatus) {
    loadingStatus.textContent = 'Could not start the game';
  }
  playAgainButton.textContent = 'Try again';
  playAgainButton.hidden = false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Checks whether a given manifest path is a map archive.
 * Map archives under the engine's game-directory roots are NOT permanent boot assets and must never
 * be downloaded as part of permanent startup.
 */
function isMapArchive(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  return (
    /^(base|d3xp|d3le)\/maps\//.test(normalized) &&
    normalized.endsWith('.resources')
  );
}

/**
 * Keep shared/menu archives on disk. Maps and loose Bink videos are staged
 * into memory at first use; the native VFS still needs root archive indexes
 * during startup, before the original title menu is created.
 */
function isPermanentBootAsset(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  if (isMapArchive(normalized)) {
    return false;
  }
  // DOOM 1/DOOM 2 (doomclassic) WADs and their data live in the same VFS as the
  // rest of the game. Keep them on disk regardless of the video rules below so
  // the classic games stay playable from a partially cached install.
  if (/^base\/(?:wads\/.*\.wad|doomclassic\/)/i.test(normalized)) {
    return true;
  }
  return browserPreferences.cacheMode === 3 || !/^(base|d3xp|d3le)\/(?:video|sound\/VO\/video)\/.*\.bik$/i.test(relPath.replace(/\\/g, '/'));
}

let opfsRootHandle: FileSystemDirectoryHandle | null = null;
let discoveredMapArchiveNames = new Set<string>();

// A boot that cannot reach the server still has to provide the authentic asset
// list, so the last successful manifest is cached locally. Without it there is
// no way to tell whether the OPFS copy is complete.
const MANIFEST_CACHE_KEY = 'doom3-manifest-cache-v1';

interface CachedManifest {
  manifestEtag: string;
  files: ManifestEntry[];
}

function readCachedManifest(): CachedManifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedManifest;
    if (!parsed || !Array.isArray(parsed.files) || typeof parsed.manifestEtag !== 'string') return null;
    const files = parsed.files.filter((entry) =>
      entry && typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 512 &&
      Number.isSafeInteger(entry.size) && entry.size >= 0 && typeof entry.etag === 'string');
    return files.length ? { manifestEtag: parsed.manifestEtag, files } : null;
  } catch {
    return null;
  }
}

function writeCachedManifest(manifest: ManifestResponse): void {
  try {
    const cache: CachedManifest = {
      manifestEtag: typeof manifest.manifestEtag === 'string' ? manifest.manifestEtag : '',
      files: manifest.files.map(({ path, size, etag }) => ({ path, size, etag })),
    };
    localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full/blocked localStorage must not break a boot that is otherwise fine.
  }
}

function looksLikeNetworkFailure(error: unknown): boolean {
  if (navigator.onLine === false) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed|network request failed|err_internet|err_network|offline|fetch failed|timed out|timeout|aborted/i.test(message);
}

/**
 * Synchronizes boot assets into permanent OPFS cache:
 * - Checks quota and availability
 * - Reuses existing cached files matching manifest ETag
 * - Streams missing/updated files
 * - Excludes all map archives from permanent storage
 */
async function syncAssetsToOpfs(): Promise<ScannedFile[]> {
  updateLoadingProgress(0, 'Checking browser storage...');

  // Check quota if available
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const available = quota - usage;
      console.log(`[DOOM 3 BFG Web] Storage estimate: ${formatBytes(usage)} used of ${formatBytes(quota)} (${formatBytes(available)} available)`);
    } catch (e) {
      console.warn('[DOOM 3 BFG Web] Storage quota estimation failed:', e);
    }
  }

  // Fetch Manifest
  updateLoadingProgress(5, 'Fetching asset manifest from private server...');
  const manifestUrl = '/__local_game/manifest';
  let manifest: ManifestResponse | null = null;
  let offlineBoot = false;
  try {
    let resp: Response | null = null;
    try {
      resp = await fetch(manifestUrl, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (resp.status >= 500) throw new TypeError('Failed to fetch the game manifest: server unavailable');
    } catch (networkError) {
      // The origin is unreachable. Fall back to the last good manifest so a
      // fully cached install can still reach the menu without a network.
      const cached = readCachedManifest();
      if (!cached || !looksLikeNetworkFailure(networkError)) throw networkError;
      console.warn('[DOOM 3 BFG Web] Asset manifest unreachable; using the cached manifest for an offline boot.');
      manifest = { gameDir: '', manifestEtag: cached.manifestEtag, files: cached.files };
      offlineBoot = true;
      markBootedOffline(true);
      queueNativeNotice('Offline: the game will start from cached data and online features are unavailable.');
    }
    if (!manifest) {
      if (!resp) throw new Error('The asset manifest could not be requested.');
      if (!resp.ok) {
        throw new Error(`Manifest fetch failed with status ${resp.status} (${resp.statusText})`);
      }
      const parsed = (await resp.json()) as ManifestResponse;
      if (!parsed || !Array.isArray(parsed.files)) {
        throw new Error('The asset manifest response was malformed.');
      }
      manifest = parsed;
      writeCachedManifest(manifest);
      markBootedOffline(navigator.onLine === false);
      if (navigator.onLine === false) {
        queueNativeNotice('Offline: the game will start from cached data and online features are unavailable.');
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (looksLikeNetworkFailure(err)) {
      markBootedOffline(true);
      throw new Error('This device is offline and no complete cached copy of the game is available yet. Connect to the internet and reload.');
    }
    throw new Error(`Cannot connect to game server: ${msg}`);
  }
  if (!manifest) {
    throw new Error('Cannot connect to game server: no asset manifest is available.');
  }

  discoveredMapArchiveNames = new Set<string>();
  activeManifest = manifest;
  for (const entry of manifest.files) {
    const normalizedPath = entry.path.replace(/\\/g, '/').toLowerCase();
    if (!isMapArchive(normalizedPath)) continue;
    const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
    const mapName = filename.slice(0, -'.resources'.length);
    if (/^[a-z0-9_]+$/.test(mapName)) discoveredMapArchiveNames.add(mapName);
  }

  // Filter manifest: strictly select only permanent boot/menu assets
  const bootEntries: ManifestEntry[] = manifest.files.filter((entry) => isPermanentBootAsset(entry.path));
  console.log(`[DOOM 3 BFG Web] Manifest total entries: ${manifest.files.length}; boot entries to sync: ${bootEntries.length}`);

  if (browserPreferences.cacheMode === 0) {
    let downloaded = 0;
    const total = bootEntries.reduce((sum, entry) => sum + entry.size, 0);
    const started = performance.now();
    const files: ScannedFile[] = [];
    // File/Blob handles can be shared with pthreads without cloning an entire
    // install per worker. They have no app-managed durable cache in this mode.
    for (const entry of bootEntries) {
      const response = await fetch(`/__local_game/file?path=${encodeURIComponent(entry.path)}`, { cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`Could not download ${entry.path} (${response.status}).`);
      let fileBytes = 0;
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          fileBytes += chunk.byteLength;
          downloaded += chunk.byteLength;
          if (fileBytes > entry.size) throw new Error(`Invalid file size: ${entry.path}`);
          controller.enqueue(chunk);
          const rate = downloaded / Math.max(0.001, (performance.now() - started) / 1000);
          updateLoadingProgress(10 + 80 * downloaded / total, 'Downloading game assets',
            `${formatBytes(downloaded)} / ${formatBytes(total)} · ${formatEta((total - downloaded) / rate)}`);
        },
      }));
      const blob = await new Response(stream).blob();
      if (fileBytes !== entry.size) throw new Error(`Incomplete game file: ${entry.path}`);
      files.push({ relativePath: entry.path, file: new File([blob], entry.path.split('/').pop()!) });
    }
    return files;
  }

  opfsRootHandle = await getOpfsRoot();
  const permRoot = await getOpfsSubdir(opfsRootHandle, OPFS_PERM_DIR, true);

  const storedMeta: StoredMetaMap = (await readStoredMeta(permRoot)) || {
    manifestEtag: '',
    files: {},
  };

  // Collect active boot manifest paths for stale file pruning in permanent store
  const bootManifestPathSet = new Set<string>();
  for (const entry of bootEntries) {
    bootManifestPathSet.add(entry.path);
  }

  // Prune deleted or stale files recorded in previous OPFS permanent metadata
  const stalePaths: string[] = [];
  for (const cachedPath of Object.keys(storedMeta.files)) {
    if (!bootManifestPathSet.has(cachedPath)) {
      stalePaths.push(cachedPath);
    }
  }

  if (stalePaths.length > 0) {
    console.log(`[DOOM 3 BFG Web] Pruning ${stalePaths.length} stale/removed files from permanent OPFS...`);
    for (const stalePath of stalePaths) {
      try {
        await deleteOpfsFile(permRoot, stalePath);
      } catch (e) {
        console.warn(`[DOOM 3 BFG Web] Failed to remove stale OPFS file ${stalePath}:`, e);
      }
      delete storedMeta.files[stalePath];
    }
    await writeStoredMeta(permRoot, storedMeta);
  }

  // Determine what permanent boot assets need to be downloaded
  updateLoadingProgress(8, 'Verifying cached assets in storage...');
  const filesToDownload: ManifestEntry[] = [];
  let totalBytesToDownload = 0;
  let totalBootBytes = 0;

  for (const entry of bootEntries) {
    totalBootBytes += entry.size;
    const existing = storedMeta.files[entry.path];
    if (!existing) {
      filesToDownload.push(entry);
      totalBytesToDownload += entry.size;
      continue;
    }
    // An offline boot cannot refresh a cached copy, so a cached file from the
    // previous build is still usable as long as it is physically present. The
    // menu only needs the shared assets; missing level archives keep their
    // levels unplayable without blocking startup.
    const expectedSize = offlineBoot ? existing.size : entry.size;
    if (!offlineBoot && (existing.etag !== entry.etag || existing.size !== entry.size)) {
      filesToDownload.push(entry);
      totalBytesToDownload += entry.size;
      continue;
    }
    // Confirm that physical file exists and matches size in permanent OPFS
    const existsAndMatches = await verifyOpfsFileExistsAndSize(permRoot, entry.path, expectedSize);
    if (!existsAndMatches) {
      filesToDownload.push(entry);
      totalBytesToDownload += entry.size;
    }
  }

  // An offline boot can only use files that are already on disk.
  if (offlineBoot && filesToDownload.length > 0) {
    throw new Error(
      `This device is offline and ${filesToDownload.length} required game file${filesToDownload.length === 1 ? ' is' : 's are'} not cached yet. Connect to the internet and reload.`,
    );
  }

  // Verify storage quota against bytes to download
  if (navigator.storage && navigator.storage.estimate && filesToDownload.length > 0) {
    try {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const available = quota - usage;
      if (quota > 0 && available < totalBytesToDownload) {
        throw new Error(
          `Insufficient disk space in browser quota: Need ${formatBytes(totalBytesToDownload)}, but only ${formatBytes(available)} available.`
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Insufficient disk space')) {
        throw err;
      }
    }
  }

  if (filesToDownload.length === 0) {
    updateLoadingProgress(90, 'Game assets ready', `${formatBytes(totalBootBytes)} cached`);
  } else {
    console.log(
      `[DOOM 3 BFG Web] Synchronizing ${filesToDownload.length} boot files (${formatBytes(totalBytesToDownload)}) to permanent OPFS cache...`
    );

    const downloadConcurrency = Math.min(8, filesToDownload.length);
    const downloadController = new AbortController();
    let nextFileIndex = 0;
    let activeDownloads = 0;
    let completedFiles = 0;
    let downloadedBytes = 0;
    let metadataWriteQueue: Promise<void> = Promise.resolve();
    const downloadStartedAt = performance.now();
    const persistMetadata = (): Promise<void> => {
      metadataWriteQueue = metadataWriteQueue.then(() => writeStoredMeta(permRoot, storedMeta));
      return metadataWriteQueue;
    };

    const reportDownloadProgress = (_activePath = ''): void => {
      const byteProgress = totalBytesToDownload > 0 ? downloadedBytes / totalBytesToDownload : 1;
      const percent = Math.min(90, Math.floor(10 + byteProgress * 80));
      const elapsedSeconds = Math.max(0.001, (performance.now() - downloadStartedAt) / 1000);
      const rate = downloadedBytes / elapsedSeconds;
      const startupSeconds = previousEngineStartupSeconds();
      const eta = downloadedBytes > 0 && elapsedSeconds >= 1
        ? formatEta((totalBytesToDownload - downloadedBytes) / rate + (startupSeconds ?? 0))
        : 'Estimating time remaining';
      const detail = [
        `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytesToDownload)}`,
        `${formatBytes(rate)}/s`,
        startupSeconds === null ? `${eta} for download` : eta,
      ].filter(Boolean).join(' · ');
      updateLoadingProgress(
        percent,
        'Downloading game assets',
        detail,
      );
    };

    const downloadNextFile = async (): Promise<void> => {
      while (nextFileIndex < filesToDownload.length) {
        const fileIndex = nextFileIndex++;
        const fileEntry = filesToDownload[fileIndex];
        activeDownloads++;
        reportDownloadProgress(fileEntry.path);

        try {
          const downloadUrl = `/__local_game/file?path=${encodeURIComponent(fileEntry.path)}`;
          const maxAttempts = 3;
          for (let attempt = 1; ; attempt++) {
            let attemptBytes = 0;
            try {
              await streamFileToOpfs(
                permRoot,
                fileEntry.path,
                downloadUrl,
                (chunkLength) => {
                  downloadedBytes += chunkLength;
                  attemptBytes += chunkLength;
                  reportDownloadProgress(fileEntry.path);
                },
                downloadController.signal,
              );
              break;
            } catch (downloadError) {
              // Remove the bytes counted for the failed attempt so the progress bar
              // stays accurate when a transient fetch failure is retried.
              downloadedBytes -= attemptBytes;
              reportDownloadProgress(fileEntry.path);
              if (attempt >= maxAttempts || downloadController.signal.aborted) {
                throw downloadError;
              }
              console.warn(
                `[DOOM 3 BFG Web] Retrying ${fileEntry.path} (attempt ${attempt + 1}/${maxAttempts}) after: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`,
              );
              await new Promise((resolve) => window.setTimeout(resolve, 250 * attempt));
            }
          }

          storedMeta.files[fileEntry.path] = {
            etag: fileEntry.etag,
            size: fileEntry.size,
          };
          completedFiles++;

          // Serialize metadata writes while keeping completed downloads recoverable.
          if (completedFiles % 20 === 0 || completedFiles === filesToDownload.length) {
            await persistMetadata();
          }
          reportDownloadProgress(fileEntry.path);
        } catch (error) {
          downloadController.abort();
          throw error;
        } finally {
          activeDownloads--;
        }
      }
    };

    const workers = Array.from({ length: downloadConcurrency }, () => downloadNextFile());
    try {
      await Promise.all(workers);
    } catch (error) {
      downloadController.abort();
      await Promise.allSettled(workers);
      try {
        await metadataWriteQueue;
      } catch {
        // Preserve the original download failure.
      }
      throw error;
    }

    storedMeta.manifestEtag = manifest.manifestEtag;
    await writeStoredMeta(permRoot, storedMeta);
  }

  updateLoadingProgress(92, 'Loading cached file handles for engine mount...');
  const opfsBootFiles = await collectOpfsFiles(permRoot, '', bootManifestPathSet);

  // Normalize relative paths so that they align with engine expectation "base/..."
  const stagedFiles: ScannedFile[] = [];
  for (const item of opfsBootFiles) {
    const normalized = item.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/');
    let relativePath = normalized;
    if (parts.length >= 2 && parts[0].toLowerCase() !== 'base' && parts[1].toLowerCase() === 'base') {
      relativePath = parts.slice(1).join('/');
    }
    stagedFiles.push({
      file: item.file,
      relativePath,
    });
  }

  return stagedFiles;
}

/**
 * Checks runtime environment capabilities for WebAssembly pthread/SharedArrayBuffer support.
 */
function isSharedMemorySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined'
  );
}

/**
 * Checks for generated Emscripten worker engine module.
 * The pthread engine is the only game-data-capable profile because WORKERFS mounting
 * requires a Web Worker context.
 */
async function probeEngineModule(): Promise<URL> {
  const engineRoot = new URL(`${import.meta.env.BASE_URL}engine-worker/`, window.location.href);
  let workerEngineUrl = new URL('doom3_bfg_web.js', engineRoot);

  const buildResponse = await fetch(new URL('build-info.json', engineRoot), { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (buildResponse.ok && buildResponse.headers.get('content-type')?.includes('application/json')) {
    const build = await buildResponse.json() as { format?: number; version?: string; modulePath?: string; workerReadySignal?: boolean };
    if (build.format !== 1 || !/^[a-f0-9]{24}$/.test(build.version ?? '') ||
        build.modulePath !== `${build.version}/doom3_bfg_web.js`) {
      throw new Error('The engine build manifest is invalid. Reload after the build finishes.');
    }
    workerEngineUrl = new URL(build.modulePath, engineRoot);
    document.documentElement.dataset.doom3Build = build.version;
    console.info('[DOOM 3 build]', { version: build.version, renderer: 'WebGL 2', engine: workerEngineUrl.href, browser: navigator.userAgent });
    workerHasReadySignal = build.workerReadySignal === true;
  } else if (buildResponse.status !== 404 && !buildResponse.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`Could not read the engine build manifest (${buildResponse.status}).`);
  }

  try {
    const resp = await fetch(workerEngineUrl, { method: 'HEAD' });
    if (resp.ok) {
      return workerEngineUrl;
    }
  } catch {
    // Continue to error below
  }

  throw new Error('Worker engine WebAssembly/JS module was not found at public engine-worker URL.');
}

/**
 * Optional development-only level shortcut for repeatable renderer testing.
 * Only discovered map archive basenames are accepted and mapped beneath game/.
 */
function getDevelopmentMapArgument(): string | null {
  if (!isDevelopmentBuild) return null;

  const requestedMap = new URLSearchParams(window.location.search).get('devmap')?.toLowerCase();
  if (!requestedMap) return null;

  if (!/^[a-z0-9_]+$/.test(requestedMap) || !discoveredMapArchiveNames.has(requestedMap)) {
    console.warn(`[DOOM 3 BFG Web] Ignoring unknown development map shortcut: ${requestedMap}`);
    return null;
  }

  return `game/${requestedMap}`;
}

function isDevelopmentFlatRenderRequested(): boolean {
  if (!isDevelopmentBuild) return false;

  return new URLSearchParams(window.location.search).get('devflat') === '1';
}

type DevelopmentRenderMode =
  | 'ambient'
  | 'interactions'
  | 'interactions-depth'
  | 'interactions-stencil'
  | 'interactions-bounds'
  | 'interactions-lequal'
  | 'interactions-matrix'
  | 'motion-blur-off'
  | 'pixels'
  | 'skip-post-process';

/**
 * Hidden renderer isolation switch for repeatable local diagnosis.
 * It maps fixed URL values to existing engine cvars and never renders UI.
 */
function getDevelopmentRenderMode(): DevelopmentRenderMode | null {
  if (!isDevelopmentBuild || !new URLSearchParams(window.location.search).has('devmap')) {
    return null;
  }

  const requestedMode = new URLSearchParams(window.location.search).get('devrender');
  if (
    requestedMode === 'ambient'
    || requestedMode === 'interactions'
    || requestedMode === 'interactions-depth'
    || requestedMode === 'interactions-stencil'
    || requestedMode === 'interactions-bounds'
    || requestedMode === 'interactions-lequal'
    || requestedMode === 'interactions-matrix'
    || requestedMode === 'motion-blur-off'
    || requestedMode === 'pixels'
    || requestedMode === 'skip-post-process'
  ) {
    return requestedMode;
  }

  if (requestedMode) {
    console.warn(`[DOOM 3 BFG Web] Ignoring unknown renderer diagnostic: ${requestedMode}`);
  }
  return null;
}

// Global runtime state
let isEngineStarted = false;
let engineLaunchFn: (() => Promise<void>) | null = null;

const browserNavigationKeys = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

function isGameCanvasFocused(): boolean {
  return Boolean(canvas && (document.activeElement === canvas || document.pointerLockElement === canvas));
}

// Keep browser navigation keys inside the focused SDL canvas. Leave browser
// shortcuts (Ctrl/Alt/Meta) and Escape's mandatory pointer-lock exit gesture
// under browser control.
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!isGameCanvasFocused() || event.ctrlKey || event.altKey || event.metaKey) return;
  if (browserNavigationKeys.has(event.key)) {
    event.preventDefault();
  }
}, true);

document.addEventListener('wheel', (event: WheelEvent) => {
  if (isGameCanvasFocused()) event.preventDefault();
}, { capture: true, passive: false });

document.addEventListener('contextmenu', (event: MouseEvent) => {
  if (isGameCanvasFocused()) event.preventDefault();
}, true);

document.addEventListener('pointerlockchange', () => {
  if (document.documentElement.dataset.doom3Exited === '1') {
    if (canvas && document.pointerLockElement === canvas) document.exitPointerLock();
    return;
  }
  if (canvas && document.pointerLockElement === canvas) {
    canvas.focus({ preventScroll: true });
  }
});

function sizeCanvasForViewport(): void {
  if (!canvas) return;
  publishDisplaySize();
    const width = Atomics.load(browserDisplayState, 1);
    const height = Atomics.load(browserDisplayState, 2);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

async function main(): Promise<void> {
  if (!canvas) {
    showLoadingError('Fatal: Canvas element #canvas not found in DOM.');
    return;
  }
  const offlineShellReady = initializeOfflineShell();
  const serverDefaultsReady = applyServerBrowserDefaults();
  try {
    // Offline preparation is optional background work, never a startup gate.
    await applyPendingAccountRemoval();
    await applyPendingAssetClear();
    await requirePrivateAccess();
    await serverDefaultsReady;
    await acquireGameLease();
    if (getCurrentAccount()) browserPreferences.persistSaves = 1;
    updateFullscreenGate();
  } catch (error) {
    showLoadingError(error instanceof Error ? error.message : String(error));
    return;
  }
  const accountAtBoot = getCurrentAccount()?.id;
  if (accountAtBoot) {
    window.setInterval(async () => {
      try {
        const response = await fetch('/__session/status', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const state = await response.json();
        if (!state.authenticated || state.user?.id !== accountAtBoot) {
          setSaveSyncEnabled(false);
          showGameExit();
          window.location.replace('/');
        }
      } catch { /* A temporary connection loss keeps the local game and saves. */ }
    }, 30000);
  }
  try {
    const account = getCurrentAccount();
    if (account) await prepareSaveSync(true, account.id, account.owner);
  }
  catch (error) {
    // A missing snapshot must not keep the menu away from the player: the
    // browser keeps its own saves and the next successful boot reconciles them.
    setSaveSyncEnabled(false);
    if (looksLikeNetworkFailure(error)) markBootedOffline(true);
    console.warn('[DOOM 3 BFG Web] Save sync unavailable; continuing with local saves.', error);
    document.dispatchEvent(new CustomEvent('doom3-sync-status', {
      detail: error instanceof Error ? `Using local saves: ${error.message}` : 'Save sync is unavailable; local saves are kept.',
    }));
    if (!looksLikeNetworkFailure(error)) {
      queueNativeNotice('Save sync is unavailable. Local saves are being used.');
    }
  }

  // Pre-flight check: the worker pthread build is the only game-data-capable profile built because
  // WORKERFS mounting requires a Web Worker context. The worker profile requires SharedArrayBuffer
  // and cross-origin isolation. Check capabilities before initiating asset sync.
  if (!isSharedMemorySupported()) {
    // Capture the actual browser state and response headers. A Chrome-only
    // failure cannot be diagnosed from the generic isolation warning alone.
    void fetch(location.href, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }).then(response => {
      const message = '[BFG Engine Error] Browser isolation preflight ' + JSON.stringify({
        isolated: window.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer,
        secureContext: window.isSecureContext, topLevel: window === window.top,
        coop: response.headers.get('cross-origin-opener-policy'),
        coep: response.headers.get('cross-origin-embedder-policy'),
        permissions: response.headers.get('permissions-policy'),
      });
      console.error(message);
      return fetch('/__local_game/trace', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: message, keepalive: true });
    }).catch(() => {});
    showLoadingError(
      'Cross-origin isolation is not active in this browser context (window.crossOriginIsolated is false or SharedArrayBuffer is unavailable).\n\n' +
      'DOOM 3 BFG Web requires cross-origin isolation so the pthread engine worker can access shared memory and mount game archives via WORKERFS.\n\n' +
      'Open the HTTPS game address directly in a new tab. Required server headers:\n' +
      '  Cross-Origin-Opener-Policy: same-origin\n' +
      '  Cross-Origin-Embedder-Policy: require-corp\n\n' +
      `Browser status: secure=${window.isSecureContext}, isolated=${window.crossOriginIsolated}, SharedArrayBuffer=${typeof SharedArrayBuffer}, top-level=${window === window.top}.\n\n` +
      'If only Chrome fails, open the HTTPS address directly in a new tab and try a clean Chrome profile or a window without extensions. Managed-browser policies can also disable shared memory. Server diagnostics now record the isolation headers seen by this browser. No isolation or security setting is bypassed.'
    );
    return;
  }

  // Ask the browser to protect IndexedDB/OPFS from automatic eviction without
  // delaying downloads or engine startup. Saves still work when this is denied.
  const storage = navigator.storage;
  const storagePersist = storage?.persist?.bind(storage);
  const storagePersisted = storage?.persisted?.bind(storage);
  if (!storagePersist || !storagePersisted) {
    console.warn('[DOOM 3 BFG Web] Persistent browser storage is unsupported; saved games may be evicted by the browser.');
  } else {
    void storagePersisted()
      .then((alreadyPersistent) => {
        if (alreadyPersistent) {
          console.info('[DOOM 3 BFG Web] Browser storage is already persistent.');
          return true;
        }
        return storagePersist().then((granted) => {
          if (granted) {
            console.info('[DOOM 3 BFG Web] Browser granted persistent storage; saved games are less likely to be evicted.');
          } else {
            console.warn('[DOOM 3 BFG Web] Browser denied persistent storage; saves can still work, but may be evicted.');
          }
          return granted;
        });
      })
      .catch((storageError: unknown) => {
        console.warn('[DOOM 3 BFG Web] Persistent storage request failed; saves may be evicted:', storageError);
      });
  }

  // Check the game-data-capable engine artifact before downloading the boot install.
  let workerEngineUrl: URL;
  try {
    workerEngineUrl = await probeEngineModule();
    void offlineShellReady.then(() => prepareOfflineEngine(workerEngineUrl));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showLoadingError(`Engine module error: ${msg}`);
    return;
  }

  // Diagnostic WebGL 2 probe using an isolated off-DOM canvas so the game canvas context is never touched
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) {
      console.warn('[DOOM 3 BFG Web] WebGL 2 diagnostic check returned null on off-screen probe canvas.');
    } else {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (err) {
    console.warn('[DOOM 3 BFG Web] WebGL 2 diagnostic error:', err);
  }

  let stagedFiles: ScannedFile[] = [];
  try {
    await holdAssetCacheLease();
    stagedFiles = await syncAssetsToOpfs();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showLoadingError(`Asset synchronization error: ${msg}`);
    return;
  }

  // All-level caching starts after presentation, never ahead of the menu.

  // Validate staged boot data layout (boot archives, default.cfg, configs)
  updateLoadingProgress(95, 'Validating game boot archives...');
  const validation = validateGameData(stagedFiles);
  if (!validation.isValid) {
    const issues = validation.issues.join('\n');
    showLoadingError(`Game archive validation failed:\n${issues}`);
    return;
  }

  updateLoadingProgress(96, 'Starting D3BFG.js',
    previousEngineStartupSeconds() === null ? 'Preparing the engine…' : formatEta(previousEngineStartupSeconds()!));

  // Prepare the worker engine after boot assets validate.
  engineLaunchFn = async () => {
    if (isEngineStarted || gameHasExited || !hasGameLease()) return;
    // Emscripten transfers this canvas to the engine worker. Set the drawing
    // buffer first; otherwise its default 300x150 size clips the game's menu.
    // Focus it before transfer so SDL keyboard input has a focused target.
    sizeCanvasForViewport();
    canvas.focus({ preventScroll: true });
    isEngineStarted = true;
    await waitForDisplayCadence();
    if (gameHasExited || !hasGameLease()) return;

    console.log(
      `[DOOM 3 BFG Web] Initializing worker pthread engine with ${stagedFiles.length} boot OPFS files...`
    );

    const engineArguments = [
        '+set', 'r_fullscreen', String(Atomics.load(browserDisplayState, 3)),
        '+set', 'r_windowWidth', String(Atomics.load(browserDisplayState, 1)),
        '+set', 'r_windowHeight', String(Atomics.load(browserDisplayState, 2)),
      '+set', 'fs_basepath', '/doom3_game_data',
      '+set', 'fs_savepath', getCurrentAccount() ? accountSavePath(getCurrentAccount()!.id) : '/doom3_save_data',
      '+set', 'web_developerMenu', String(browserPreferences.developerMenu),
      '+set', 'g_webSkipCinematics', String(browserPreferences.skipIntro),
      '+set', 'com_allowConsole', String(browserPreferences.enableConsole),
        '+set', 'stereoRender_enable', '0',
        '+set', 'com_showFPS', '0',
    ];
    // Persist the chosen cap before restart, then bound it by this display's
    // measured cadence. Native profile writes may still be finishing on restart.
    engineArguments.push('+set', 'com_engineHz', String((window as unknown as {
      doom3BrowserBridge: { getNumber(key: string): number };
    }).doom3BrowserBridge.getNumber('startupFrameRateCap')));
    const profileName = getCurrentAccount()?.name || localStorage.getItem('doom3-profile-name-v1');
    if (profileName && /^[^\x00-\x1f\x7f|]{1,48}$/.test(profileName)) engineArguments.push('+set', 'ui_name', profileName);
    const developmentMap = getDevelopmentMapArgument();
    if (developmentMap) {
      engineArguments.push('+set', 'com_webDiagnostics', '1');
      engineArguments.push('+set', 'r_webPortDrawTrace', '1', '+set', 'r_webPortBufferTrace', '1');
      console.info('[DOOM 3 BFG Web] Development diagnostics: trace WebGL draws and streaming-buffer map, flush, and unmap calls.');
      if (isDevelopmentFlatRenderRequested()) {
        engineArguments.push('+set', 'r_webPortFlatTrace', '1');
        console.info('[DOOM 3 BFG Web] Development magenta opaque-surface diagnostic enabled.');
      }
      const renderMode = getDevelopmentRenderMode();
      if (renderMode === 'pixels') {
        engineArguments.push('+set', 'r_webPortPassTrace', '1');
        console.info('[DOOM 3 BFG Web] Renderer diagnostic: sample scene output after each render pass.');
      } else if (renderMode === 'ambient') {
        engineArguments.push('+set', 'r_webPortPassTrace', '1', '+set', 'r_skipInteractions', '1', '+set', 'r_skipAmbient', '0');
        console.info('[DOOM 3 BFG Web] Renderer diagnostic: ambient/material pass only.');
      } else if (renderMode === 'interactions') {
        engineArguments.push('+set', 'r_webPortPassTrace', '1', '+set', 'r_webPortBypassInteractionDepthStencil', '1', '+set', 'r_skipInteractions', '0', '+set', 'r_skipAmbient', '1');
        console.info('[DOOM 3 BFG Web] Renderer diagnostic: light interactions only, bypassing depth/stencil tests.');
      } else if (renderMode === 'skip-post-process') {
        engineArguments.push('+set', 'r_skipPostProcess', '1');
        console.info('[DOOM 3 BFG Web] Renderer diagnostic: skip post-process rendering.');
      } else if (renderMode === 'motion-blur-off') {
        engineArguments.push('+set', 'r_motionBlur', '0');
        console.info('[DOOM 3 BFG Web] Renderer diagnostic: motion blur disabled.');
      } else if (
        renderMode === 'interactions-depth'
        || renderMode === 'interactions-stencil'
        || renderMode === 'interactions-bounds'
        || renderMode === 'interactions-lequal'
        || renderMode === 'interactions-matrix'
      ) {
        const isolationMode = {
          'interactions-depth': '1',
          'interactions-stencil': '2',
          'interactions-bounds': '3',
          'interactions-lequal': '4',
          'interactions-matrix': '-1',
        }[renderMode];
        engineArguments.push(
          '+set', 'r_webPortPassTrace', '1',
          '+set', 'r_webPortInteractionIsolationMode', isolationMode,
          '+set', 'r_skipInteractions', '0',
        );
        if (renderMode === 'interactions-matrix') {
          console.info('[DOOM 3 BFG Web] Renderer diagnostic: capture full scene while cycling normal, depth, stencil, bounds, and LEQUAL modes across five frames.');
        } else {
          engineArguments.push('+set', 'r_skipAmbient', '1');
          console.info(`[DOOM 3 BFG Web] Renderer diagnostic: light interactions only; isolation mode ${isolationMode}.`);
        }
      }
      // Isolate the threaded game/draw path while diagnosing map-startup hangs.
      engineArguments.push('+set', 'com_smp', '0', '+map', developmentMap);
      console.info('[DOOM 3 BFG Web] Development diagnostic: com_smp=0 for map-startup isolation.');
      console.info(`[DOOM 3 BFG Web] Development auto-launch map: ${developmentMap}`);
    }

    try {
      let abortReported = false;
      // Bounded tail of the engine log used as crash context in production traces.
      const crashBreadcrumbs: string[] = [];
      const rememberBreadcrumb = (line: string) => {
        if (!line) return;
        crashBreadcrumbs.push(line.length > 160 ? line.slice(0, 160) : line);
        if (crashBreadcrumbs.length > 24) crashBreadcrumbs.shift();
      };
      const engineStartupStartedAt = performance.now();
      // A full page reload is required for the browser to fetch a rebuilt worker WASM.
      const engineModule = (await import(/* @vite-ignore */ workerEngineUrl.href)) as {
        default?: (options: Record<string, unknown>) => Promise<unknown>;
      };

      if (!engineModule.default) {
        throw new Error('Emscripten module factory was not exported by the loaded script.');
      }
      if (gameHasExited || !hasGameLease()) return;

      const maxBufferTraceEvents = 512;
      const maxRuntimeTraceBatchBytes = 3000;
      const runtimeTraceQueue: string[] = [];
      let runtimeTraceBytes = 0;
      let bufferTraceEvents = 0;
      let runtimeTraceTimer: number | undefined;
      let runtimeTracePersistence = Promise.resolve();
      let productionTraceEvents = 0;

      const postRuntimeTrace = (body: string) => {
        runtimeTracePersistence = runtimeTracePersistence.then(() => fetch('/__local_game/trace', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body,
          keepalive: true,
        })).then(() => undefined).catch(() => {});
      };

      const flushRuntimeTrace = () => {
        if (runtimeTraceTimer !== undefined) {
          window.clearTimeout(runtimeTraceTimer);
          runtimeTraceTimer = undefined;
        }
        if (runtimeTraceQueue.length === 0) return;

        const batch = runtimeTraceQueue.join('\n');
        runtimeTraceQueue.length = 0;
        runtimeTraceBytes = 0;
        postRuntimeTrace(batch);
      };

      const queueRuntimeTrace = (line: string) => {
        const lineBytes = new TextEncoder().encode(line).byteLength;
        if (lineBytes > maxRuntimeTraceBatchBytes) {
          flushRuntimeTrace();
          postRuntimeTrace(line);
          return;
        }
        const separatorBytes = runtimeTraceQueue.length === 0 ? 0 : 1;
        if (runtimeTraceBytes + lineBytes + separatorBytes > maxRuntimeTraceBatchBytes) {
          flushRuntimeTrace();
        }
        runtimeTraceQueue.push(line);
        runtimeTraceBytes += lineBytes + (runtimeTraceQueue.length === 1 ? 0 : 1);
        if (line.includes('[web-port backend]')) {
          flushRuntimeTrace();
        } else if (runtimeTraceBytes >= 2400 || runtimeTraceQueue.length >= 16) {
          flushRuntimeTrace();
        } else if (runtimeTraceTimer === undefined) {
          runtimeTraceTimer = window.setTimeout(flushRuntimeTrace, 250);
        }
      };

      const reportRuntimeTrace = (values: unknown[]) => {
        const line = values.map((value) => String(value)).join(' ');
        if (!isDevelopmentBuild) {
          const fatal = /^\[BFG Engine (?:Error|Abort)\]/.test(line);
          if (!fatal && (!/^\[(?:web-port (?:map|menu|session)|physics|snapshot)\]/.test(line) || productionTraceEvents++ >= 128)) return;
          if (fatal) {
            // A wasm trap carries no reliable frame names in production, so ship the
            // tail of the engine log alongside it. That is usually enough to tell
            // which stage of the game frame was running when the trap happened.
            const context = crashBreadcrumbs.join(' || ');
            queueRuntimeTrace(`[BFG Engine Crash] ${line.slice(0, 2200)} || Recent engine log: ${context.slice(-1200)}`.slice(0, 3500));
            crashBreadcrumbs.length = 0;
            flushRuntimeTrace();
            return;
          }
          queueRuntimeTrace(line.slice(0, 1024));
          return;
        }
        if (line.includes('[web-port buffer]')) {
          if (bufferTraceEvents < maxBufferTraceEvents) {
            bufferTraceEvents++;
            queueRuntimeTrace(line);
          }
          return;
        }
        if (
          // Keep session-wait diagnostics alongside startup and map traces.
          !line.includes('[web-port session]') &&
          !line.includes('[web-port frame]') &&
          !line.includes('[web-port startup]') &&
          !line.includes('[web-port map]') &&
          !line.includes('[web-port image]') &&
          !line.includes('[web-port render]') &&
          !line.includes('[web-port backend]') &&
          !line.includes('[web-port lighting]') &&
          !line.includes('[web-port ambient]') &&
          !line.includes('[web-port memory]') &&
          !line.includes('[web loading label]') &&
          !line.includes('[web profile trace]') &&
          !line.includes('[BFG Engine Error]') &&
          !line.includes('[BFG Engine Abort]')
        ) return;
        queueRuntimeTrace(line);
      };
      window.addEventListener('error', event => {
        reportRuntimeTrace(['[BFG Engine Error]', String(event.error?.stack || event.message || 'Unhandled browser error').replace(/\r?\n/g, ' | ')]);
        if (/RuntimeError|worker sent an error|emscripten_proxy_async failed/.test(String(event.error?.stack || event.message))) showGameExit(true);
      });
      window.addEventListener('unhandledrejection', event => reportRuntimeTrace(['[BFG Engine Error]', String(event.reason)]));

      let finishWorkerReady: () => void = () => {};
      let failWorkerReady: (error: Error) => void = () => {};
      let workerReadyTimeout: number | undefined;
      const workerReady = new Promise<void>((resolve, reject) => {
        finishWorkerReady = resolve;
        failWorkerReady = reject;
        if (!workerHasReadySignal) {
          resolve();
        } else {
          workerReadyTimeout = window.setTimeout(() => reject(new Error('The game worker did not finish mounting assets and saved games. Reload to try again.')), 90_000);
        }
      });
      // Observe rejection even if the module factory throws synchronously.
      void workerReady.catch(() => {});
      const [engineInstance] = await Promise.all([engineModule.default({
        canvas,
        stagedFiles,
        browserDisplayState,
        mapStaging: {
          // Keep the handoff compatible while an older worker is still cached
          // during a development rebuild. New workers stage maps in memory.
          sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          manifestUrl: '/__local_game/manifest',
          fileUrl: '/__local_game/file',
          diagnosticsUrl: isDevelopmentBuild ? '/__local_game/trace' : undefined,
          cacheMode: browserPreferences.cacheMode,
          persistSaves: browserPreferences.persistSaves === 1,
        },
        arguments: engineArguments,
        onGameWorkerReady: () => finishWorkerReady(),
        print: (...values: unknown[]) => {
          // The worker prints a per-frame wait trace; forwarding it to the console and
          // the trace endpoint costs significant main-thread time during gameplay.
          const line = values.map((value) => String(value)).join(' ');
          if (!line.includes('[web-port thread] wait begin') && !line.includes('[web-port thread] wait end')) {
            console.log('[BFG Engine]', ...values);
            rememberBreadcrumb(line);
            reportRuntimeTrace(line.startsWith('ERROR:') ? ['[BFG Engine Error]', line] : values);
          }
        },
        printErr: (...values: unknown[]) => {
          const line = values.map((value) => String(value)).join(' ');
          const repeatedAbort = abortReported && (line.includes('Aborted(') || line.includes('null function or function signature mismatch'));
          if (!repeatedAbort) {
            console.error('[BFG Engine Error]', ...values);
            reportRuntimeTrace(['[BFG Engine Error]', ...values]);
          }
          if (/pthread exception:|worker sent an error|RuntimeError:|emscripten_proxy_async failed/.test(line)) {
            showGameExit(true);
          }
        },
        onAbort: (reason: unknown) => {
          failWorkerReady(new Error(String(reason)));
          console.error('[BFG Engine Abort]', reason);
          if (!abortReported) {
            abortReported = true;
            reportRuntimeTrace(['[BFG Engine Abort]', String(reason)]);
          }
          showGameExit(true);
        },
        onExit: (status: number) => {
          failWorkerReady(new Error(`The game exited before startup completed (${status}).`));
          showGameExit(status !== 0);
        },
      }), workerReady]).finally(() => {
        if (workerReadyTimeout !== undefined) window.clearTimeout(workerReadyTimeout);
      });

      if (gameHasExited) return;

      const reportRuntimeMemory = (phase: string) => {
        if (!isDevelopmentBuild) return;

        const browserPerformance = performance as Performance & {
          memory?: {
            usedJSHeapSize: number;
            totalJSHeapSize: number;
            jsHeapSizeLimit: number;
          };
        };
        const jsMemory = browserPerformance.memory;
        const snapshot = {
          phase,
          pageUptimeMs: Math.round(performance.now()),
          jsUsedHeapBytes: jsMemory?.usedJSHeapSize,
          jsTotalHeapBytes: jsMemory?.totalJSHeapSize,
          jsHeapLimitBytes: jsMemory?.jsHeapSizeLimit,
        };
        const line = `[web-port memory] ${JSON.stringify(snapshot)}`;
        console.info(line);
        reportRuntimeTrace([line]);
      };

      if (isDevelopmentBuild) {
        (window as unknown as { __DOOM3_BFG_ENGINE__?: unknown }).__DOOM3_BFG_ENGINE__ = engineInstance;
      }

      reportRuntimeMemory('engine-ready');
      const memorySampleTimer = isDevelopmentBuild
        ? window.setInterval(() => reportRuntimeMemory('periodic'), 10_000)
        : undefined;

      updateLoadingProgress(98, 'Starting D3BFG.js', 'Preparing the native game…');
      if (document.documentElement.dataset.doom3NativeReady === '1') finishNativeStartup();
      try {
        localStorage.setItem('doom3-engine-startup-seconds', String((performance.now() - engineStartupStartedAt) / 1000));
      } catch {
        // Startup timing is optional and never blocks game or save storage.
      }

      // IDBFS autoPersist saves each change. Do not start async syncfs during teardown:
      // browsers can stop the worker before Emscripten's proxied completion callback runs.
      window.addEventListener('pagehide', () => {
        flushRuntimeTrace();
        if (memorySampleTimer !== undefined) {
          window.clearInterval(memorySampleTimer);
          reportRuntimeMemory('pagehide');
        }
      });

      console.log('[DOOM 3 BFG Web] Engine initialization resolved.');
    } catch (err: unknown) {
      if (gameHasExited) return;
      console.error('[DOOM 3 BFG Web] Engine launch failed:', err);
      isEngineStarted = false;
      if (loadingOverlay) loadingOverlay.classList.remove('hidden');
      showLoadingError(`Engine crash during boot: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Fullscreen stays optional during development until the user accepts the game as complete.
  void engineLaunchFn();
}

// Start on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void main();
  });
} else {
  void main();
}
