/** Last-known operator policy. This is a cooperative browser setting, NOT DRM:
 * a device cannot learn a server policy change while disconnected. */
const policyKey = 'doom3-offline-playback-allowed-v1';
let allowed = true;
try { allowed = localStorage.getItem(policyKey) !== 'false'; } catch { /* Default: allowed. */ }

export function setOfflinePlaybackAllowed(value: boolean): void {
  allowed = value;
  try { localStorage.setItem(policyKey, String(value)); } catch { /* Current boot still enforces it. */ }
}

export function assertOfflinePlaybackAllowed(): void {
  if (!allowed) throw new Error('Offline playback is disabled by this server. Connect to the server and reload to play.');
}
