import { MultiplayerClient, type MultiplayerKind } from './multiplayerClient';
import { queueNativeNotice } from './nativeNotices';

/**
 * Copies a lobby invite code. The Clipboard API needs a secure context and a
 * user gesture; both are present because the press comes from the native menu.
 * The hidden-textarea fallback covers browsers that only expose the legacy API.
 */
async function copyInviteCode(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

/** Text and actions for the original SWF menus. No DOM interface is created. */
export function createNativeMultiplayerBridge(client: MultiplayerClient, changed: () => void) {
  let privateChoice = false;
  let coopSavePicker = false;
  let coopCampaignPicker = 0;
  let coopConnecting = false;
  let localError = '';
  let localErrorCode = '';
  let listKind: MultiplayerKind = 'versus';
  let revision = 0;
  let scanningUntil = 0;
  let operationEpoch = 0;
  const notify = () => { if (!client.state.lobby) coopConnecting = false; ++revision; changed(); };
  const report = (message: string, code = 'BAD_REQUEST') => {
    localError = message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
    localErrorCode = code;
    notify();
  };
  const clearLocalError = () => { localError = ''; localErrorCode = ''; };
  const connected = (action: () => void) => {
    const epoch = ++operationEpoch;
    clearLocalError();
    void client.connect().then(() => { if (epoch === operationEpoch) action(); }).catch(error => {
      if (epoch === operationEpoch) report(String(error?.message || 'Could not connect to the multiplayer service.'), 'CONNECTION_FAILED');
    });
  };
  const errors: Record<string, string> = {
    FULL: 'This game is full.', NOT_FOUND: 'That lobby or private code is no longer available.',
    HOST_LEFT: 'The host left the lobby.', HOST_DISCONNECTED: 'The host disconnected.',
    MATCH_ENDED_NO_OPPONENTS: 'Match ended: no opponents remain.',
    WAITING_FOR_PLAYERS: 'At least two players must be in the lobby before the host can start.',
    LIST_TIMEOUT: 'The room list took too long to arrive. Press Refresh to try again.',
    BAD_REQUEST: 'The lobby request could not be completed.',
  };
  return {
    getNumber(key: string): number {
      const state = client.state;
      switch (key) {
        case 'mpStatus': return state.status === 'connected' ? 2 : state.status === 'connecting' ? 1 : 0;
        case 'mpRevision': return revision;
        case 'mpScanning': return state.status !== 'disconnected' && !state.error && (state.listing || Date.now() < scanningUntil) ? 1 : 0;
        case 'mpRoomKind': return state.lobby?.kind === 'coop' ? 1 : 0;
        case 'mpPeerId': return state.peerId ?? 0;
        case 'mpHostPeerId': return state.lobby?.hostPeerId ?? 0;
        case 'mpLobbyCount': return state.lobbies.filter(room => room.kind === listKind).length;
        case 'mpInRoom': return state.lobby ? 1 : 0;
        case 'mpRoomPlayers': return state.lobby?.players ?? 0;
        case 'mpRoomMax': return state.lobby?.maxPlayers ?? 0;
        case 'mpRoomLives': return state.lobby?.coopLives ?? 3;
        case 'mpHostLoading': return state.lobby?.hostLoading ? 1 : 0;
        case 'mpCoopConnecting': return coopConnecting && state.lobby?.kind === 'coop' && !state.error && !localErrorCode ? 1 : 0;
        case 'mpIsHost': return state.lobby?.hostPeerId === state.peerId && state.peerId !== null ? 1 : 0;
        case 'mpPrivate': return state.lobby ? Number(state.lobby.private) : Number(privateChoice);
        case 'mpStarted': return state.started ? 1 : 0;
        case 'mpErrorCode': return localErrorCode || state.error ? 1 : 0;
        case 'mpCoopSavePicker': return coopSavePicker ? 1 : 0;
        case 'mpCoopCampaignPicker': return coopCampaignPicker ? 1 : 0;
        case 'mpCoopDevPicker': return coopCampaignPicker === 2 ? 1 : 0;
        case 'mpCanReconnect': return client.canReconnect ? 1 : 0;
        case 'mpReconnectKind': return client.resumableGame?.kind === 'coop' ? 1 : 0;
      }
      return 0;
    },
    getText(key: string): string {
      const state = client.state;
      const match = /^mpLobby(Name|Id|Occupancy)(\d{1,3})$/.exec(key);
      if (match) {
        const room = state.lobbies.filter(room => room.kind === listKind)[Number(match[2])];
        if (!room) return '';
        return match[1] === 'Name' ? room.name : match[1] === 'Id' ? room.id : `${room.players}/${room.maxPlayers}`;
      }
      const peer = /^mpRoster(\d)$/.exec(key);
      if (peer) return state.roster[Number(peer[1])]?.name ?? '';
      switch (key) {
        case 'mpRoomId': return state.lobby?.id ?? '';
        case 'mpRoomKind': return state.lobby?.kind ?? '';
        case 'mpRoomMap': return state.lobby?.map ?? '';
        case 'mpRoomMode': return state.lobby?.mode ?? '';
        case 'mpRoomName': return state.lobby?.name ?? '';
        case 'mpPrivateCode': return state.privateCode ?? '';
        case 'mpReconnectName': {
          const game = client.resumableGame;
          if (!game) return '';
          return game.kind === 'coop' ? `${game.name} (co-op)` : game.name;
        }
        case 'mpError': return localErrorCode || state.error || '';
        case 'mpErrorMessage': return localError || (state.error === 'WAITING_FOR_PLAYERS'
          ? errors.WAITING_FOR_PLAYERS
          : state.errorDetail || errors[state.error ?? ''] || state.error || '');
      }
      return '';
    },
    action(command: string): void {
      if (!command.startsWith('mp')) return;
      if (command.length > 512) { report('Multiplayer command is too long.'); return; }
      notify();
      const [name, ...parts] = command.split('|');
      clearLocalError();
      if (['mpCancelPending', 'mpLeave', 'mpDisconnect', 'mpConnectionLost', 'mpNativeError'].includes(name)) ++operationEpoch;
      if (name === 'mpCancelPending') {
        if (!client.state.lobby) client.disconnect();
        scanningUntil = 0; notify(); return;
      }
      if (name === 'mpConnect' && parts.length === 0) connected(() => {});
      else if (name === 'mpListVersus' || name === 'mpListCoop') {
        if (parts.length !== 0) { report('Room list command has unexpected fields.'); return; }
        listKind = name === 'mpListCoop' ? 'coop' : 'versus';
        scanningUntil = Date.now() + 650;
        connected(() => { client.list(listKind); });
      } else if (name === 'mpTogglePrivacy') {
        if (parts.length !== 0) { report('Privacy command has unexpected fields.'); return; }
        if (client.state.lobby) client.privacy(!client.state.lobby.private);
        else { privateChoice = !privateChoice; changed(); }
      } else if (name === 'mpCreate') {
        if (parts.length < 6 || parts.length > 8) { report('Create command must include kind, name, mode, player count, privacy, map, and optional co-op lives and friendly fire.'); return; }
        const [kind, roomName, mode, count, privacy, map] = parts;
        const coopLives = parts[6] ?? '3';
        const friendlyFire = parts[7] ?? '0';
        if (friendlyFire !== '0' && friendlyFire !== '1') { report('Friendly Fire must be enabled or disabled.'); return; }
        if (kind !== 'coop' && kind !== 'versus') { report('Lobby kind must be versus or coop.'); return; }
        if (!roomName.trim() || roomName.trim().length > 48 || /[\u0000-\u001f\u007f]/.test(roomName)) {
          report('Lobby name must be 1–48 characters and contain no control characters.'); return;
        }
        if (kind === 'coop' ? mode !== 'coop' : !['deathmatch', 'tourney', 'team_deathmatch', 'lastman', 'ctf'].includes(mode)) {
          report(kind === 'coop' ? 'Co-op mode must be coop.' : 'Choose a supported versus mode.'); return;
        }
        if (!/^[0-9]+$/.test(count) || Number(count) < 2 || Number(count) > (kind === 'coop' ? 2 : 8)) {
          report(kind === 'coop' ? 'Co-op lobbies must have exactly two player slots.' : 'Versus lobbies must have 2–8 player slots.'); return;
        }
        if (privacy !== '0' && privacy !== '1') { report('Privacy must be public or private.'); return; }
        if (kind === 'coop' && (!/^[0-9]+$/.test(coopLives) || Number(coopLives) < 1 || Number(coopLives) > 10)) {
          report('Co-op lives must be an integer from 1 to 10.'); return;
        }
        if (map && !/^[a-z0-9_]{1,64}$/i.test(map)) { report('Map must be a basename using letters, numbers, and underscores.'); return; }
        connected(() => { client.create({ name: roomName, kind: kind as MultiplayerKind, mode,
          maxPlayers: Number(count), private: privacy === '1', ...(kind === 'coop' ? { coopLives: Number(coopLives), friendlyFire: friendlyFire === '1' } : {}),
          ...(map ? { map } : {}) }); });
      } else if (name === 'mpJoin') {
        if (parts.length !== 1 || !/^[a-z0-9_-]{1,64}$/i.test(parts[0])) { report('Lobby ID must contain 1–64 letters, numbers, dashes, or underscores.'); return; }
        connected(() => { client.join({ lobbyId: parts[0] }); });
      } else if (name === 'mpCode') {
        if (parts.length !== 1 || !/^[a-z0-9_-]{1,64}$/i.test(parts[0])) { report('Private code must contain 1–64 letters, numbers, dashes, or underscores.'); return; }
        connected(() => { client.join({ code: parts[0] }); });
      } else if (name === 'mpLeave') {
        if (parts.length !== 0) { report('Leave command has unexpected fields.'); return; }
        client.clearResumableGame();
        client.leave(); coopSavePicker = false; coopCampaignPicker = 0; clearLocalError(); changed();
      } else if (name === 'mpValidateResume') {
        if (client.resumableGame) connected(() => { client.validateResumable(); });
      } else if (name === 'mpBeginCoopConnect') {
        if (client.state.lobby?.kind === 'coop' && client.state.lobby.hostPeerId === client.state.peerId) {
          coopConnecting = true; coopSavePicker = false; coopCampaignPicker = 0; notify();
        }
      } else if (name === 'mpHostLoading' || name === 'mpHostReady') {
        const lobby = client.state.lobby;
        if (lobby?.kind === 'coop' && lobby.hostPeerId === client.state.peerId) {
          if (name === 'mpHostReady') coopConnecting = false;
          client.setHostLoading(name === 'mpHostLoading');
        }
      } else if (name === 'mpReconnect') {
        if (parts.length !== 0) { report('Reconnect command has unexpected fields.'); return; }
        if (!client.canReconnect) { report('There is no game left to reconnect to.', 'NOT_FOUND'); return; }
        connected(() => { client.reconnect(); });
      } else if (name === 'mpCopyCode') {
        if (parts.length !== 0) { report('Copy command has unexpected fields.'); return; }
        const code = client.state.lobby?.private ? (client.state.privateCode ?? '') : '';
        if (!code) { report('This lobby has no invite code.', 'NOT_FOUND'); return; }
        void copyInviteCode(code).then(copied => {
          if (copied) queueNativeNotice('Copied to clipboard');
          else report('Could not copy the invite code to the clipboard.');
        });
      } else if (name === 'mpDisconnect') {
        if (parts.length !== 0) { report('Disconnect command has unexpected fields.'); return; }
        client.disconnect(); coopSavePicker = false; coopCampaignPicker = 0; clearLocalError();
      } else if (name === 'mpOpenCoopCampaignPicker' || name === 'mpOpenCoopDevPicker' || name === 'mpCloseCoopCampaignPicker') {
        const lobby = client.state.lobby;
        if (parts.length || !lobby || lobby.kind !== 'coop' || lobby.hostPeerId !== client.state.peerId) {
          report('Only the co-op host can choose a campaign.'); return;
        }
        coopCampaignPicker = name === 'mpCloseCoopCampaignPicker' ? 0 : name === 'mpOpenCoopDevPicker' ? 2 : 1;
        changed();
      } else if (name === 'mpOpenCoopSavePicker' || name === 'mpCloseCoopSavePicker') {
        if (parts.length !== 0) { report('Co-op save-picker command has unexpected fields.'); return; }
        const lobby = client.state.lobby;
        if (!lobby || lobby.kind !== 'coop' || lobby.hostPeerId !== client.state.peerId || client.state.peerId === null) {
          coopSavePicker = false;
          report('Only the co-op host can choose a campaign save.');
          return;
        }
        coopSavePicker = name === 'mpOpenCoopSavePicker';
        clearLocalError();
        changed();
      }
      else if (name === 'mpStart') {
        if (parts.length !== 0) { report('Start command has unexpected fields.'); return; }
        client.start();
      } else if (name === 'mpClearError') {
        if (parts.length !== 0) { report('Clear-error command has unexpected fields.'); return; }
        clearLocalError(); client.clearError();
      } else if (name === 'mpConnectionLost') {
        // The native connection was lost. Drop the dead room but keep the
        // resumable snapshot so "Reconnect to game" can bring the match back;
        // the shell returns to the main menu on its own because mpInRoom clears.
        client.disconnect(); coopSavePicker = false; coopCampaignPicker = 0; clearLocalError();
      } else if (name === 'mpNativeError' && parts.length === 1) {
        // The native connection has failed; retaining a started relay room
        // leaves the menu trapped in a session that cannot be resumed.
        client.leave(); coopSavePicker = false; coopCampaignPicker = 0;
        report(parts[0], 'NATIVE_ERROR');
      }
      else report('Unknown or malformed multiplayer command.');
    },
    notify,
  };
}
