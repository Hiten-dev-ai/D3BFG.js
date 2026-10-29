// Exercise the native-menu command bridge against the actual lobby server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('../web/node_modules/ws');

(async () => {
  const { attachMultiplayerServer } = await import('../web/multiplayerServer.js');
  const server = createServer();
  const relay = attachMultiplayerServer(server);
  const clients = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const context = vm.createContext({
    location: { protocol: 'http:', host }, TextEncoder, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout,
    WebSocket: class extends WebSocket { constructor(url) { super(url, { origin: `http://${host}` }); this.on('error', () => {}); } },
  });
  try {
    for (const name of ['multiplayerClient.ts', 'nativeMultiplayer.ts']) {
      let source = fs.readFileSync(path.join(__dirname, '../web/src', name), 'utf8');
      source = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
      vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }), context);
    }
    vm.runInContext('this.factory = (changed) => { const client = new MultiplayerClient(changed); return { client, bridge: createNativeMultiplayerBridge(client, changed) }; };', context);
    const waitUntil = async predicate => {
      const end = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('Native multiplayer bridge timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    const waitPacket = async (client, port, maxBytes) => {
      let packet = null;
      await waitUntil(() => { packet = client.receivePacket(port, maxBytes); return packet !== null; });
      return packet;
    };
    const a = context.factory(() => {}); const b = context.factory(() => {}); const c = context.factory(() => {});
    clients.push(a.client, b.client, c.client);
    assert.equal(a.client.state.status, 'disconnected');
    a.bridge.action('mpCreate|versus|Native Room|deathmatch|2|0|bad/map');
    assert.equal(a.bridge.getText('mpError'), 'BAD_REQUEST');
    assert.match(a.bridge.getText('mpErrorMessage'), /Map must be a basename/i);
    assert.equal(a.client.state.status, 'disconnected', 'invalid native command is rejected before opening a socket');
    a.bridge.action('mpCreate|versus|Native Room|deathmatch|2|0|d3dm1');
    await waitUntil(() => a.client.state.lobby);
    a.bridge.action('mpStart');
    await waitUntil(() => a.bridge.getText('mpError') === 'WAITING_FOR_PLAYERS');
    assert.equal(a.client.state.lobby.started, false, 'a solo start request leaves the relay room waiting');
    assert.match(a.bridge.getText('mpErrorMessage'), /at least two players/i);
    a.bridge.action('mpClearError');
    b.bridge.action('mpListVersus');
    await waitUntil(() => b.bridge.getNumber('mpLobbyCount') === 1);
    b.bridge.action(`mpJoin|${b.bridge.getText('mpLobbyId0')}`);
    await waitUntil(() => b.client.state.lobby && a.client.state.lobby.players === 2);
    const packetCounter = new Int32Array(new SharedArrayBuffer(9 * Int32Array.BYTES_PER_ELEMENT));
    b.client.setPacketCounter(packetCounter);
    const maximumNativePacket = Uint8Array.from({ length: 1200 }, (_, index) => index & 0xff);
    assert.equal(a.client.sendPacket(b.client.state.peerId, 27016, 27015, maximumNativePacket), true);
    await waitUntil(() => Atomics.load(packetCounter, 8) === 1);
    const relayedPacket = await waitPacket(b.client, 27016, 1200);
    assert.equal(Atomics.load(packetCounter, 8), 0, 'consuming a packet clears the atomic empty-poll gate');
    assert.equal(relayedPacket.peerId, a.client.state.peerId, 'the relay reports the actual sender peer ID');
    assert.equal(relayedPacket.port, 27016, 'the relay preserves the virtual destination port');
    assert.equal(relayedPacket.sourcePort, 27015, 'the relay preserves the sender virtual port');
    assert.deepEqual([...relayedPacket.data], [...maximumNativePacket], 'the full native MTU payload survives the relay');
    assert.equal(b.client.sendPacket(a.client.state.peerId, 27015, 27016, new Uint8Array([9, 8, 7])), true);
    const replyPacket = await waitPacket(a.client, 27015, 3);
    assert.equal(replyPacket.peerId, b.client.state.peerId, 'reply routing reports the remote peer ID');
    assert.equal(replyPacket.sourcePort, 27016, 'asymmetric source and destination ports survive a full round trip');
    c.bridge.action(`mpJoin|${a.bridge.getText('mpRoomId')}`);
    await waitUntil(() => c.bridge.getText('mpError') === 'FULL');
    assert.match(c.bridge.getText('mpErrorMessage'), /no open player slots/i);
    c.bridge.action('mpClearError');
    assert.equal(c.bridge.getText('mpError'), '');
    a.bridge.action('mpTogglePrivacy');
    await waitUntil(() => a.bridge.getText('mpPrivateCode').length > 0);
    assert.equal(b.bridge.getText('mpPrivateCode'), '', 'private codes belong to the creator');
    assert.equal(a.bridge.getNumber('mpIsHost'), 1);
    a.bridge.action('mpStart');
    await waitUntil(() => a.bridge.getNumber('mpStarted') === 1 && b.bridge.getNumber('mpStarted') === 1);
    a.bridge.action('mpDisconnect');
    await waitUntil(() => b.client.state.lobby === null);
    assert.equal(a.client.state.status, 'disconnected');
    a.bridge.action('mpCreate|coop|Native Co-op|coop|2|0|mars_city1|7|1');
    await waitUntil(() => a.client.state.lobby?.kind === 'coop');
    assert.equal(a.bridge.getNumber('mpRoomLives'), 7, 'co-op lobby exposes its configured life budget to native code');
    assert.equal(a.client.state.lobby.friendlyFire, true, 'native Friendly Fire selection reaches the server');
    a.bridge.action('mpStart');
    await waitUntil(() => a.bridge.getNumber('mpStarted') === 1);
    assert.equal(a.bridge.getNumber('mpRoomPlayers'), 1, 'co-op host can start without a guest');
    b.bridge.action('mpListCoop');
    await waitUntil(() => b.bridge.getNumber('mpLobbyCount') === 1);
    b.bridge.action(`mpJoin|${b.bridge.getText('mpLobbyId0')}`);
    await waitUntil(() => a.client.state.lobby?.players === 2 && b.client.state.lobby?.kind === 'coop');
    assert.equal(b.bridge.getNumber('mpStarted'), 1, 'late guest receives the active match state');
    assert.equal(b.client.state.lobby.friendlyFire, true, 'late guest receives the same Friendly Fire setting');
    assert.equal(a.bridge.getNumber('mpIsHost'), 1);
    a.bridge.action('mpOpenCoopCampaignPicker');
    assert.equal(a.bridge.getNumber('mpCoopCampaignPicker'), 1, 'host can use the original campaign flow');
    a.bridge.action('mpOpenCoopDevPicker');
    assert.equal(a.bridge.getNumber('mpCoopDevPicker'), 1);
    a.bridge.action('mpCloseCoopCampaignPicker');
    assert.equal(a.bridge.getNumber('mpCoopCampaignPicker'), 0);
    a.bridge.action('mpBeginCoopConnect');
    assert.equal(a.bridge.getNumber('mpCoopConnecting'), 1, 'final native campaign screen owns its connecting handoff');
    assert.equal(a.bridge.getNumber('mpCoopCampaignPicker'), 0);
    a.bridge.action('mpHostReady');
    assert.equal(a.bridge.getNumber('mpCoopConnecting'), 0, 'native map-ready ends the held-screen handoff');
    b.bridge.action('mpOpenCoopCampaignPicker');
    assert.equal(b.bridge.getNumber('mpCoopCampaignPicker'), 0, 'guests cannot choose host progress');
    a.bridge.action('mpOpenCoopSavePicker');
    assert.equal(a.bridge.getNumber('mpCoopSavePicker'), 1, 'co-op host can open the native save picker');
    a.bridge.action('mpCloseCoopSavePicker');
    assert.equal(a.bridge.getNumber('mpCoopSavePicker'), 0, 'closing the picker clears only its local flag');
    b.bridge.action('mpOpenCoopSavePicker');
    assert.equal(b.bridge.getNumber('mpCoopSavePicker'), 0, 'co-op guests cannot open the native save picker');
    assert.match(b.bridge.getText('mpErrorMessage'), /only the co-op host/i);
    b.bridge.action('mpNativeError|Could not connect to the native multiplayer session.');
    assert.equal(b.bridge.getNumber('mpInRoom'), 0, 'failed native connection leaves its relay room');
    assert.equal(b.bridge.getNumber('mpCoopSavePicker'), 0);
    assert.match(b.bridge.getText('mpErrorMessage'), /could not connect/i);
    await waitUntil(() => a.client.state.lobby?.players === 1);
    assert.equal(b.client.canReconnect, false, 'a cached snapshot alone cannot advertise a live room');
    b.bridge.action('mpValidateResume');
    await waitUntil(() => b.client.canReconnect);
    a.bridge.action('mpDisconnect');
    await waitUntil(() => b.client.resumableGame === null);
    assert.equal(b.client.canReconnect, false, 'host closure removes Continue/Reconnect for a non-member watcher');
    const cancelled = context.factory(() => {}); clients.push(cancelled.client);
    cancelled.bridge.action('mpCreate|coop|Cancelled pending request|coop|2|0|mars_city1|3|0');
    cancelled.bridge.action('mpCancelPending');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cancelled.client.state.status, 'disconnected');
    assert.equal(cancelled.client.state.lobby, null);
    assert.equal(cancelled.bridge.getText('mpError'), '', 'deliberate Back must suppress the rejected connect callback');
    console.log('Native multiplayer bridge: versus flow, packet relay, privacy, full rooms, solo co-op start, late guest admission and host-only save picker checks passed.');
  } finally {
    for (const client of clients) client.dispose();
    relay.close(); server.close(); await once(server, 'close');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
