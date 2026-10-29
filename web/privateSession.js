import fs from 'node:fs';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const cookieName = '__Host-doom3_device';
const lifetime = 400 * 24 * 60 * 60;

export function createPrivateSession(configPath, { production = false } = {}) {
  if (!configPath) {
    if (production) throw new Error('DOOM3BFG_AUTH_CONFIG is required in production.');
    return { authenticated: () => true, handle: async (req, res, url) => {
      if (url.pathname !== '/__session/status') return false;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ authenticated: true, required: false }));
      return true;
    } };
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const apacheHash = typeof config.apr1Hash === 'string' && /^\$apr1\$[a-zA-Z0-9./]{1,8}\$[a-zA-Z0-9./]{22}$/.test(config.apr1Hash);
  if ((!apacheHash && (!/^[a-f0-9]{32,128}$/i.test(config.salt) || !/^[a-f0-9]{128}$/i.test(config.passwordHash))) ||
      !/^[a-f0-9]{64,128}$/i.test(config.signingKey)) throw new Error('Invalid private authentication configuration.');
  const key = Buffer.from(config.signingKey, 'hex');
  const expected = apacheHash ? Buffer.from(config.apr1Hash) : Buffer.from(config.passwordHash, 'hex');
  const attempts = new Map();
  const sign = value => createHmac('sha256', key).update(value).digest('base64url');
  function authenticated(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!cookie || cookie.length > 256) return false;
    const parts = cookie.split('.');
    if (parts.length !== 3 || !/^\d{10,13}$/.test(parts[1]) || !/^[a-zA-Z0-9_-]{43}$/.test(parts[0])) return false;
    const expiry = Number(parts[1]);
    if (expiry < Date.now() || expiry > Date.now() + lifetime * 1000 + 60_000) return false;
    const wanted = Buffer.from(sign(parts[0] + '.' + parts[1]));
    const supplied = Buffer.from(parts[2]);
    return wanted.length === supplied.length && timingSafeEqual(wanted, supplied);
  }
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    try { return new URL(String(req.headers.origin)).host === req.headers.host; } catch { return false; }
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/__session/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); return true; };
    if (url.pathname === '/__session/status' && req.method === 'GET') {
      return send(200, { authenticated: authenticated(req), required: true });
    }
    if (req.method !== 'POST' || !sameOrigin(req)) return send(403, { error: 'Request origin rejected.' });
    if (url.pathname === '/__session/logout') {
      res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      res.setHeader('Clear-Site-Data', '"cache"');
      return send(200, { authenticated: false });
    }
    if (url.pathname !== '/__session/login') return send(404, { error: 'Not found.' });
    const now = Date.now();
    for (const [address, value] of attempts) if (value.until < now) attempts.delete(address);
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
    if (attempts.size > 1024 || (attempts.get(ip)?.count || 0) >= 5) return send(429, { error: 'Too many attempts. Try again in one minute.' });
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (Buffer.byteLength(raw) > 1024) return send(413, { error: 'Password request is too large.' });
      }
      const body = JSON.parse(raw);
      if (typeof body.password !== 'string' || body.password.length > 256) return send(400, { error: 'Enter a password.' });
      let actual;
      if (apacheHash) {
        // Migrate the existing server password without storing or transporting plaintext.
        const result = spawnSync('/usr/bin/openssl', ['passwd', '-apr1', '-salt', config.apr1Hash.split('$')[2], '-stdin'],
          { input: body.password, encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true });
        if (result.status !== 0) throw new Error('Password verification unavailable.');
        actual = Buffer.from(result.stdout.trim());
      } else actual = scryptSync(body.password, config.salt, 64);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        const previous = attempts.get(ip);
        attempts.set(ip, { count: (previous?.count || 0) + 1, until: previous?.until || now + 60_000 });
        return send(401, { error: 'Incorrect password.' });
      }
      attempts.delete(ip);
      const token = randomBytes(32).toString('base64url') + '.' + (now + lifetime * 1000);
      res.setHeader('Set-Cookie', `${cookieName}=${token}.${sign(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${lifetime}`);
      return send(200, { authenticated: true });
    } catch { return send(400, { error: 'Invalid login request.' }); }
  }
  return { authenticated, handle };
}
