const dbName = '/doom3_save_data';
const storeName = 'FILE_DATA';
let ledgerKey = 'doom3-save-sync-ledger-v1';
let savePrefix = dbName;
let syncingAccountId: string | undefined;
type Entry = { timestamp: Date; mode: number; contents?: Uint8Array };
type FileEntry = { path: string; mtimeMs: number; sha256: string; bytes: Uint8Array };
type RemoteManifest = { revision: string; files: { path: string; mtimeMs: number; size: number; sha256: string }[] };
let enabled = false;
let timer: number | undefined;
let uploading = false;
let dirty = false;
let lastUploadError: Error | null = null;

function allowed(path: string): boolean {
  return path.length <= 512 && !path.split('/').some(p => !p || p === '.' || p === '..') && !/[\\\x00-\x1f\x7f]/.test(path) &&
    (path.startsWith('base/savegame/') || ['base/doom3.cfg', 'base/config.cfg'].includes(path) || /^base\/doomclassic\/savegame\/.+\.dsg$/i.test(path));
}
function openSaves(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 21);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(storeName)
        ? request.transaction!.objectStore(storeName) : request.result.createObjectStore(storeName);
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other game tabs before changing save sync.'));
  });
}
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
async function localFiles(): Promise<FileEntry[]> {
  const db = await openSaves();
  const entries = await new Promise<{ path: string; entry: Entry }[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const result: { path: string; entry: Entry }[] = [];
    const request = tx.objectStore(storeName).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const relative = String(cursor.key).slice(savePrefix.length + 1);
      const entry = cursor.value as Entry;
      if (String(cursor.key).startsWith(savePrefix + '/') && (entry.mode & 0xf000) === 0x8000 && allowed(relative)) result.push({ path: relative, entry });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
  const files: FileEntry[] = [];
  for (const { path, entry } of entries) {
    const bytes = new Uint8Array(entry.contents || []);
    files.push({ path, bytes, sha256: await hash(bytes), mtimeMs: new Date(entry.timestamp).getTime() });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function fingerprint(files: { path: string; sha256: string }[]): string {
  return files.map(file => file.path + ':' + file.sha256).sort().join('\n');
}
async function manifest(): Promise<RemoteManifest> {
  const response = await fetch('/__browser_sync/manifest', { cache: 'no-store', headers: accountHeaders(), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Save sync is unavailable on this server. Your local saves are safe.');
  return response.json();
}
async function restore(remote: RemoteManifest): Promise<void> {
  const files: FileEntry[] = [];
  let total = 0;
  if (!Array.isArray(remote.files) || remote.files.length > 1024) throw new Error('Invalid save sync manifest.');
  for (const entry of remote.files) {
    if (!allowed(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024 || !Number.isFinite(entry.mtimeMs)) throw new Error('Invalid synced save file.');
    total += entry.size;
    if (total > 128 * 1024 * 1024) throw new Error('Synced saves exceed the transfer limit.');
    const response = await fetch('/__browser_sync/file?path=' + encodeURIComponent(entry.path), { cache: 'no-store', headers: accountHeaders() });
    if (!response.ok) throw new Error('Could not download a synced save. Local saves were kept.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== entry.size || await hash(bytes) !== entry.sha256) throw new Error('A synced save failed its integrity check.');
    files.push({ ...entry, bytes });
  }
  const db = await openSaves();
  // Recovery data is outside the mounted account prefix and is never uploaded
  // or loaded by the engine. Commit it atomically with the server replacement.
  const recoveryPrefix = '/doom3_save_recovery/' + (syncingAccountId || 'legacy') + '/' + crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) {
        if (String(item.key).startsWith(savePrefix + '/') && allowed(String(item.key).slice(savePrefix.length + 1))) {
          store.put(item.value, recoveryPrefix + '/' + String(item.key).slice(savePrefix.length + 1));
          item.delete();
        }
        item.continue();
        return;
      }
      // Queue replacements on cursor exhaustion; continue() makes result pending.
      const now = new Date();
      if (savePrefix !== dbName) {
        store.put({ mode: 0x41ff, timestamp: now }, dbName + '/accounts');
        store.put({ mode: 0x41ff, timestamp: now }, savePrefix);
      }
      for (const file of files) {
        const parts = file.path.split('/');
        let dir = savePrefix;
        for (const part of parts.slice(0, -1)) { dir += '/' + part; store.put({ mode: 0x41ff, timestamp: now }, dir); }
        store.put({ mode: 0x81b6, timestamp: new Date(file.mtimeMs), contents: file.bytes }, savePrefix + '/' + file.path);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Synced saves could not be stored.'));
  }).finally(() => db.close());
}
function saveLedger(remote: RemoteManifest, local: { path: string; sha256: string }[]): void {
  localStorage.setItem(ledgerKey, JSON.stringify({ revision: remote.revision, fingerprint: fingerprint(local) }));
}
function readLedger(): { revision: string; fingerprint: string } | null {
  try { return JSON.parse(localStorage.getItem(ledgerKey) || 'null'); } catch { return null; }
}
export function accountSavePath(id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid account save identifier.');
  return dbName + '/accounts/' + id;
}
export async function prepareSaveSync(syncEnabled: boolean, accountId?: string, importLegacy = false): Promise<void> {
  syncingAccountId = accountId;
  savePrefix = accountId ? accountSavePath(accountId) : dbName;
  ledgerKey = 'doom3-save-sync-ledger-v1' + (accountId ? ':' + accountId : '');
  enabled = false;
  if (!syncEnabled) return;
  const remote = await manifest();
  const local = await localFiles();
  // The online snapshot is authoritative on every launch, even if empty or
  // this browser has unsynced changes. Never upload a stale browser at startup.
  void importLegacy;
  if (fingerprint(local) !== fingerprint(remote.files)) {
    await restore(remote);
    localStorage.removeItem('doom3-profile-name-v1');
  }
  saveLedger(remote, remote.files);
  enabled = true;
}
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
async function upload(): Promise<void> {
  if (!enabled) return;
  if (uploading) { dirty = true; return; }
  uploading = true;
  lastUploadError = null;
  try {
    const files = await localFiles();
    const ledger = readLedger();
    if (ledger?.fingerprint === fingerprint(files)) return;
    if (files.length > 1024 || files.some(file => file.bytes.length > 64 * 1024 * 1024) || files.reduce((sum, file) => sum + file.bytes.length, 0) > 128 * 1024 * 1024) throw new Error('Save sync limit exceeded. Local saves are preserved.');
    const response = await fetch('/__browser_sync/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...accountHeaders() }, cache: 'no-store',
      body: JSON.stringify({ baseRevision: ledger?.revision || '', files: files.map(file => ({ path: file.path, mtimeMs: file.mtimeMs, sha256: file.sha256, base64: base64(file.bytes) })) }),
    });
    if (response.status === 409) throw new Error('Another browser updated your synced saves. Local saves were kept; restart before syncing again.');
    if (!response.ok) throw new Error('Save sync upload failed. Local saves are preserved.');
    const remote = await response.json();
    saveLedger(remote, files);
    document.dispatchEvent(new CustomEvent('doom3-sync-status', { detail: 'Saves synced' }));
  } catch (error) {
    lastUploadError = error instanceof Error ? error : new Error('Save sync failed.');
    document.dispatchEvent(new CustomEvent('doom3-sync-status', { detail: error instanceof Error ? error.message : 'Save sync failed.' }));
  } finally {
    uploading = false;
    if (dirty) { dirty = false; schedule(); }
  }
}
function schedule(): void {
  if (!enabled) return;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => { timer = undefined; void upload(); }, 500);
}
document.addEventListener('doom3-saves-persisted', schedule);
document.addEventListener('visibilitychange', () => { if (document.hidden) void upload(); });
export async function flushSaveSync(): Promise<void> {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  while (uploading) await new Promise(resolve => window.setTimeout(resolve, 25));
  await upload();
  if (lastUploadError) throw lastUploadError;
}
export function setSaveSyncEnabled(value: boolean): void { enabled = value; }

function accountHeaders(): Record<string, string> { return syncingAccountId ? { 'X-DOOM-Account': syncingAccountId } : {}; }

export async function applyPendingAccountRemoval(): Promise<void> {
  const raw = localStorage.getItem('doom3-deleted-account-v1');
  if (!raw) return;
  const value = JSON.parse(raw) as { id: string; owner: boolean };
  const prefix = accountSavePath(value.id);
  const db = await openSaves();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName), cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result; if (!item) return;
      const key = String(item.key);
      if (key === prefix || key.startsWith(prefix + '/') || (value.owner && (key === dbName + '/base' || key.startsWith(dbName + '/base/')))) item.delete();
      item.continue();
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
  localStorage.removeItem('doom3-save-sync-ledger-v1:' + value.id);
  localStorage.removeItem('doom3-deleted-account-v1');
}
