export type MultiplayerKind = 'versus' | 'coop';
export type MultiplayerStatus = 'disconnected' | 'connecting' | 'connected';

export interface MultiplayerLobby {
  hostLoading?: boolean;
  friendlyFire?: boolean;
  id: string;
  name: string;
  kind: MultiplayerKind;
  players: number;
  maxPlayers: number;
  private: boolean;
  hostPeerId: number;
  started: boolean;
  mode: string;
  coopLives?: number;
  map?: string;
}

export interface MultiplayerPeer {
  peerId: number;
  name: string;
}

export interface MultiplayerState {
  status: MultiplayerStatus;
  peerId: number | null;
  lobbies: MultiplayerLobby[];
  lobby: MultiplayerLobby | null;
  roster: MultiplayerPeer[];
  privateCode: string | null;
  error: string | null;
  errorDetail: string | null;
  started: boolean;
  listing: boolean;
}

export interface ReceivedPacket {
  peerId: number;
  port: number;
  sourcePort: number;
  data: Uint8Array;
}

export interface CreateLobbyRequest {
  friendlyFire?: boolean;
  name: string;
  kind: MultiplayerKind;
  private: boolean;
  maxPlayers: number;
  mode: string;
  coopLives?: number;
  map?: string;
}

export interface JoinLobbyRequest {
  lobbyId?: string;
  code?: string;
  name?: string;
}

// Enough state to rejoin a match that was already running when the transport
// dropped. Only a non-host peer can be restored: a host that leaves destroys
// the room for everyone.
export interface ResumableGame {
  lobbyId: string;
  kind: MultiplayerKind;
  name: string;
  map: string;
  mode: string;
  hostPeerId: number;
  peerId: number;
}

const ROUTE = '/__multiplayer';
const MAX_CONTROL_BYTES = 64 * 1024;
// idPacketProcessor::MAX_FINAL_PACKET_SIZE is the transport's hard packet
// ceiling; packets above this can never be consumed by native idUDP.
const MAX_PACKET_BYTES = 1_200;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const MAX_QUEUED_PACKETS = 256;
const MAX_QUEUED_PACKET_BYTES = 2 * 1024 * 1024;
const MAX_LOBBIES = 128;
const MAX_ROSTER = 8;
const emptyState = (): MultiplayerState => ({
  status: 'disconnected',
  peerId: null,
  lobbies: [],
  lobby: null,
  roster: [],
  privateCode: null,
  error: null,
  errorDetail: null,
  started: false,
  listing: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPeerId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function isLobby(value: unknown): value is MultiplayerLobby {
  if (!isRecord(value)) return false;
  const validMode = value.kind === 'coop' ? value.mode === 'coop' :
    value.kind === 'versus' && typeof value.mode === 'string' && ['deathmatch', 'tourney', 'team_deathmatch', 'lastman', 'ctf'].includes(value.mode);
  return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 48 &&
    (value.kind === 'versus' || value.kind === 'coop') &&
    Number.isInteger(value.players) && Number(value.players) >= 1 && Number(value.players) <= 8 &&
    Number.isInteger(value.maxPlayers) && Number(value.maxPlayers) >= 2 && Number(value.maxPlayers) <= 8 &&
    Number(value.players) <= Number(value.maxPlayers) && (value.kind !== 'coop' || value.maxPlayers === 2) && validMode &&
    typeof value.private === 'boolean' && isPeerId(value.hostPeerId) && typeof value.started === 'boolean' &&
    (value.coopLives === undefined || (value.kind === 'coop' && Number.isInteger(value.coopLives) &&
      Number(value.coopLives) >= 1 && Number(value.coopLives) <= 10)) &&
    (value.hostLoading === undefined || (value.kind === 'coop' && typeof value.hostLoading === 'boolean')) &&
    (value.friendlyFire === undefined || (value.kind === 'coop' && typeof value.friendlyFire === 'boolean')) &&
    (value.map === undefined || (typeof value.map === 'string' && /^[a-z0-9_]{1,64}$/i.test(value.map)));
}

function isRoster(value: unknown): value is MultiplayerPeer[] {
  return Array.isArray(value) && value.length <= MAX_ROSTER && value.every((peer) =>
    isRecord(peer) && isPeerId(peer.peerId) && typeof peer.name === 'string' && peer.name.length > 0 && peer.name.length <= 48);
}

function isLobbyList(value: unknown): value is MultiplayerLobby[] {
  return Array.isArray(value) && value.length <= MAX_LOBBIES && value.every(isLobby);
}

function controlBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class MultiplayerClient {
  private currentState: MultiplayerState = emptyState();
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private pendingPeerId: number | null = null;
  private transportVersion: 1 | 2 = 1;
  private packetQueue: ReceivedPacket[] = [];
  private queuedPacketBytes = 0;
  private packetCounter: Int32Array | null = null;
  private disposed = false;
  private lastOperation = '';
  // Set once a match has started and kept across an unexpected transport loss so
  // the multiplayer page can offer "Reconnect to game".
  private resumable: ResumableGame | null = null;
  private resumeConfirmed = false;
  private resumingGame = false;
  private listingTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onChange: (state: Readonly<MultiplayerState>) => void;

  constructor(onChange: (state: Readonly<MultiplayerState>) => void = () => {}) {
    this.onChange = onChange;
  }

  get state(): Readonly<MultiplayerState> {
    return this.currentState;
  }

  setPacketCounter(counter: Int32Array): void {
    this.packetCounter = counter.length >= 9 ? counter : null;
    this.publishPacketCount();
  }

  private publishPacketCount(): void {
    if (this.packetCounter) Atomics.store(this.packetCounter, 8, this.packetQueue.length);
  }

  get resumableGame(): Readonly<ResumableGame> | null {
    return this.resumable;
  }

  get canReconnect(): boolean {
    return this.resumeConfirmed && this.resumable !== null && this.currentState.lobby === null &&
      this.resumable.hostPeerId !== this.resumable.peerId;
  }

  clearResumableGame(): void {
    this.resumable = null;
    this.resumeConfirmed = false;
  }

  validateResumable(): boolean {
    return this.resumable !== null && this.sendControl({ type: 'probe', lobbyId: this.resumable.lobbyId });
  }

  setHostLoading(loading: boolean): boolean {
    return this.sendControl({ type: 'loading', loading });
  }

  // Rejoin the match captured by rememberResumable(). Unlike join() this keeps
  // the snapshot, so a failed retry can still be attempted again.
  reconnect(): boolean {
    if (!this.canReconnect || !this.resumable) return false;
    const sent = this.sendControl({ type: 'join', lobbyId: this.resumable.lobbyId });
    if (sent) {
      this.lastOperation = 'join';
      this.resumingGame = true;
    }
    return sent;
  }

  private rememberResumable(): void {
    const lobby = this.currentState.lobby;
    const peerId = this.currentState.peerId;
    if (!lobby || !lobby.started || peerId === null || lobby.hostPeerId === peerId) return;
    this.resumable = {
      lobbyId: lobby.id,
      kind: lobby.kind,
      name: lobby.name,
      map: lobby.map ?? '',
      mode: lobby.mode,
      hostPeerId: lobby.hostPeerId,
      peerId,
    };
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Multiplayer client has been disposed'));
    if (this.currentState.status === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.pendingPeerId = null;
    this.transportVersion = 1;
    this.update({ ...emptyState(), status: 'connecting' });
    const promise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectPromise = promise;

    try {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}${ROUTE}`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.connectTimer = setTimeout(() => {
        if (this.socket !== socket || this.currentState.status !== 'connecting') return;
        this.rejectPendingConnect(new Error('Multiplayer connection timed out. Please try again.'));
        this.disconnect();
        this.update({ error: 'CONNECTION_TIMEOUT', errorDetail: 'Multiplayer connection timed out. Please try again.' });
      }, 8000);
      socket.onmessage = (event: MessageEvent) => {
        if (this.socket === socket) this.handleMessage(event.data);
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        const error = new Error('Multiplayer connection failed');
        this.update({ error: error.message });
        this.rejectPendingConnect(error);
        try { socket.close(); } catch { /* The close event normally performs cleanup. */ }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.resumeConfirmed = false;
        this.lastOperation = '';
        this.clearListingTimeout();
        const wasConnecting = this.currentState.status === 'connecting';
        this.update({ status: 'disconnected', peerId: null, lobby: null, roster: [], privateCode: null, started: false,
          listing: false, error: null, errorDetail: null });
        this.pendingPeerId = null;
        this.transportVersion = 1;
        this.clearPacketQueue();
        if (wasConnecting) this.rejectPendingConnect(new Error('Multiplayer connection closed before welcome'));
        this.connectPromise = null;
      };
    } catch (error) {
      this.update({ status: 'disconnected', error: error instanceof Error ? error.message : 'Multiplayer connection failed' });
      this.rejectPendingConnect(error instanceof Error ? error : new Error('Multiplayer connection failed'));
      this.connectPromise = null;
    }
    return promise;
  }

  list(kind?: MultiplayerKind): boolean {
    if (kind !== undefined && kind !== 'versus' && kind !== 'coop') {
      return this.invalidRequest('Lobby kind must be versus or coop.');
    }
    const sent = this.sendControl(kind === undefined ? { type: 'list' } : { type: 'list', kind });
    this.update({ listing: sent });
    this.armListingTimeout();
    return sent;
  }

  // A slow link can leave the room list request unanswered for a long time.
  // The menu must not keep showing "Scanning rooms..." (or stay on a spinner)
  // waiting for it, so drop the flag locally and let the player retry.
  private armListingTimeout(): void {
    if (this.listingTimer !== undefined) clearTimeout(this.listingTimer);
    if (!this.currentState.listing) { this.listingTimer = undefined; return; }
    this.listingTimer = setTimeout(() => {
      this.listingTimer = undefined;
      if (!this.currentState.listing) return;
      this.update({ listing: false, error: 'LIST_TIMEOUT', errorDetail: 'The room list took too long to arrive. Press Refresh to try again.' });
    }, 6000);
  }

  private clearListingTimeout(): void {
    if (this.listingTimer !== undefined) clearTimeout(this.listingTimer);
    this.listingTimer = undefined;
  }

  create(request: CreateLobbyRequest): boolean {
    if (request.friendlyFire !== undefined && (request.kind !== 'coop' || typeof request.friendlyFire !== 'boolean')) {
      return this.invalidRequest('Friendly Fire must be a co-op boolean setting.');
    }
    if (!this.validName(request.name)) return this.invalidRequest('Lobby name must be 1–48 characters and contain no control characters.');
    if (request.kind !== 'versus' && request.kind !== 'coop') return this.invalidRequest('Lobby kind must be versus or coop.');
    if (typeof request.private !== 'boolean') return this.invalidRequest('Privacy must be public or private.');
    if (!Number.isInteger(request.maxPlayers) || request.maxPlayers < 2 || request.maxPlayers > (request.kind === 'coop' ? 2 : 8)) {
      return this.invalidRequest(request.kind === 'coop' ? 'Co-op lobbies must have exactly two player slots.' : 'Versus lobbies must have 2–8 player slots.');
    }
    if (request.kind === 'coop' ? request.mode !== 'coop' : !['deathmatch', 'tourney', 'team_deathmatch', 'lastman', 'ctf'].includes(request.mode)) {
      return this.invalidRequest(request.kind === 'coop' ? 'Co-op mode must be coop.' : 'Choose a supported versus mode.');
    }
    if ((request.coopLives !== undefined && (request.kind !== 'coop' || !Number.isInteger(request.coopLives) ||
      request.coopLives < 1 || request.coopLives > 10))) {
      return this.invalidRequest('Co-op lives must be an integer from 1 to 10.');
    }
    if (request.map !== undefined && (typeof request.map !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(request.map))) {
      return this.invalidRequest('Map must be a basename using letters, numbers, and underscores.');
    }
    this.resumable = null;
    return this.sendControl({ type: 'create', ...request });
  }

  join(request: JoinLobbyRequest): boolean {
    const hasLobbyId = typeof request.lobbyId === 'string' && request.lobbyId.length > 0 && request.lobbyId.length <= 64;
    const hasCode = typeof request.code === 'string' && request.code.length > 0 && request.code.length <= 64;
    if (hasLobbyId === hasCode) return this.invalidRequest('Join requires exactly one lobby ID or private code.');
    if (request.lobbyId !== undefined && !hasLobbyId) return this.invalidRequest('Lobby ID must be 1–64 characters.');
    if (request.code !== undefined && !hasCode) return this.invalidRequest('Private code must be 1–64 characters.');
    if (request.name !== undefined && !this.validName(request.name)) return this.invalidRequest('Player name must be 1–48 characters and contain no control characters.');
    this.resumable = null;
    return this.sendControl({ type: 'join', ...(hasLobbyId ? { lobbyId: request.lobbyId } : { code: request.code }),
      ...(request.name === undefined ? {} : { name: request.name.trim() }) });
  }

  privacy(isPrivate: boolean): boolean {
    return typeof isPrivate === 'boolean' && this.sendControl({ type: 'privacy', private: isPrivate });
  }

  start(): boolean {
    return this.sendControl({ type: 'start' });
  }

  leave(): boolean {
    const sent = this.sendControl({ type: 'leave' });
    this.clearRoomState();
    this.clearPacketQueue();
    return sent;
  }

  disconnect(): void {
    this.resumeConfirmed = false;
    const socket = this.socket;
    this.socket = null;
    this.lastOperation = '';
    this.clearListingTimeout();
    this.pendingPeerId = null;
    this.transportVersion = 1;
    this.rejectPendingConnect(new Error('Multiplayer connection disconnected'));
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* The client state is already detached. */ }
    }
    this.clearPacketQueue();
    this.update({ ...emptyState() });
  }

  sendPacket(peerId: number, destinationPort: number, sourcePort: number, data: Uint8Array): boolean {
    const socket = this.socket;
    if (!this.hasValidRoom() || !socket || socket.readyState !== WebSocket.OPEN ||
      !Number.isInteger(peerId) || peerId < 0 || peerId > 0xffff_ffff ||
      !Number.isInteger(destinationPort) || destinationPort <= 0 || destinationPort > 0xffff ||
      !Number.isInteger(sourcePort) || sourcePort <= 0 || sourcePort > 0xffff ||
      !(data instanceof Uint8Array) || data.byteLength > MAX_PACKET_BYTES) return false;
    const headerBytes = this.transportVersion === 2 ? 8 : 6;
    const envelope = new Uint8Array(headerBytes + data.byteLength);
    const view = new DataView(envelope.buffer);
    view.setUint32(0, peerId, true);
    view.setUint16(4, destinationPort, true);
    if (headerBytes === 8) view.setUint16(6, sourcePort, true);
    envelope.set(data, headerBytes);
    if (socket.bufferedAmount + envelope.byteLength > MAX_SOCKET_BUFFERED_BYTES) return false;
    try {
      socket.send(envelope);
      return true;
    } catch {
      return false;
    }
  }

  receivePacket(port: number, maxBytes: number): ReceivedPacket | null {
    if (!Number.isInteger(port) || port < 0 || port > 0xffff || !Number.isInteger(maxBytes) || maxBytes < 0) return null;
    // The native session exposes one virtual UDP port. Messages addressed to
    // other ports cannot be consumed by this engine and must not occupy its
    // bounded queue indefinitely.
    for (let i = this.packetQueue.length - 1; i >= 0; i -= 1) {
      if (this.packetQueue[i].port !== port) {
        this.queuedPacketBytes -= this.packetQueue[i].data.byteLength;
        this.packetQueue.splice(i, 1);
      }
    }
    const index = this.packetQueue.findIndex((packet) => packet.port === port && packet.data.byteLength <= maxBytes);
    if (index < 0) { this.publishPacketCount(); return null; }
    const [packet] = this.packetQueue.splice(index, 1);
    this.queuedPacketBytes -= packet.data.byteLength;
    this.publishPacketCount();
    return packet;
  }

  clearError(): void { this.lastOperation = ''; this.update({ error: null, errorDetail: null }); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      if (controlBytes(data) > MAX_CONTROL_BYTES) { this.update({ error: 'BAD_RESPONSE' }); return; }
      let message: unknown;
      try { message = JSON.parse(data); }
      catch { this.update({ error: 'BAD_RESPONSE' }); return; }
      if (!isRecord(message) || typeof message.type !== 'string') { this.update({ error: 'BAD_RESPONSE' }); return; }
      this.handleControl(message);
      return;
    }
    const bytes = this.asBytes(data);
    if (bytes) this.handlePacket(bytes);
  }

  private handleControl(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'welcome':
        if (this.currentState.status !== 'connecting' || !isPeerId(message.peerId)) { this.update({ error: 'BAD_RESPONSE' }); return; }
        this.pendingPeerId = message.peerId;
        this.lastOperation = 'transport';
        try {
          this.socket?.send(JSON.stringify({ type: 'transport', version: 2, gameProtocol: 6 }));
        } catch {
          this.completeConnect(1);
        }
        return;
      case 'transport':
        if (this.currentState.status !== 'connecting' || this.pendingPeerId === null || message.version !== 2) {
          this.update({ error: 'BAD_RESPONSE' }); return;
        }
        this.completeConnect(2);
        return;
      case 'lobbies':
        if (!isLobbyList(message.lobbies)) { this.update({ error: 'BAD_RESPONSE' }); return; }
        this.clearListingTimeout();
        this.update({ lobbies: message.lobbies.filter((lobby) => !lobby.private), listing: false, error: null, errorDetail: null });
        return;
      case 'probe':
        if (typeof message.lobbyId !== 'string' || typeof message.available !== 'boolean') { this.update({ error: 'BAD_RESPONSE' }); return; }
        if (this.resumable?.lobbyId === message.lobbyId) {
          this.resumeConfirmed = message.available;
          if (!message.available) this.resumable = null;
          this.update({});
        }
        return;
      case 'joined':
        if (!isLobby(message.lobby) || !isPeerId(message.peerId) ||
          (message.code !== undefined && (typeof message.code !== 'string' || message.code.length > 64))) {
          this.update({ error: 'BAD_RESPONSE' }); return;
        }
        this.update({ lobby: message.lobby, peerId: message.peerId, roster: [],
          privateCode: typeof message.code === 'string' ? message.code : null,
          started: message.lobby.started, error: null, errorDetail: null });
        this.resumingGame = false;
        return;
      case 'roster':
        if (!isLobby(message.lobby) || !isRoster(message.roster) || message.roster.length !== message.lobby.players ||
          message.roster.length > message.lobby.maxPlayers) { this.update({ error: 'BAD_RESPONSE' }); return; }
        if (this.currentState.lobby?.id === message.lobby.id) {
          this.update({ lobby: message.lobby, roster: message.roster, started: message.lobby.started, error: null, errorDetail: null });
        }
        return;
      case 'privacy':
        if (!isLobby(message.lobby) || (message.code !== undefined && (typeof message.code !== 'string' || message.code.length > 64))) {
          this.update({ error: 'BAD_RESPONSE' }); return;
        }
        if (this.currentState.lobby?.id !== message.lobby.id) return;
        this.update({ lobby: message.lobby, privateCode: typeof message.code === 'string' ? message.code : null,
          started: message.lobby.started, error: null });
        return;
      case 'started':
        if (!isLobby(message.lobby) || !message.lobby.started) { this.update({ error: 'BAD_RESPONSE' }); return; }
        if (this.currentState.lobby?.id !== message.lobby.id) return;
        this.update({ lobby: message.lobby, started: true, error: null });
        return;
      case 'left':
        this.clearRoomState();
        this.clearPacketQueue();
        return;
      case 'closed':
        if (typeof message.lobbyId !== 'string' || message.lobbyId.length > 64 || typeof message.reason !== 'string' || message.reason.length > 64) {
          this.update({ error: 'BAD_RESPONSE' }); return;
        }
        if (this.resumable?.lobbyId === message.lobbyId) {
          this.resumable = null;
          this.resumeConfirmed = false;
          this.resumingGame = false;
        }
        if (this.currentState.lobby?.id === message.lobbyId) {
          this.clearRoomState();
          this.clearPacketQueue();
        }
        this.update({ lobbies: this.currentState.lobbies.filter((lobby) => lobby.id !== message.lobbyId), error: message.reason });
        return;
      case 'error':
        {
          const code = typeof message.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(message.code) ? message.code : 'BAD_RESPONSE';
          if (this.currentState.status === 'connecting' && this.pendingPeerId !== null &&
              this.lastOperation === 'transport' && code === 'BAD_REQUEST') {
            this.completeConnect(1);
            return;
          }
          const detail = typeof message.detail === 'string' ? message.detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) : '';
          // A reconnect that cannot find its room must not keep offering a
          // button that can never succeed.
          if (this.resumingGame && code !== 'BAD_REQUEST') this.resumable = null;
          this.resumingGame = false;
          this.update({ error: code, errorDetail: detail || this.describeServerError(code) });
        }
        return;
      default:
        this.update({ error: 'BAD_RESPONSE' });
    }
  }

  private handlePacket(bytes: Uint8Array): void {
    const headerBytes = this.transportVersion === 2 ? 8 : 6;
    if (bytes.byteLength < headerBytes || bytes.byteLength > MAX_PACKET_BYTES + headerBytes || !this.hasValidRoom()) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const peerId = view.getUint32(0, true);
    const port = view.getUint16(4, true);
    const sourcePort = headerBytes === 8 ? view.getUint16(6, true) : port;
    if (port === 0 || sourcePort === 0) return;
    const data = bytes.slice(headerBytes);
    if (this.packetQueue.length >= MAX_QUEUED_PACKETS || this.queuedPacketBytes + data.byteLength > MAX_QUEUED_PACKET_BYTES) return;
    this.packetQueue.push({ peerId, port, sourcePort, data });
    this.queuedPacketBytes += data.byteLength;
    this.publishPacketCount();
  }

  private asBytes(value: unknown): Uint8Array | null {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  private sendControl(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (this.disposed || this.currentState.status !== 'connected' || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      const payload = JSON.stringify(message);
      if (controlBytes(payload) > MAX_CONTROL_BYTES || socket.bufferedAmount + controlBytes(payload) > MAX_SOCKET_BUFFERED_BYTES) return false;
      this.lastOperation = typeof message.type === 'string' ? message.type.slice(0, 24) : 'request';
      this.update({ error: null, errorDetail: null });
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  private hasValidRoom(): boolean {
    return this.currentState.status === 'connected' && this.currentState.lobby !== null;
  }

  private completeConnect(transportVersion: 1 | 2): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    if (this.pendingPeerId === null) return;
    const peerId = this.pendingPeerId;
    this.pendingPeerId = null;
    this.transportVersion = transportVersion;
    this.lastOperation = '';
    this.update({ status: 'connected', peerId, error: null, errorDetail: null });
    this.resolveConnect?.();
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
  }

  private clearRoomState(): void {
    this.update({ lobby: null, roster: [], privateCode: null, started: false });
  }

  private clearPacketQueue(): void {
    this.packetQueue = [];
    this.queuedPacketBytes = 0;
    this.publishPacketCount();
  }

  private validName(name: unknown): name is string {
    return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 48 && !/[\u0000-\u001f\u007f]/.test(name);
  }

  private invalidRequest(detail: string): false {
    this.update({ error: 'BAD_REQUEST', errorDetail: detail.slice(0, 160) });
    return false;
  }

  private describeServerError(code: string): string {
    switch (code) {
      case 'BAD_REQUEST': return `The server rejected the ${this.lastOperation || 'lobby'} request (BAD_REQUEST).`;
      case 'FULL': return 'The lobby has no open player slots.';
      case 'NOT_FOUND': return 'The lobby or private code could not be found.';
      case 'HOST_LEFT': return 'The host left the lobby.';
      case 'HOST_DISCONNECTED': return 'The host disconnected.';
      default: return `The multiplayer request failed (${code}).`;
    }
  }

  private rejectPendingConnect(error: Error): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.connectPromise = null;
  }

  private update(patch: Partial<MultiplayerState>): void {
    this.currentState = { ...this.currentState, ...patch };
    // Capture the running match as soon as it starts so an unexpected transport
    // drop can still be offered as "Reconnect to game".
    this.rememberResumable();
    try { this.onChange(this.currentState); } catch { /* UI callbacks cannot break transport state. */ }
  }
}
