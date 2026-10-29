import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { attachSessionLease } from './sessionLease.js';

test('one live instance per account, with release on disconnect', async () => {
  const server = createServer();
  const lease = attachSessionLease(server, { authorize: req => !!req.headers['x-account'],
    identity: req => ({ id: req.headers['x-account'] }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const connect = async account => {
    const ws = new WebSocket(`ws://${host}/__session/game-instance`, { origin: `http://${host}`, headers: { 'x-account': account } });
    const message = once(ws, 'message'); await once(ws, 'open');
    return { ws, type: JSON.parse((await message)[0].toString()).type };
  };
  try {
    const first = await connect('one'); assert.equal(first.type, 'acquired');
    const duplicate = await connect('one'); assert.equal(duplicate.type, 'occupied');
    const other = await connect('two'); assert.equal(other.type, 'acquired');
    first.ws.close(); await once(first.ws, 'close');
    // Wait for the server's close handler, which frees the lease.
    let retry;
    for (let attempt = 0; attempt < 20; ++attempt) {
      retry = await connect('one');
      if (retry.type === 'acquired') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(retry.type, 'acquired'); retry.ws.close(); other.ws.close();
  } finally { lease.close(); server.close(); }
});

test('lease rejects unauthenticated and foreign-origin upgrades', async () => {
  const server = createServer();
  const lease = attachSessionLease(server, { authorize: req => req.headers['x-account'] === 'one',
    identity: req => req.headers['x-account'] ? { id: req.headers['x-account'] } : null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const rejected = options => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}/__session/game-instance`, options);
    ws.on('error', () => {});
    ws.once('unexpected-response', (_req, response) => {
      response.resume(); ws.terminate(); resolve(response.statusCode);
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('Unauthorized lease acquired')); });
  });
  try {
    assert.equal(await rejected({ origin: `http://${host}` }), 403);
    assert.equal(await rejected({ origin: 'https://foreign.example', headers: { 'x-account': 'one' } }), 403);
    assert.equal(await rejected({ headers: { 'x-account': 'one' } }), 403);
  } finally { lease.close(); server.close(); }
});

test('an unresponsive stale connection is reclaimed without logging in again', async () => {
  const server = createServer();
  const lease = attachSessionLease(server, { authorize: () => true, identity: () => ({ id: 'one' }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const connect = async autoPong => {
    const ws = new WebSocket(`ws://${host}/__session/game-instance`, { origin: `http://${host}`, autoPong });
    const message = once(ws, 'message'); await once(ws, 'open');
    return { ws, type: JSON.parse((await message)[0].toString()).type };
  };
  try {
    const stale = await connect(false); assert.equal(stale.type, 'acquired');
    const closed = once(stale.ws, 'close');
    const current = await connect(true); assert.equal(current.type, 'acquired');
    await closed;
    const duplicate = await connect(true); assert.equal(duplicate.type, 'occupied');
    current.ws.close(); duplicate.ws.close();
  } finally { lease.close(); server.close(); }
});

test('a new login immediately replaces its revoked account lease', async () => {
  let validToken = 'old';
  const server = createServer();
  const lease = attachSessionLease(server, {
    authorize: req => req.headers['x-token'] === validToken,
    identity: () => ({ id: 'one' }),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  const connect = async token => {
    const ws = new WebSocket(`ws://${host}/__session/game-instance`, { origin: `http://${host}`, headers: { 'x-token': token } });
    const message = once(ws, 'message'); await once(ws, 'open');
    assert.equal(JSON.parse((await message)[0].toString()).type, 'acquired');
    return ws;
  };
  try {
    const old = await connect('old');
    const closed = once(old, 'close');
    validToken = 'new';
    const current = await connect('new');
    assert.equal((await closed)[0], 4001);
    assert.equal(current.readyState, WebSocket.OPEN);
    current.close();
  } finally { lease.close(); server.close(); }
});
