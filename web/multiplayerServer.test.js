import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { attachMultiplayerServer } from './multiplayerServer.js';

let server;
let multiplayer;
let url;
let accessAllowed = true;
let revokedToken = null;
const sockets = new Set();

before(async () => {
  server = createServer();
  multiplayer = attachMultiplayerServer(server, { soloVersusTimeoutMs: 100, authorize: req => accessAllowed && req.headers['x-test-token'] !== revokedToken,
    identity: req => req.headers['x-test-account'] ? { id: req.headers['x-test-account'], name: req.headers['x-test-account'] } : null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `ws://127.0.0.1:${server.address().port}/__multiplayer`;
});

after(async () => {
  multiplayer.close();
  server.close();
  await once(server, 'close');
});

afterEach(async () => {
  accessAllowed = true;
  revokedToken = null;
  const active = [...sockets].filter((socket) => socket.readyState !== WebSocket.CLOSED);
  const closed = Promise.all(active.map((socket) => once(socket, 'close')));
  for (const socket of active) socket.terminate();
  await closed;
  sockets.clear();
});

function nextMessage(socket, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      const message = isBinary ? data : JSON.parse(data.toString());
      if (!predicate(message, isBinary)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function connect(originScheme = 'http', accountName, token) {
  const socket = new WebSocket(url, { origin: `${originScheme}://${new URL(url).host}`,
    ...(accountName ? { headers: { 'x-test-account': accountName, ...(token ? { 'x-test-token': token } : {}) } } : {}) });
  sockets.add(socket);
  const welcomePromise = nextMessage(socket, (value) => value.type === 'welcome');
  await once(socket, 'open');
  const welcome = await welcomePromise;
  assert.equal(Number.isInteger(welcome.peerId), true);
  assert.notEqual(welcome.peerId, 0);
  return { socket, peerId: welcome.peerId };
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function createRequest(overrides = {}) {
  return {
    type: 'create',
    kind: 'versus',
    name: 'Test Room',
    private: false,
    maxPlayers: 4,
    mode: 'deathmatch',
    ...overrides,
  };
}

test('repeated create is idempotent and other invalid requests explain the problem', async () => {
  const host = await connect('http', 'PortTestMarine');
  const request = createRequest({ name: "PortTestMarine's game", map: 'd3dm1' });
  send(host.socket, request);
  const first = await nextMessage(host.socket, value => value.type === 'joined');
  send(host.socket, request);
  const again = await nextMessage(host.socket, value => value.type === 'joined');
  assert.equal(again.lobby.id, first.lobby.id);
  send(host.socket, createRequest({ name: 'Different Room' }));
  const conflict = await nextMessage(host.socket, value => value.type === 'error');
  assert.equal(conflict.code, 'ALREADY_IN_LOBBY');
  assert.match(conflict.detail, /Leave the current lobby/);
  const another = await connect();
  send(another.socket, createRequest({ map: 'maps/d3dm1' }));
  const invalid = await nextMessage(another.socket, value => value.type === 'error');
  assert.equal(invalid.code, 'BAD_REQUEST');
  assert.equal(invalid.detail, 'Choose a valid map.');
});

test('campaign snapshot protocols cannot mix cached and updated engines', async () => {
  const host = await connect();
  send(host.socket, { type: 'transport', version: 2, gameProtocol: 6 });
  await nextMessage(host.socket, value => value.type === 'transport');
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const room = await nextMessage(host.socket, value => value.type === 'joined');
  const old = await connect();
  send(old.socket, { type: 'transport', version: 2, gameProtocol: 5 });
  assert.equal((await nextMessage(old.socket, value => value.type === 'error')).code, 'BAD_REQUEST');
  // This legacy peer never negotiated, so it cannot join the new snapshot room.
  const legacyPeer = await connect();
  send(legacyPeer.socket, { type: 'join', lobbyId: room.lobby.id });
  const error = await nextMessage(legacyPeer.socket, value => value.type === 'error');
  assert.match(error.detail, /versions differ/);
  const guest = await connect();
  send(guest.socket, { type: 'transport', version: 2, gameProtocol: 6 });
  await nextMessage(guest.socket, value => value.type === 'transport');
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'joined')).lobby.id, room.lobby.id);
  send(host.socket, { type: 'transport', version: 2 });
  assert.equal((await nextMessage(host.socket, value => value.type === 'error')).code, 'BAD_REQUEST');
});

test('co-op lobby publishes its bounded life setting and defaults old requests to three', async () => {
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2, coopLives: 7 }));
  const configured = await nextMessage(host.socket, value => value.type === 'joined');
  assert.equal(configured.lobby.coopLives, 7);

  const legacyHost = await connect();
  send(legacyHost.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const legacy = await nextMessage(legacyHost.socket, value => value.type === 'joined');
  assert.equal(legacy.lobby.coopLives, 3);

  const invalidHost = await connect();
  send(invalidHost.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2, coopLives: 11 }));
  const invalid = await nextMessage(invalidHost.socket, value => value.type === 'error');
  assert.equal(invalid.code, 'BAD_REQUEST');
  assert.match(invalid.detail, /1–10 co-op lives/);
});

test('co-op friendly fire defaults off and is replicated to guests when enabled', async () => {
  const defaultHost = await connect();
  send(defaultHost.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const defaults = await nextMessage(defaultHost.socket, value => value.type === 'joined');
  assert.equal(defaults.lobby.friendlyFire, false);
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2, friendlyFire: true }));
  const room = await nextMessage(host.socket, value => value.type === 'joined');
  assert.equal(room.lobby.friendlyFire, true);
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'joined')).lobby.friendlyFire, true);
  const invalidHost = await connect();
  send(invalidHost.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2, friendlyFire: 'true' }));
  assert.equal((await nextMessage(invalidHost.socket, value => value.type === 'error')).code, 'BAD_REQUEST');
});

test('early co-op join reserves one slot while loading; readiness is host-owned and closed rooms invalidate watchers', async () => {
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const room = await nextMessage(host.socket, value => value.type === 'joined');
  assert.equal(room.lobby.hostLoading, true);
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'joined')).lobby.players, 2);
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'joined')).lobby.players, 2, 'retry is idempotent');
  send(guest.socket, { type: 'loading', loading: false });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'error')).code, 'BAD_REQUEST');
  send(host.socket, { type: 'loading', loading: false });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'roster' && value.lobby.hostLoading === false)).lobby.players, 2);
  send(host.socket, { type: 'start' });
  await nextMessage(host.socket, value => value.type === 'started');
  send(guest.socket, { type: 'leave' });
  await nextMessage(guest.socket, value => value.type === 'left');
  send(guest.socket, { type: 'probe', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'probe')).available, true);
  send(host.socket, { type: 'leave' });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'closed')).lobbyId, room.lobby.id);
  send(guest.socket, { type: 'probe', lobbyId: room.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'probe')).available, false);
});

test('new login replaces a revoked multiplayer host and closes its old room', async () => {
  const host = await connect('http', 'SameAccount', 'old-login');
  send(host.socket, createRequest());
  const room = await nextMessage(host.socket, value => value.type === 'joined');
  const guest = await connect('http', 'OtherAccount', 'guest-login');
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  await nextMessage(guest.socket, value => value.type === 'joined');
  const hostClosed = once(host.socket, 'close');
  const guestClosed = once(guest.socket, 'close');
  revokedToken = 'old-login';
  const replacement = await connect('http', 'SameAccount', 'new-login');
  assert.equal((await hostClosed)[0], 4001);
  assert.equal((await guestClosed)[0], 4001);
  send(replacement.socket, createRequest());
  assert.notEqual((await nextMessage(replacement.socket, value => value.type === 'joined')).lobby.id, room.lobby.id);
});

test('started versus match ends after host is alone, but cancels if a peer rejoins', async () => {
  const host = await connect();
  send(host.socket, createRequest());
  const room = await nextMessage(host.socket, value => value.type === 'joined');
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  await nextMessage(guest.socket, value => value.type === 'joined');
  send(host.socket, { type: 'start' });
  await nextMessage(host.socket, value => value.type === 'started');
  send(guest.socket, { type: 'leave' });
  await nextMessage(guest.socket, value => value.type === 'left');
  send(guest.socket, { type: 'join', lobbyId: room.lobby.id });
  await nextMessage(guest.socket, value => value.type === 'joined');
  await new Promise(resolve => setTimeout(resolve, 150));
  const closed = nextMessage(host.socket, value => value.type === 'closed');
  send(guest.socket, { type: 'leave' });
  await nextMessage(guest.socket, value => value.type === 'left');
  assert.equal((await closed).reason, 'MATCH_ENDED_NO_OPPONENTS');
});

test('solo timeout does not end co-op or an unstarted versus lobby', async () => {
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const coop = await nextMessage(host.socket, value => value.type === 'joined');
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: coop.lobby.id });
  await nextMessage(guest.socket, value => value.type === 'joined');
  send(host.socket, { type: 'start' });
  await nextMessage(host.socket, value => value.type === 'started');
  send(guest.socket, { type: 'leave' });
  await nextMessage(guest.socket, value => value.type === 'left');
  await new Promise(resolve => setTimeout(resolve, 150));
  send(guest.socket, { type: 'join', lobbyId: coop.lobby.id });
  assert.equal((await nextMessage(guest.socket, value => value.type === 'joined')).lobby.id, coop.lobby.id);
  const host2 = await connect();
  send(host2.socket, createRequest());
  const lobby = await nextMessage(host2.socket, value => value.type === 'joined');
  const guest2 = await connect();
  send(guest2.socket, { type: 'join', lobbyId: lobby.lobby.id });
  await nextMessage(guest2.socket, value => value.type === 'joined');
  send(guest2.socket, { type: 'leave' });
  await nextMessage(guest2.socket, value => value.type === 'left');
  await new Promise(resolve => setTimeout(resolve, 150));
  send(guest2.socket, { type: 'join', lobbyId: lobby.lobby.id });
  assert.equal((await nextMessage(guest2.socket, value => value.type === 'joined')).lobby.id, lobby.lobby.id);
});

test('roster uses authenticated account names independently of lobby names and join aliases', async () => {
  const host = await connect('http', 'Hiten');
  send(host.socket, createRequest({ name: 'Campaign Night', kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const created = await nextMessage(host.socket, value => value.type === 'joined');
  const guest = await connect('http', 'TestMarine');
  const roster = nextMessage(host.socket, value => value.type === 'roster' && value.roster.length === 2);
  send(guest.socket, { type: 'join', lobbyId: created.lobby.id, name: 'Impersonated name' });
  await nextMessage(guest.socket, value => value.type === 'joined');
  assert.equal(created.lobby.name, 'Campaign Night');
  assert.deepEqual((await roster).roster.map(player => player.name), ['Hiten', 'TestMarine']);
});

test('separate accounts can share co-op and versus lobbies', async () => {
  for (const kind of ['coop', 'versus']) {
    const host = await connect('http', `Host-${kind}`);
    const guest = await connect('http', `Guest-${kind}`);
    assert.notEqual(host.peerId, guest.peerId, 'transport identity belongs to the instance');
    send(host.socket, createRequest({ kind, mode: kind === 'coop' ? 'coop' : 'deathmatch', maxPlayers: 2 }));
    const created = await nextMessage(host.socket, value => value.type === 'joined');
    const roster = nextMessage(host.socket, value => value.type === 'roster' && value.roster.length === 2);
    send(guest.socket, { type: 'join', lobbyId: created.lobby.id });
    const joined = await nextMessage(guest.socket, value => value.type === 'joined');
    assert.equal(joined.lobby.players, 2);
    assert.deepEqual((await roster).roster.map(player => player.name), [`Host-${kind}`, `Guest-${kind}`]);
  }
});

test('the same account cannot create a second multiplayer connection', async () => {
  await connect('http', 'Hiten');
  const socket = new WebSocket(url, { origin: `http://${new URL(url).host}`, headers: { 'x-test-account': 'Hiten' } });
  socket.on('error', () => {});
  const [request, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 409);
  response.resume();
});

test('public discovery omits private lobbies and private codes', async () => {
  const publicHost = await connect();
  send(publicHost.socket, createRequest());
  const publicJoined = await nextMessage(publicHost.socket, (value) => value.type === 'joined');
  assert.equal('code' in publicJoined, false);

  const privateHost = await connect();
  send(privateHost.socket, createRequest({ name: 'Hidden', private: true }));
  const privateJoined = await nextMessage(privateHost.socket, (value) => value.type === 'joined');
  assert.match(privateJoined.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);

  const coopHost = await connect();
  send(coopHost.socket, createRequest({ kind: 'coop', mode: 'coop', name: 'Co-op Room', maxPlayers: 2 }));
  const coopJoined = await nextMessage(coopHost.socket, (value) => value.type === 'joined');

  const guest = await connect();
  send(guest.socket, { type: 'list' });
  const listing = await nextMessage(guest.socket, (value) => value.type === 'lobbies');
  assert.deepEqual(listing.lobbies.map((lobby) => lobby.id), [publicJoined.lobby.id, coopJoined.lobby.id]);
  assert.equal(JSON.stringify(listing).includes(privateJoined.code), false);
  send(guest.socket, { type: 'list', kind: 'coop' });
  const coopListing = await nextMessage(guest.socket, (value) => value.type === 'lobbies');
  assert.deepEqual(coopListing.lobbies.map((lobby) => lobby.id), [coopJoined.lobby.id]);

  send(guest.socket, { type: 'join', lobbyId: privateJoined.lobby.id });
  assert.deepEqual(await nextMessage(guest.socket, (value) => value.type === 'error'), { type: 'error', code: 'NOT_FOUND' });
  send(guest.socket, { type: 'join', code: privateJoined.code, name: 'Guest' });
  const joined = await nextMessage(guest.socket, (value) => value.type === 'joined');
  assert.equal(joined.lobby.id, privateJoined.lobby.id);
  assert.equal('code' in joined, false);
});

test('co-op room caps at two players and reports full rooms', async () => {
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const created = await nextMessage(host.socket, (value) => value.type === 'joined');
  assert.equal(created.lobby.maxPlayers, 2);
  assert.equal(created.lobby.started, false);

  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: created.lobby.id });
  await nextMessage(guest.socket, (value) => value.type === 'joined');
  await nextMessage(host.socket, (value) => value.type === 'roster');

  const third = await connect();
  send(third.socket, { type: 'join', lobbyId: created.lobby.id });
  assert.deepEqual(await nextMessage(third.socket, (value) => value.type === 'error'), { type: 'error', code: 'FULL' });
});

test('versus rooms preserve the native eight-player limit', async () => {
  const host = await connect();
  send(host.socket, createRequest({ maxPlayers: 8 }));
  const created = await nextMessage(host.socket, (value) => value.type === 'joined');
  assert.equal(created.lobby.maxPlayers, 8);
});

test('binary relay rewrites sender envelope and stays inside lobby', async () => {
  const host = await connect();
  send(host.socket, createRequest());
  const created = await nextMessage(host.socket, (value) => value.type === 'joined');
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: created.lobby.id });
  await nextMessage(guest.socket, (value) => value.type === 'joined');
  await nextMessage(host.socket, (value) => value.type === 'roster');

  const outsider = await connect();
  send(outsider.socket, createRequest({ name: 'Other Room' }));
  await nextMessage(outsider.socket, (value) => value.type === 'joined');

  const packet = Buffer.alloc(6 + 3);
  packet.writeUInt32LE(guest.peerId, 0);
  packet.writeUInt16LE(0x1234, 4);
  packet.set([0xaa, 0xbb, 0xcc], 6);
  const received = nextMessage(guest.socket, (_value, isBinary) => isBinary);
  host.socket.send(packet);
  const envelope = await received;
  assert.equal(envelope.readUInt32LE(0), host.peerId);
  assert.equal(envelope.readUInt16LE(4), 0x1234);
  assert.deepEqual([...envelope.subarray(6)], [0xaa, 0xbb, 0xcc]);

  let relayedCount = 0;
  const sustainedRelay = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      guest.socket.off('message', onPacket);
      reject(new Error('Timed out waiting for sustained relay packets'));
    }, 2_000);
    const onPacket = (_data, isBinary) => {
      if (!isBinary) return;
      relayedCount += 1;
      if (relayedCount === 125) {
        clearTimeout(timer);
        guest.socket.off('message', onPacket);
        resolve();
      }
    };
    guest.socket.on('message', onPacket);
  });
  packet.writeUInt32LE(guest.peerId, 0);
  for (let i = 0; i < 125; i += 1) host.socket.send(packet);
  await sustainedRelay;
  assert.equal(host.socket.readyState, WebSocket.OPEN);

  packet.writeUInt32LE(outsider.peerId, 0);
  host.socket.send(packet);
  assert.deepEqual(await nextMessage(host.socket, (value) => value.type === 'error'), { type: 'error', code: 'NOT_FOUND' });
});

test('version two relay preserves asymmetric source and destination ports in both directions', async () => {
  const host = await connect();
  send(host.socket, createRequest());
  const created = await nextMessage(host.socket, (value) => value.type === 'joined');
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: created.lobby.id });
  await nextMessage(guest.socket, (value) => value.type === 'joined');
  await nextMessage(host.socket, (value) => value.type === 'roster');

  for (const peer of [host, guest]) {
    const ready = nextMessage(peer.socket, (value) => value.type === 'transport');
    send(peer.socket, { type: 'transport', version: 2 });
    assert.deepEqual(await ready, { type: 'transport', version: 2 });
  }

  const toGuest = Buffer.alloc(8 + 3);
  toGuest.writeUInt32LE(guest.peerId, 0);
  toGuest.writeUInt16LE(27017, 4);
  toGuest.writeUInt16LE(27016, 6);
  toGuest.set([0xaa, 0xbb, 0xcc], 8);
  const guestReceived = nextMessage(guest.socket, (_value, isBinary) => isBinary);
  host.socket.send(toGuest);
  const guestEnvelope = await guestReceived;
  assert.equal(guestEnvelope.readUInt32LE(0), host.peerId);
  assert.equal(guestEnvelope.readUInt16LE(4), 27017);
  assert.equal(guestEnvelope.readUInt16LE(6), 27016);
  assert.deepEqual([...guestEnvelope.subarray(8)], [0xaa, 0xbb, 0xcc]);

  const toHost = Buffer.alloc(8 + 2);
  toHost.writeUInt32LE(host.peerId, 0);
  toHost.writeUInt16LE(27016, 4);
  toHost.writeUInt16LE(27017, 6);
  toHost.set([0x11, 0x22], 8);
  const hostReceived = nextMessage(host.socket, (_value, isBinary) => isBinary);
  guest.socket.send(toHost);
  const hostEnvelope = await hostReceived;
  assert.equal(hostEnvelope.readUInt32LE(0), guest.peerId);
  assert.equal(hostEnvelope.readUInt16LE(4), 27016);
  assert.equal(hostEnvelope.readUInt16LE(6), 27017);
  assert.deepEqual([...hostEnvelope.subarray(8)], [0x11, 0x22]);

  const invalidSourcePort = Buffer.from(toGuest);
  invalidSourcePort.writeUInt16LE(0, 6);
  host.socket.send(invalidSourcePort);
  assert.deepEqual(await nextMessage(host.socket, (value) => value.type === 'error'), { type: 'error', code: 'BAD_REQUEST' });
  const oversized = Buffer.alloc(8 + 1_201);
  oversized.writeUInt32LE(guest.peerId, 0);
  oversized.writeUInt16LE(27017, 4);
  oversized.writeUInt16LE(27016, 6);
  host.socket.send(oversized);
  assert.deepEqual(await nextMessage(host.socket, (value) => value.type === 'error'), { type: 'error', code: 'BAD_REQUEST' });
});

test('only host changes privacy or starts; host disconnect closes room', async () => {
  const host = await connect();
  send(host.socket, createRequest());
  const created = await nextMessage(host.socket, (value) => value.type === 'joined');
  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: created.lobby.id });
  await nextMessage(guest.socket, (value) => value.type === 'joined');
  await nextMessage(host.socket, (value) => value.type === 'roster');

  send(guest.socket, { type: 'privacy', private: true });
  assert.deepEqual(await nextMessage(guest.socket, (value) => value.type === 'error'), { type: 'error', code: 'BAD_REQUEST' });
  send(guest.socket, { type: 'start' });
  assert.deepEqual(await nextMessage(guest.socket, (value) => value.type === 'error'), { type: 'error', code: 'BAD_REQUEST' });

  send(host.socket, { type: 'privacy', private: true });
  const privateState = await nextMessage(host.socket, (value) => value.type === 'privacy');
  assert.ok(privateState.code);
  await nextMessage(guest.socket, (value) => value.type === 'roster');
  send(host.socket, { type: 'start' });
  await nextMessage(host.socket, (value) => value.type === 'started');
  await nextMessage(guest.socket, (value) => value.type === 'started');

  const closed = nextMessage(guest.socket, (value) => value.type === 'closed');
  const guestDisconnected = once(guest.socket, 'close');
  host.socket.close();
  assert.equal((await closed).reason, 'HOST_DISCONNECTED');
  assert.equal((await guestDisconnected)[0], 4001);
});

test('co-op host starts alone and a second player can join in progress', async () => {
  const host = await connect();
  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', maxPlayers: 2 }));
  const first = await nextMessage(host.socket, (value) => value.type === 'joined');
  send(host.socket, { type: 'leave' });
  await nextMessage(host.socket, (value) => value.type === 'left');

  send(host.socket, createRequest({ kind: 'coop', mode: 'coop', name: 'Second Room', maxPlayers: 2 }));
  const second = await nextMessage(host.socket, (value) => value.type === 'joined');
  assert.notEqual(second.lobby.id, first.lobby.id);

  send(host.socket, { type: 'start' });
  assert.equal((await nextMessage(host.socket, (value) => value.type === 'started')).lobby.started, true);

  const guest = await connect();
  send(guest.socket, { type: 'join', lobbyId: second.lobby.id });
  const joined = await nextMessage(guest.socket, (value) => value.type === 'joined');
  assert.equal(joined.lobby.started, true, 'late guest receives the running room state');
  await nextMessage(host.socket, (value) => value.type === 'roster');

  const third = await connect();
  send(third.socket, { type: 'join', lobbyId: second.lobby.id });
  assert.deepEqual(await nextMessage(third.socket, (value) => value.type === 'error'), { type: 'error', code: 'FULL' });
});

test('accepts HTTPS Origin when HTTP terminates behind a TLS proxy', async () => {
  const client = await connect('https');
  assert.notEqual(client.peerId, 0);
});

test('revoked account cannot continue an existing multiplayer connection', async () => {
  const client = await connect();
  const closed = once(client.socket, 'close');
  accessAllowed = false;
  send(client.socket, { type: 'list', kind: 'versus' });
  const [code] = await closed;
  assert.equal(code, 1008);
});

test('rejects websocket upgrades with a foreign Origin', async () => {
  const socket = new WebSocket(url, { origin: 'https://attacker.invalid' });
  sockets.add(socket);
  const [error] = await once(socket, 'error');
  assert.match(error.message, /403|Unexpected server response/);
});
