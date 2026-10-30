import { initializeAccountUI, getCurrentAccount, showAccountLogin, type AccountUser } from './accountUI';
import { markBootedOffline } from './nativeNotices';
import { assertOfflinePlaybackAllowed } from './offlinePolicy';

export async function requirePrivateAccess(): Promise<AccountUser | null> {
  const cachedAccount = getCurrentAccount();
  let response: Response;
  try {
    response = await fetch('/__session/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
  } catch {
    if (import.meta.env.DEV) return null;
    // The private server is unreachable. A device that was already signed in can
    // still open the menu and play from cached data; the account check simply
    // runs again the next time the network is available.
    if (cachedAccount) {
      assertOfflinePlaybackAllowed();
      console.warn('[DOOM 3 BFG Web] Offline: using the cached account for this session.');
      markBootedOffline(true);
      return cachedAccount;
    }
    throw new Error('The private server could not check this device. Please try again.');
  }
  const jsonResponse = (response.headers.get('content-type') || '').includes('application/json');
  // The local Vite server has no private session endpoint; keep its existing development bypass.
  if (import.meta.env.DEV && (!response.ok || !jsonResponse)) return null;
  // A gateway/server error is not a rejection of this device: keep the cached
  // session usable instead of locking the player out of the menu.
  if (!response.ok && response.status >= 500 && cachedAccount) {
    assertOfflinePlaybackAllowed();
    console.warn('[DOOM 3 BFG Web] The private server is unavailable; using the cached account for this session.');
    markBootedOffline(true);
    return cachedAccount;
  }
  if (!response.ok) throw new Error('The private server could not check this device. Please try again.');
  const state = await response.json() as { authenticated: boolean; required: boolean; user?: AccountUser };
  if (!state.required && !state.authenticated) return null;
  if (state.authenticated) {
    initializeAccountUI(state);
    return state.user || null;
  }
  return await showAccountLogin();
}

export { getCurrentAccount, openProfile, openDeleteAccount, setCurrentAccount, logoutAccount } from './accountUI';
export type { AccountUser } from './accountUI';
