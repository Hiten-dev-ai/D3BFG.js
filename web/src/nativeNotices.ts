/**
 * One-shot messages that the native (SWF) menus must show in the engine's own
 * confirmation dialog. They live in the page, not in the engine, because the
 * conditions that produce them (asset downloads, network reachability) are
 * browser-side.
 *
 * The native shell polls these through the browser bridge every few frames.
 */
const MAX_NOTICES = 4;
const MAX_NOTICE_LENGTH = 200;

const pending: string[] = [];
const mainMenuOnly = new Set<string>();
let announcedOffline = false;
// Marks whether the current boot started without a network connection. Only an
// offline start should produce the "Connected to internet" confirmation.
let bootedOffline = false;
let announcedReconnect = false;

function sanitize(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTICE_LENGTH);
}

export function queueNativeNotice(message: string, atMainMenuOnly = false): void {
  const text = sanitize(message);
  if (!text) return;
  if (pending.includes(text)) return;
  if (atMainMenuOnly) mainMenuOnly.add(text);
  pending.push(text);
  while (pending.length > MAX_NOTICES) mainMenuOnly.delete(pending.shift()!);
}

export function nativeNoticeMainMenuOnly(): number { return mainMenuOnly.has(pending[0]) ? 1 : 0; }

export function nativeNoticeCount(): number {
  return pending.length;
}

export function peekNativeNotice(): string {
  return pending[0] ?? '';
}

export function dismissNativeNotice(): void {
  mainMenuOnly.delete(pending.shift()!);
}

export function markBootedOffline(offline: boolean): void {
  bootedOffline = offline;
  if (offline && !announcedOffline) {
    announcedOffline = true;
    queueNativeNotice('Unable to connect to the server. Cached single-player play is available; online features are unavailable.', true);
  }
  // A fresh online boot has nothing to announce later.
  if (!offline) announcedReconnect = true;
}

export function isBootedOffline(): boolean {
  return bootedOffline;
}

/**
 * Called on every `online` event. Announces the regained connection once per
 * offline boot, then leaves the queue alone so the engine can show it.
 */
export function announceReconnected(online: boolean): void {
  if (!online || !bootedOffline || announcedReconnect) return;
  announcedReconnect = true;
  queueNativeNotice('Connected to internet.');
}
