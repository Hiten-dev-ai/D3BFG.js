import assert from 'node:assert/strict';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createPrivateSession } from './privateSession.js';

const cookieName = '__Host-doom3_device';
const password = randomBytes(24).toString('base64url');
let configRoot;
let server;
let session;
let origin;
let signingKey;

before(async () => {
  configRoot = await mkdtemp(path.join(tmpdir(), 'doom3-private-session-'));
  const salt = randomBytes(32).toString('hex');
  signingKey = randomBytes(32).toString('hex');
  const configPath = path.join(configRoot, 'auth.json');
  await writeFile(configPath, JSON.stringify({
    salt,
    passwordHash: scryptSync(password, salt, 64).toString('hex'),
    signingKey,
  }));
  session = createPrivateSession(configPath, { production: true });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await session.handle(req, res, url)) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  if (configRoot) await rm(configRoot, { recursive: true, force: true });
});

async function post(pathname, body, headers = {}) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Real-IP': `test-${randomBytes(8).toString('hex')}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function signedCookie(expiry) {
  const nonce = randomBytes(32).toString('base64url');
  const token = `${nonce}.${expiry}`;
  const signature = createHmac('sha256', Buffer.from(signingKey, 'hex')).update(token).digest('base64url');
  return `${cookieName}=${token}.${signature}`;
}

test('production configuration is mandatory', () => {
  assert.throws(() => createPrivateSession(undefined, { production: true }), /DOOM3BFG_AUTH_CONFIG is required/);
});

test('correct password issues an authenticated secure persistent host cookie', async () => {
  const response = await post('/__session/login', { password });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, /^__Host-doom3_device=[A-Za-z0-9_-]{43}\.\d{13}\.[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /(?:^|; )Path=\//i);
  assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/i);
  assert.match(cookie, /(?:^|; )Secure(?:;|$)/i);
  assert.match(cookie, /(?:^|; )SameSite=Strict(?:;|$)/i);
  assert.match(cookie, /(?:^|; )Max-Age=34560000(?:;|$)/i);

  const status = await fetch(`${origin}/__session/status`, { headers: { Cookie: cookie.split(';', 1)[0] } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { authenticated: true, required: true });
});

test('wrong password is rejected without issuing a cookie', async () => {
  const response = await post('/__session/login', { password: randomBytes(24).toString('base64url') });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: 'Incorrect password.' });
});

test('tampered, expired, future, and malformed cookies are rejected', async () => {
  const login = await post('/__session/login', { password });
  const validCookie = login.headers.get('set-cookie').split(';', 1)[0];
  const [prefix, token, signature] = validCookie.split('=')[1].split('.');
  const now = Date.now();
  const invalidCookies = [
    `${cookieName}=${prefix}.${token}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
    signedCookie(now - 1),
    signedCookie(now + 400 * 24 * 60 * 60 * 1000 + 5 * 60_000),
    `${cookieName}=broken`,
    `${cookieName}=abc.${now}.not-a-signature`,
    `${cookieName}=${randomBytes(300).toString('base64url')}`,
  ];

  for (const cookie of invalidCookies) {
    const response = await fetch(`${origin}/__session/status`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: false, required: true }, cookie.slice(0, 60));
  }
});

test('login and logout reject wrong origins and non-POST methods', async () => {
  const wrongOrigin = await post('/__session/login', { password }, { Origin: 'http://attacker.invalid' });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('set-cookie'), null);

  const wrongOriginLogout = await fetch(`${origin}/__session/logout`, {
    method: 'POST',
    headers: { Origin: 'http://attacker.invalid' },
  });
  assert.equal(wrongOriginLogout.status, 403);
  assert.equal(wrongOriginLogout.headers.get('set-cookie'), null);

  const getLogin = await fetch(`${origin}/__session/login`, { headers: { Origin: origin } });
  assert.equal(getLogin.status, 403);
  const putLogin = await fetch(`${origin}/__session/login`, {
    method: 'PUT',
    headers: { Origin: origin },
    body: '{}',
  });
  assert.equal(putLogin.status, 403);
});

test('the sixth consecutive password attempt from one address is rate limited', async () => {
  const ip = `rate-limit-${randomBytes(8).toString('hex')}`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await post('/__session/login', { password: randomBytes(24).toString('base64url') }, { 'X-Real-IP': ip });
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const limited = await post('/__session/login', { password }, { 'X-Real-IP': ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('set-cookie'), null);
});
