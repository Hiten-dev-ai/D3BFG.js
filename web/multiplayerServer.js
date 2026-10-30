import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const route = '/__multiplayer';
const maxPayload = 64 * 1024;
const maxPacketBytes = 1_200;
const maxConnections = 256;
const maxLobbies = 128;
const maxControlMessagesPerWindow = 120;
const maxPacketsPerWindow = 6_000;
const maxRelayBytesPerWindow = 16 * 1024 * 1024;
const maxBufferedBytes = 1024 * 1024;
const messageWindowMs = 10_000;
const heartbeatMs = 30_000;
const validKinds = new Set(['versus', 'coop']);
const validModes = new Set(['deathmatch', 'tourney', 'team_deathmatch', 'lastman', 'ctf']);

function createId(used) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomBytes(12).toString('base64url');
    if (!used.has(id)) return id;
  }
  throw new Error('Unable to allocate unique lobby id');
}

// Invite codes are read off one screen and typed on another, so keep them short
// and free of characters that are easy to confuse (0/O, 1/I/L).
const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_CODE_LENGTH = 8;

function createCode(used) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
      code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
    }
    if (!used.has(code)) return code;
  }
  throw new Error('Unable to allocate unique lobby code');
}

function normalizeInviteCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function sendJson(peer, message) {
  const socket = peer?.socket ?? peer;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(peer, code, detail) {
  sendJson(peer, { type: 'error', code, ...(detail ? { detail } : {}) });
}

function validOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string' || host.length === 0 || typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const allowedProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const secureSocketRequiresHttps = !req.socket.encrypted || parsed.protocol === 'https:';
    return parsed.origin === origin && allowedProtocol && secureSocketRequiresHttps && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function writeHttpError(socket, status, message) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function readLobbyRequest(message) {
  if (message.length > maxPayload) return null;
  try {
    const value = JSON.parse(message.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 48 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

function safeMap(value) {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/i.test(value) ? value : null;
}

export function attachMultiplayerServer(httpServer, { authorize = () => true, identity = () => null, soloVersusTimeoutMs = 10_000 } = {}) {
  if (!httpServer || typeof httpServer.on !== 'function') {
    throw new TypeError('attachMultiplayerServer requires an HTTP server');
  }

  const peers = new Map();
  const lobbies = new Map();
  const privateCodes = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  let nextPeerId = randomBytes(4).readUInt32LE(0) || 1;
  let closed = false;

  function allocatePeerId() {
    for (let attempt = 0; attempt < 0xffff_ffff; attempt += 1) {
      const candidate = nextPeerId >>> 0;
      nextPeerId = (candidate + 1) >>> 0;
      if (candidate !== 0 && !peers.has(candidate)) return candidate;
    }
    throw new Error('No available peer ids');
  }

  function lobbyView(lobby) {
    return {
      id: lobby.id,
      name: lobby.name,
      kind: lobby.kind,
      players: lobby.members.size,
      maxPlayers: lobby.maxPlayers,
      private: lobby.private,
      hostPeerId: lobby.hostPeerId,
      started: lobby.started,
      mode: lobby.mode,
      ...(lobby.kind === 'coop' ? { coopLives: lobby.coopLives, friendlyFire: lobby.friendlyFire, hostLoading: lobby.hostLoading } : {}),
      ...(lobby.map ? { map: lobby.map } : {}),
    };
  }

  function rosterView(lobby) {
    return Array.from(lobby.members, ([peerId, member]) => ({ peerId, name: member.name }));
  }

  function broadcast(lobby, message) {
    const payload = JSON.stringify(message);
    for (const peerId of lobby.members.keys()) {
      const peer = peers.get(peerId);
      const socket = peer?.socket ?? peer;
      if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  function broadcastRoster(lobby) {
    broadcast(lobby, { type: 'roster', lobby: lobbyView(lobby), roster: rosterView(lobby) });
  }

  function removeLobby(lobby, reason, closingPeerId) {
    clearTimeout(lobby.soloTimer);
    lobbies.delete(lobby.id);
    if (lobby.code) privateCodes.delete(lobby.code);
    for (const peerId of lobby.members.keys()) {
      if (peerId === closingPeerId) {
        const closingPeer = peers.get(peerId);
        if (closingPeer) closingPeer.lobbyId = null;
        continue;
      }
      const peer = peers.get(peerId);
      sendJson(peer, { type: 'closed', lobbyId: lobby.id, reason });
      if (peer) {
        peer.lobbyId = null;
        if (reason === 'HOST_LEFT' || reason === 'HOST_DISCONNECTED') peer.socket.close(4001, 'Host left the game');
      }
    }
    lobby.members.clear();
    for (const peer of peers.values()) {
      if (peer.watchedLobbyId === lobby.id) {
        peer.watchedLobbyId = null;
        sendJson(peer, { type: 'closed', lobbyId: lobby.id, reason });
      }
    }
  }

  function leaveLobby(peer, reason = 'LEFT') {
    const lobby = peer.lobbyId ? lobbies.get(peer.lobbyId) : null;
    if (!lobby) {
      peer.lobbyId = null;
      return;
    }
    if (peer.peerId === lobby.hostPeerId) {
      removeLobby(lobby, reason === 'DISCONNECTED' ? 'HOST_DISCONNECTED' : 'HOST_LEFT', peer.peerId);
      return;
    }
    lobby.members.delete(peer.peerId);
    peer.lobbyId = null;
    broadcastRoster(lobby);
    if (lobby.kind === 'versus' && lobby.started && lobby.members.size === 1 && !lobby.soloTimer) {
      lobby.soloTimer = setTimeout(() => {
        lobby.soloTimer = null;
        if (lobbies.get(lobby.id) === lobby && lobby.started && lobby.members.size === 1) {
          removeLobby(lobby, 'MATCH_ENDED_NO_OPPONENTS', 0);
        }
      }, soloVersusTimeoutMs);
      lobby.soloTimer.unref?.();
    }
  }

  function joinLobby(peer, lobby) {
    if (peer.protocolRejected) {
      sendError(peer, 'BAD_REQUEST', 'Game versions differ. Reload the game before joining.');
      return;
    }
    if (peer.gameProtocol !== lobby.gameProtocol) {
      sendError(peer, 'BAD_REQUEST', 'Game versions differ. Both players must reload the game before joining.');
      return;
    }
    if (peer.lobbyId) {
      if (peer.lobbyId === lobby.id) {
        sendJson(peer, { type: 'joined', lobby: lobbyView(lobby), peerId: peer.peerId });
        return;
      }
      sendError(peer, 'BAD_REQUEST');
      return;
    }
    if (lobby.members.size >= lobby.maxPlayers) {
      sendError(peer, 'FULL');
      return;
    }
    clearTimeout(lobby.soloTimer);
    lobby.soloTimer = null;
    const name = normalizeName(peer.identity()?.name) ?? normalizeName(peer.requestedName) ?? `Player ${peer.peerId}`;
    lobby.members.set(peer.peerId, { name });
    peer.lobbyId = lobby.id;
    peer.watchedLobbyId = null;
    sendJson(peer, { type: 'joined', lobby: lobbyView(lobby), peerId: peer.peerId });
    broadcastRoster(lobby);
  }

  function rateLimitPeer(peer) {
    if (!peer.rateLimited) {
      peer.rateLimited = true;
      sendError(peer, 'BAD_REQUEST');
      peer.socket.close(1008, 'Rate limit exceeded');
    }
  }

  function createLobby(peer, message) {
    if (peer.protocolRejected) {
      sendError(peer, 'BAD_REQUEST', 'This cached game build is outdated. Reload before creating a lobby.');
      return;
    }
    const name = normalizeName(message.name);
    const kind = message.kind;
    const mode = message.mode;
    const maxAllowed = kind === 'coop' ? 2 : 8;
    const maximum = message.maxPlayers;
    const privateFlag = message.private;
    const map = safeMap(message.map);
    const coopLives = kind === 'coop' ? (message.coopLives === undefined ? 3 : message.coopLives) : undefined;
    const friendlyFire = kind === 'coop' ? (message.friendlyFire === undefined ? false : message.friendlyFire) : undefined;
    if (peer.lobbyId) {
      const current = lobbies.get(peer.lobbyId);
      if (current && current.hostPeerId === peer.peerId && current.name === name &&
          current.kind === kind && current.mode === mode && current.private === privateFlag &&
          current.maxPlayers === maximum && current.map === map && current.coopLives === coopLives && current.friendlyFire === friendlyFire) {
        sendJson(peer, { type: 'joined', lobby: lobbyView(current), peerId: peer.peerId,
          ...(current.code ? { code: current.code } : {}) });
      } else {
        sendError(peer, 'ALREADY_IN_LOBBY', 'Leave the current lobby before creating another.');
      }
      return;
    }
    const invalid = !name ? 'Enter a valid lobby name.'
      : !validKinds.has(kind) ? 'Choose a valid lobby type.'
      : !(kind === 'coop' ? mode === 'coop' : validModes.has(mode)) ? 'Choose a supported game mode.'
      : typeof privateFlag !== 'boolean' ? 'Choose public or private.'
      : !Number.isInteger(maximum) || maximum < 2 || maximum > maxAllowed ? 'Choose a valid player limit.'
      : kind === 'coop' && typeof friendlyFire !== 'boolean' ? 'Friendly Fire must be enabled or disabled.'
      : kind === 'coop' && (!Number.isInteger(coopLives) || coopLives < 1 || coopLives > 10) ? 'Choose 1–10 co-op lives.'
      : map === null ? 'Choose a valid map.'
      : lobbies.size >= maxLobbies ? 'The server has reached its lobby limit.' : '';
    if (invalid) {
      sendError(peer, 'BAD_REQUEST', invalid);
      return;
    }
    const id = createId(lobbies);
    const lobby = {
      id,
      code: privateFlag ? createCode(privateCodes) : null,
      name,
      kind,
      mode,
      ...(kind === 'coop' ? { coopLives, friendlyFire, hostLoading: true } : {}),
      ...(map ? { map } : {}),
      private: privateFlag,
      maxPlayers: kind === 'coop' ? 2 : maximum,
      hostPeerId: peer.peerId,
      gameProtocol: peer.gameProtocol,
      started: false,
      members: new Map([[peer.peerId, { name: normalizeName(peer.identity()?.name) ?? `Player ${peer.peerId}` }]]),
    };
    lobbies.set(id, lobby);
    if (lobby.code) privateCodes.set(lobby.code, lobby);
    peer.lobbyId = id;
    sendJson(peer, {
      type: 'joined',
      lobby: lobbyView(lobby),
      peerId: peer.peerId,
      ...(lobby.code ? { code: lobby.code } : {}),
    });
    broadcastRoster(lobby);
  }

  function handleJson(peer, message) {
    peer.controlMessageCount += 1;
    if (peer.controlMessageCount > maxControlMessagesPerWindow) {
      rateLimitPeer(peer);
      return;
    }
    const request = readLobbyRequest(message);
    if (!request || typeof request.type !== 'string') {
      sendError(peer, 'BAD_REQUEST');
      return;
    }
    switch (request.type) {
      case 'transport':
        if (request.gameProtocol !== undefined && request.gameProtocol !== 6) peer.protocolRejected = true;
        if (request.version !== 2 || ![undefined, 6].includes(request.gameProtocol) ||
            (peer.lobbyId && peer.gameProtocol !== (request.gameProtocol ?? 0))) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        peer.transportVersion = 2;
        peer.protocolRejected = false;
        peer.gameProtocol = request.gameProtocol ?? 0;
        sendJson(peer, { type: 'transport', version: 2 });
        break;
      case 'create':
        createLobby(peer, request);
        break;
      case 'probe': {
        if (typeof request.lobbyId !== 'string' || request.lobbyId.length > 64) { sendError(peer, 'BAD_REQUEST'); break; }
        const lobby = lobbies.get(request.lobbyId);
        const available = Boolean(lobby && lobby.started);
        peer.watchedLobbyId = available ? request.lobbyId : null;
        sendJson(peer, { type: 'probe', lobbyId: request.lobbyId, available });
        break;
      }
      case 'loading': {
        const lobby = peer.lobbyId ? lobbies.get(peer.lobbyId) : null;
        if (!lobby || lobby.kind !== 'coop' || lobby.hostPeerId !== peer.peerId || typeof request.loading !== 'boolean') { sendError(peer, 'BAD_REQUEST'); break; }
        if (lobby.hostLoading !== request.loading) {
          lobby.hostLoading = request.loading;
          broadcastRoster(lobby);
        }
        break;
      }
      case 'list': {
        if (request.kind !== undefined && !validKinds.has(request.kind)) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        const visible = Array.from(lobbies.values())
          .filter((lobby) => !lobby.private && (request.kind === undefined || lobby.kind === request.kind))
          .map(lobbyView);
        sendJson(peer, { type: 'lobbies', lobbies: visible });
        break;
      }
      case 'join': {
        if (request.name !== undefined && !normalizeName(request.name)) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        const hasCode = request.code !== undefined;
        const hasLobbyId = request.lobbyId !== undefined;
        if (hasCode === hasLobbyId || (hasCode && (typeof request.code !== 'string' || request.code.length > 64)) ||
            (hasLobbyId && (typeof request.lobbyId !== 'string' || request.lobbyId.length > 64))) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        peer.requestedName = request.name === undefined ? null : normalizeName(request.name);
        let lobby = null;
        if (hasCode) {
          // Codes are shown in upper case; accept lower case typing as well.
          lobby = privateCodes.get(normalizeInviteCode(request.code)) ?? null;
        } else {
          const candidate = lobbies.get(request.lobbyId);
          if (candidate && (!candidate.private || candidate.members.has(peer.peerId))) lobby = candidate;
        }
        if (!lobby) sendError(peer, 'NOT_FOUND');
        else joinLobby(peer, lobby);
        break;
      }
      case 'privacy': {
        const lobby = peer.lobbyId ? lobbies.get(peer.lobbyId) : null;
        if (!lobby || peer.peerId !== lobby.hostPeerId || typeof request.private !== 'boolean' || lobby.started) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        if (lobby.private !== request.private) {
          if (lobby.code) privateCodes.delete(lobby.code);
          lobby.private = request.private;
          lobby.code = lobby.private ? createCode(privateCodes) : null;
          if (lobby.code) privateCodes.set(lobby.code, lobby);
        }
        sendJson(peer, { type: 'privacy', lobby: lobbyView(lobby), ...(lobby.code ? { code: lobby.code } : {}) });
        broadcastRoster(lobby);
        break;
      }
      case 'start': {
        const lobby = peer.lobbyId ? lobbies.get(peer.lobbyId) : null;
        if (!lobby || peer.peerId !== lobby.hostPeerId || lobby.started) {
          sendError(peer, 'BAD_REQUEST');
          break;
        }
        if (lobby.members.size < (lobby.kind === 'coop' ? 1 : 2)) {
          sendError(peer, 'WAITING_FOR_PLAYERS');
          break;
        }
        lobby.started = true;
        broadcast(lobby, { type: 'started', lobby: lobbyView(lobby) });
        break;
      }
      case 'leave':
        leaveLobby(peer);
        sendJson(peer, { type: 'left' });
        break;
      default:
        sendError(peer, 'BAD_REQUEST');
    }
  }

  function handleBinary(peer, message) {
    peer.packetCount += 1;
    peer.relayBytes += message.length;
    if (peer.packetCount > maxPacketsPerWindow || peer.relayBytes > maxRelayBytesPerWindow) {
      rateLimitPeer(peer);
      return;
    }
    const headerBytes = peer.transportVersion === 2 ? 8 : 6;
    if (message.length <= headerBytes || message.length > maxPacketBytes + headerBytes) {
      sendError(peer, 'BAD_REQUEST');
      return;
    }
    const lobby = peer.lobbyId ? lobbies.get(peer.lobbyId) : null;
    if (!lobby) {
      sendError(peer, 'BAD_REQUEST');
      return;
    }
    const destinationPeerId = message.readUInt32LE(0);
    const destinationPort = message.readUInt16LE(4);
    const sourcePort = headerBytes === 8 ? message.readUInt16LE(6) : destinationPort;
    if (destinationPort === 0 || sourcePort === 0) {
      sendError(peer, 'BAD_REQUEST');
      return;
    }
    const envelope = Buffer.allocUnsafe(message.length);
    envelope.writeUInt32LE(peer.peerId, 0);
    envelope.writeUInt16LE(destinationPort, 4);
    if (headerBytes === 8) envelope.writeUInt16LE(sourcePort, 6);
    message.copy(envelope, headerBytes, headerBytes);
    if (destinationPeerId === 0) {
      for (const peerId of lobby.members.keys()) {
        if (peerId === peer.peerId) continue;
        const target = peers.get(peerId);
        if (target?.socket?.readyState === WebSocket.OPEN && target.socket.bufferedAmount + envelope.length <= maxBufferedBytes) {
          target.socket.send(envelope, { binary: true });
        }
      }
      return;
    }
    if (destinationPeerId === peer.peerId || !lobby.members.has(destinationPeerId)) {
      sendError(peer, 'NOT_FOUND');
      return;
    }
    const target = peers.get(destinationPeerId);
    if (target?.socket?.readyState === WebSocket.OPEN && target.socket.bufferedAmount + envelope.length <= maxBufferedBytes) {
      target.socket.send(envelope, { binary: true });
    }
    else sendError(peer, 'NOT_FOUND');
  }

  wss.on('connection', (socket, request) => {
    if (peers.size >= maxConnections) {
      socket.close(1013, 'Server full');
      return;
    }
    const peer = {
      peerId: allocatePeerId(),
      accountId: identity(request)?.id ?? null,
      lobbyId: null,
      requestedName: null,
      isAlive: true,
      controlMessageCount: 0,
      controlWindowStartedAt: Date.now(),
      packetCount: 0,
      relayBytes: 0,
      packetWindowStartedAt: Date.now(),
      transportVersion: 1,
      gameProtocol: 0,
      authorized: () => authorize(request),
      identity: () => identity(request),
    };
    peer.socket = socket;
    peers.set(peer.peerId, peer);
    socket.peerId = peer.peerId;
    socket.lobbyId = null;
    socket.isAlive = true;
    socket.on('pong', () => { peer.isAlive = true; });
    sendJson(socket, { type: 'welcome', peerId: peer.peerId });
    socket.on('message', (data, isBinary) => {
      if (!peer.authorized()) { socket.close(1008, 'Account session ended'); return; }
      const now = Date.now();
      if (isBinary) {
        if (now - peer.packetWindowStartedAt >= messageWindowMs) {
          peer.packetWindowStartedAt = now;
          peer.packetCount = 0;
          peer.relayBytes = 0;
          peer.rateLimited = false;
        }
      } else if (now - peer.controlWindowStartedAt >= messageWindowMs) {
        peer.controlWindowStartedAt = now;
        peer.controlMessageCount = 0;
        peer.rateLimited = false;
      }
      if (isBinary) handleBinary(peer, data);
      else handleJson(peer, data);
    });
    socket.on('close', () => {
      peers.delete(peer.peerId);
      leaveLobby(peer, 'DISCONNECTED');
    });
    socket.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const peer = peers.get(socket.peerId);
      if (!peer) continue;
      if (!peer.authorized()) { socket.close(1008, 'Account session ended'); continue; }
      if (!peer.isAlive) {
        socket.terminate();
        continue;
      }
      peer.isAlive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  function onUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      writeHttpError(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== route) return;
    if (!authorize(req)) {
      writeHttpError(socket, 401, 'Unauthorized');
      return;
    }
    if (!validOrigin(req)) {
      writeHttpError(socket, 403, 'Forbidden');
      return;
    }
    const accountId = identity(req)?.id;
    // A new login has revoked the old cookie. Retire that connection now rather
    // than rejecting the replacement until the next authorization heartbeat.
    for (const peer of peers.values()) {
      if (accountId && peer.accountId === accountId && !peer.authorized()) {
        leaveLobby(peer, 'DISCONNECTED');
        peers.delete(peer.peerId);
        peer.socket.close(4001, 'Signed in elsewhere');
      }
    }
    if (accountId && Array.from(peers.values()).some(peer => peer.accountId === accountId)) {
      writeHttpError(socket, 409, 'Account Already Connected');
      return;
    }
    wss.handleUpgrade(req, socket, head, (websocket) => {
      wss.emit('connection', websocket, req);
    });
  }

  httpServer.on('upgrade', onUpgrade);

  return {
    close() {
      if (closed) return;
      closed = true;
      httpServer.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const lobby of lobbies.values()) removeLobby(lobby, 'SERVER_CLOSED', 0);
      for (const socket of wss.clients) socket.close(1001, 'Server closed');
      wss.close();
    },
  };
}
