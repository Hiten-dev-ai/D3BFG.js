import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scryptSync, createHash } from 'node:crypto';
import { createAccountSession } from './accountSession.js';
import { createSaveSyncStore } from './saveSyncServer.js';

test('account authorization, durable sessions, private saves and revocation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'legacy.json'), salt = 'ab'.repeat(24), password = 'fixture-password-123';
  fs.writeFileSync(config, JSON.stringify({ salt, passwordHash: scryptSync(password, salt, 64).toString('hex') }));
  const stores = new Map(); let session;
  const saveStoreForAccount = id => {
    if (!stores.has(id)) stores.set(id, createSaveSyncStore(path.join(directory, 'saves', id), { authorize: () => session.accountExists(id) }));
    return stores.get(id);
  };
  const options = { directory: path.join(directory, 'accounts'), legacyConfig: config,
    ownerEmail: 'owner@example.test', production: false, saveStoreForAccount, removeAccountSaves: id => saveStoreForAccount(id).remove() };
  session = createAccountSession(options);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await session.handle(req, res, url)) return;
    const user = session.identity(req);
    if (!user) { res.writeHead(401); res.end(); return; }
    if (await saveStoreForAccount(user.id).handle(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(route, method = 'GET', body, cookie = '', headers = {}) {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {}; try { data = await response.json(); } catch {}
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }
  const login = async (login, password) => call('/__session/login', 'POST', { login, password });
  assert.equal((await call('/__session/accounts')).status, 401);
  assert.equal((await login('Hiten', 'wrong')).status, 401);
  const owner = await login('owner@example.test', password); assert.equal(owner.status, 200); assert.equal(owner.data.user.role, 'owner');
  assert.equal(JSON.stringify(owner.data).includes('passwordHash'), false);
  const create = async (name, role) => call('/__session/accounts', 'POST', { name, email: name + '@example.test', password, role }, owner.cookie);
  const first = await create('PlayerOne', 'player'), second = await create('PlayerTwo', 'player'), operator = await create('Operator', 'op');
  assert.equal(first.status, 201); assert.equal(operator.data.user.role, 'op');
  assert.equal((await create('PlayerOne', 'player')).status, 400);
  const one = await login('PlayerOne', password), two = await login('PlayerTwo', password), op = await login('Operator', password);
  assert.equal((await call('/__session/accounts', 'GET', undefined, one.cookie)).status, 403);
  assert.equal((await call('/__session/accounts/' + owner.data.user.id, 'PATCH', { name: 'Hijack', email: 'h@example.test', role: 'player' }, op.cookie)).status, 403);
  assert.equal((await call('/__session/profile', 'PATCH', { name: 'Changed', email: 'changed@example.test' }, one.cookie, { Origin: 'https://foreign.test' })).status, 403);
  const empty = await call('/__browser_sync/manifest', 'GET', undefined, one.cookie);
  const bytes = Buffer.from('campaign-save-one');
  const entry = { path: 'base/savegame/GAME-test.save', mtimeMs: 1234, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
  assert.equal((await call('/__browser_sync/snapshot', 'POST', { baseRevision: empty.data.revision, files: [entry] }, one.cookie)).status, 200);
  assert.equal((await call('/__browser_sync/manifest', 'GET', undefined, two.cookie)).data.files.length, 0);
  assert.equal((await call(`/__session/accounts/${first.data.user.id}/saves`, 'GET', undefined, owner.cookie)).data.files.length, 1);
  // A fresh service instance accepts the same durable session; no server timeout exists.
  session = createAccountSession(options);
  assert.equal((await call('/__session/status', 'GET', undefined, one.cookie)).data.authenticated, true);
  assert.equal((await login('PlayerOne', 'incorrect-password')).status, 401);
  assert.equal((await call('/__session/status', 'GET', undefined, one.cookie)).data.authenticated, true,
    'failed login must not evict the active session');
  const otherBrowser = await login('PlayerOne', password);
  assert.equal((await call('/__session/status', 'GET', undefined, one.cookie)).data.authenticated, false,
    'new successful login replaces the previous browser session');
  assert.equal((await call('/__session/status', 'GET', undefined, two.cookie)).data.authenticated, true,
    'other accounts remain signed in');
  assert.equal((await call('/__browser_sync/manifest', 'GET', undefined, otherBrowser.cookie)).data.files.length, 1);
  assert.equal((await call('/__session/password', 'POST', { currentPassword: password, newPassword: 'different-password-123' }, otherBrowser.cookie)).status, 200);
  assert.equal((await call('/__session/status', 'GET', undefined, otherBrowser.cookie)).data.authenticated, false);
  const changed = await login('PlayerOne', 'different-password-123');
  assert.equal((await call('/__session/profile', 'PATCH', { name: 'RenamedPlayer', email: 'renamed@example.test' }, changed.cookie)).data.user.name, 'RenamedPlayer');
  const removed = await call('/__session/profile', 'DELETE', { password: 'different-password-123', confirm: 'DELETE' }, changed.cookie);
  assert.equal(removed.status, 200); assert.equal(fs.existsSync(path.join(directory, 'saves', first.data.user.id, 'snapshot.json')), false);
  assert.equal((await call('/__session/status', 'GET', undefined, changed.cookie)).data.authenticated, false);
  const blockedWrite = await call('/__browser_sync/snapshot', 'POST', { baseRevision: '', files: [] }, changed.cookie); assert.equal(blockedWrite.status, 401);
  assert.equal((await call('/__session/accounts', 'DELETE', { ids: [owner.data.user.id], confirm: 'DELETE' }, owner.cookie)).status, 403);
  assert.equal((await call('/__session/accounts', 'DELETE', { ids: [second.data.user.id], confirm: 'DELETE' }, op.cookie)).status, 200);
  const protectedPlayer = await create('ProtectedPlayer', 'player');
  function delayedDelete() {
    let release, response;
    const body = new Promise(resolve => { release = resolve; });
    const req = { method: 'DELETE', headers: { host: new URL(origin).host, origin, cookie: op.cookie },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(await body)); } };
    const res = { statusCode: 200, setHeader() {}, end(value) { response = JSON.parse(value); } };
    const pending = session.handle(req, res, new URL('/__session/accounts', origin));
    return { release: () => release({ ids: [protectedPlayer.data.user.id], confirm: 'DELETE' }),
      finish: async () => { await pending; return { status: res.statusCode, data: response }; } };
  }
  const demotedRequest = delayedDelete();
  assert.equal((await call('/__session/accounts/' + operator.data.user.id, 'PATCH', {
    name: 'Operator', email: 'operator@example.test', role: 'player',
  }, owner.cookie)).status, 200);
  demotedRequest.release();
  assert.equal((await demotedRequest.finish()).status, 403);
  assert.equal(session.accountExists(protectedPlayer.data.user.id), true);
  assert.equal((await call('/__session/accounts/' + operator.data.user.id, 'PATCH', {
    name: 'Operator', email: 'operator@example.test', role: 'op',
  }, owner.cookie)).status, 200);
  const revokedRequest = delayedDelete();
  assert.equal((await call('/__session/accounts/' + operator.data.user.id + '/logout', 'POST', {}, owner.cookie)).status, 200);
  revokedRequest.release();
  assert.equal((await revokedRequest.finish()).status, 401);
  assert.equal(session.accountExists(protectedPlayer.data.user.id), true);
  assert.equal((await call('/__session/status', 'GET', undefined, op.cookie)).data.authenticated, false);
  assert.equal(fs.readFileSync(path.join(directory, 'accounts/accounts.json'), 'utf8').includes(password), false);
});
