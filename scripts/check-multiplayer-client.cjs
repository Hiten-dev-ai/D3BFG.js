const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(value); }
  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
}

const tsPath = path.join(__dirname, '../web/src/multiplayerClient.ts');
const source = stripTypeScriptTypes(fs.readFileSync(tsPath, 'utf8'), { mode: 'strip' })
  .replace(/^export\s+/gm, '');
const context = vm.createContext({
  WebSocket: FakeWebSocket,
  location: { protocol: 'https:', host: 'game.example.test' },
  setTimeout,
  clearTimeout,
  Uint8Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  Number,
  JSON,
  Promise,
  Set,
  Error,
});
new vm.Script(`${source}\nglobalThis.MultiplayerClient = MultiplayerClient;`).runInContext(context);
const { MultiplayerClient } = context;

function readControl(socket, index = socket.sent.length - 1) {
  return JSON.parse(socket.sent[index]);
}

function makePacket(peerId, destinationPort, payload, sourcePort = destinationPort, version = 2) {
  const headerBytes = version === 2 ? 8 : 6;
  const bytes = new Uint8Array(headerBytes + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, peerId, true);
  view.setUint16(4, destinationPort, true);
  if (version === 2) view.setUint16(6, sourcePort, true);
  bytes.set(payload, headerBytes);
  return bytes.buffer;
}

(async () => {
  FakeWebSocket.instances.length = 0;
  const changes = [];
  const client = new MultiplayerClient((state) => changes.push(state));
  assert.equal(FakeWebSocket.instances.length, 0, 'construction must not open a socket');
  const pendingConnect = client.connect();
  assert.equal(client.state.status, 'connecting');
  let socket = FakeWebSocket.instances[0];
  const staleMessage = socket.onmessage;
  const pendingResult = pendingConnect.then(() => null, (error) => error);
  assert.equal(socket.url, 'wss://game.example.test/__multiplayer');
  client.disconnect();
  assert((await pendingResult) instanceof Error, 'disconnect rejects the pending handshake');
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.state.peerId, null);
  assert.equal(socket.closeCalls, 1);

  const connected = client.connect();
  socket = FakeWebSocket.instances[1];
  assert.equal(client.state.status, 'connecting');
  socket.open();
  assert.equal(socket.sent.length, 0, 'connect must not auto-send singleplayer or lobby requests');
  socket.message(JSON.stringify({ type: 'welcome', peerId: 41 }));
  assert.deepEqual(readControl(socket), { type: 'transport', version: 2, gameProtocol: 6 });
  socket.message(JSON.stringify({ type: 'transport', version: 2 }));
  await connected;
  assert.equal(client.state.status, 'connected');
  assert.equal(client.state.peerId, 41);
  staleMessage({ data: JSON.stringify({ type: 'welcome', peerId: 99 }) });
  assert.equal(client.state.peerId, 41, 'callbacks from a disconnected socket cannot affect a new session');

  const lobby = { id: 'lobby-1', name: 'Test room', kind: 'coop', players: 1, maxPlayers: 2,
    private: false, hostPeerId: 41, started: false, mode: 'coop' };
  assert.equal(client.list('coop'), true);
  assert.equal(client.state.listing, true, 'room scan remains pending until response');
  assert.deepEqual(readControl(socket), { type: 'list', kind: 'coop' });
  socket.message(JSON.stringify({ type: 'lobbies', lobbies: [{ ...lobby, id: 'public-room' }] }));
  assert.equal(client.state.lobbies[0].id, 'public-room');
  assert.equal(client.state.listing, false, 'room scan finishes on response');
  assert.equal(client.join({ lobbyId: 'lobby-1', name: 'Player One' }), true);
  assert.deepEqual(readControl(socket), { type: 'join', lobbyId: 'lobby-1', name: 'Player One' });
  socket.message(JSON.stringify({ type: 'joined', lobby, peerId: 41 }));
  socket.message(JSON.stringify({ type: 'roster', lobby, roster: [{ peerId: 41, name: 'Player One' }] }));
  assert.equal(client.state.lobby.id, 'lobby-1');
  assert.equal(client.state.roster[0].name, 'Player One');
  socket.message(JSON.stringify({ type: 'started', lobby: { ...lobby, started: true } }));
  assert.equal(client.state.started, true);

  const outbound = new Uint8Array([4, 5, 6]);
  assert.equal(client.sendPacket(72, 0x1234, 0x5678, outbound), true);
  const envelope = new Uint8Array(socket.sent.at(-1));
  const envelopeView = new DataView(envelope.buffer);
  assert.equal(envelopeView.getUint32(0, true), 72);
  assert.equal(envelopeView.getUint16(4, true), 0x1234);
  assert.equal(envelopeView.getUint16(6, true), 0x5678);
  assert.deepEqual([...envelope.slice(8)], [4, 5, 6]);
  socket.bufferedAmount = 1024 * 1024;
  assert.equal(client.sendPacket(72, 2, 3, outbound), false, 'socket backpressure rejects sends');
  socket.bufferedAmount = 0;

  socket.message(makePacket(72, 9, [1, 2, 3], 8));
  assert.equal(client.receivePacket(9, 2), null, 'oversized receive remains queued');
  const received = client.receivePacket(9, 3);
  assert.equal(received.peerId, 72);
  assert.equal(received.sourcePort, 8);
  assert.deepEqual([...received.data], [1, 2, 3]);
  for (let i = 0; i < 257; i += 1) socket.message(makePacket(72, 10, [i & 255]));
  let queued = 0;
  while (client.receivePacket(10, 1)) queued += 1;
  assert.equal(queued, 256, 'receive queue is capped at 256 packets');
  const largePacket = makePacket(72, 11, new Uint8Array(1_200));
  for (let i = 0; i < 257; i += 1) socket.message(largePacket);
  let largeQueued = 0;
  while (client.receivePacket(11, 1_200)) largeQueued += 1;
  assert.equal(largeQueued, 256, 'maximum-size native packets are accepted up to the packet-count cap');
  socket.message(makePacket(72, 11, new Uint8Array(1_201)));
  assert.equal(client.receivePacket(11, 1_200), null, 'packets larger than the native MTU are dropped');
  assert.equal(client.sendPacket(72, 11, 11, new Uint8Array(1_201)), false, 'outbound packets respect the native MTU');

  assert.equal(client.leave(), true);
  assert.deepEqual(readControl(socket), { type: 'leave' });
  assert.equal(client.state.lobby, null);
  assert.equal(client.state.started, false);
  assert.equal(client.receivePacket(10, 1), null, 'leave clears queued packets');
  assert.equal(client.sendPacket(72, 10, outbound), false, 'relay is disabled outside a room');
  socket.message(JSON.stringify({ type: 'error', code: 'FULL' }));
  assert.equal(client.state.error, 'FULL');
  assert.match(client.state.errorDetail, /no open player slots/i);
  assert.equal(client.create({ name: 'New room', kind: 'versus', private: true, maxPlayers: 2, mode: 'deathmatch', map: 'bad/map' }), false);
  assert.equal(client.state.error, 'BAD_REQUEST');
  assert.match(client.state.errorDetail, /Map must be a basename/i);
  assert.equal(client.create({ name: 'New room', kind: 'versus', private: true, maxPlayers: 8, mode: 'deathmatch' }), true);
  assert.equal(client.state.error, null, 'a new valid request clears the prior validation error');
  assert.equal(client.state.errorDetail, null);
  assert.deepEqual(readControl(socket), { type: 'create', name: 'New room', kind: 'versus', private: true, maxPlayers: 8, mode: 'deathmatch' });
  socket.message(JSON.stringify({ type: 'error', code: 'BAD_REQUEST' }));
  assert.equal(client.state.error, 'BAD_REQUEST');
  assert.match(client.state.errorDetail, /create request/i, 'server rejection includes bounded operation context');
  client.clearError();
  assert.equal(client.state.errorDetail, null, 'clearing an error clears its detail');
  const privateLobby = { ...lobby, id: 'private-room', kind: 'versus', players: 1, maxPlayers: 8,
    private: true, mode: 'deathmatch' };
  socket.message(JSON.stringify({ type: 'joined', lobby: privateLobby, peerId: 41, code: 'ABC123' }));
  socket.message(makePacket(72, 12, [7]));
  const oldRoomMessage = socket.onmessage;
  client.disconnect();
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.state.lobby, null);
  assert.equal(client.state.privateCode, null);
  assert.equal(client.state.started, false);
  assert.equal(client.receivePacket(12, 1), null, 'disconnect clears queued room packets');
  assert.equal(socket.closeCalls, 1);

  const reconnected = client.connect();
  socket = FakeWebSocket.instances[2];
  socket.open();
  socket.message(JSON.stringify({ type: 'welcome', peerId: 42 }));
  assert.deepEqual(readControl(socket), { type: 'transport', version: 2, gameProtocol: 6 });
  socket.message(JSON.stringify({ type: 'error', code: 'BAD_REQUEST' }));
  await reconnected;
  oldRoomMessage({ data: JSON.stringify({ type: 'error', code: 'FULL' }) });
  assert.equal(client.state.peerId, 42);
  assert.equal(client.state.error, null, 'old room callbacks cannot change a reconnected session');
  socket.message(JSON.stringify({ type: 'joined', lobby, peerId: 42 }));
  assert.equal(client.sendPacket(72, 0x1234, 0x5678, outbound), true, 'older servers use the legacy packet envelope');
  const legacyEnvelope = new Uint8Array(socket.sent.at(-1));
  assert.equal(legacyEnvelope.byteLength, 6 + outbound.byteLength);
  socket.message(makePacket(72, 0x1234, outbound, 0x5678, 1));
  assert.equal(client.receivePacket(0x1234, 3).sourcePort, 0x1234,
    'legacy packets retain the shared-port source assumption');

  socket.message('{malformed json');
  assert.equal(client.state.error, 'BAD_RESPONSE');
  client.dispose();
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.state.peerId, null);
  assert.equal(client.state.error, null);
  assert.equal(socket.closeCalls, 1);
  await assert.rejects(client.connect(), /disposed/, 'disposed clients reject reconnect attempts');
  const deadlines = [];
  context.setTimeout = (callback, delay) => { deadlines.push({ callback, delay }); return deadlines.length; };
  context.clearTimeout = () => {};
  const silent = new MultiplayerClient();
  const timedOut = assert.rejects(silent.connect(), /timed out/);
  assert.equal(deadlines.at(-1).delay, 8000);
  deadlines.at(-1).callback();
  await timedOut;
  assert.equal(silent.state.status, 'disconnected');
  assert.equal(silent.state.error, 'CONNECTION_TIMEOUT');
  silent.dispose();
  assert(changes.length > 0, 'state transitions invoke onChange');
  console.log('Multiplayer client: lazy connect, transport negotiation and fallback, reconnect isolation, room state, errors, packet bounds, and cleanup passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
