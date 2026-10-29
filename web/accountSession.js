import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';

const derive = promisify(scrypt), validId = /^[a-f0-9]{32}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const view = a => ({ id: a.id, name: a.name, email: a.email, role: a.role, owner: a.role === 'owner', createdAt: a.createdAt });

export function createAccountSession({ directory, legacyConfig, ownerName = 'Admin', ownerEmail, initialOwner, production = true,
  saveStoreForAccount, removeAccountSaves } = {}) {
  if (!directory) throw new Error('Account storage directory is required.');
  const root = path.resolve(directory), database = path.join(root, 'accounts.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let state;
  function persist() {
    const temporary = path.join(root, '.accounts-' + randomBytes(12).toString('hex'));
    try { fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, database); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  if (fs.existsSync(database)) state = JSON.parse(fs.readFileSync(database, 'utf8'));
  else if (initialOwner?.password) {
    const { name, email, password } = initialOwner;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,47}$/u.test(name || '') || !/^\S+@\S+\.\S+$/.test(email || '') ||
        email.length > 254 || password.length < 12 || password.length > 256) throw new Error('Set FIRST_USERNAME, FIRST_EMAIL and a unique FIRST_PASSWORD (12–256 characters) before first start.');
    const salt = randomBytes(24).toString('hex');
    state = { version: 1, accounts: [{ id: randomBytes(16).toString('hex'), name, email: email.toLowerCase(),
      role: 'owner', salt, passwordHash: scryptSync(password, salt, 64).toString('hex'), createdAt: new Date().toISOString() }], sessions: {} };
    persist();
  } else {
    if (!legacyConfig) throw new Error('First start: copy .env.example to .env and set FIRST_USERNAME, FIRST_EMAIL and FIRST_PASSWORD.');
    const legacy = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
    ownerEmail ||= legacy.ownerEmail;
    if (!ownerEmail || !/^\S+@\S+\.\S+$/.test(ownerEmail)) throw new Error('Owner email is required for initial migration.');
    if (legacy.apr1Hash ? !/^\$apr1\$[a-zA-Z0-9./]{1,8}\$[a-zA-Z0-9./]{22}$/.test(legacy.apr1Hash)
      : !/^[a-f0-9]{32,128}$/i.test(legacy.salt) || !/^[a-f0-9]{128}$/i.test(legacy.passwordHash)) throw new Error('Invalid initial password hash.');
    state = { version: 1, accounts: [{ id: randomBytes(16).toString('hex'), name: ownerName, email: ownerEmail.toLowerCase(),
      role: 'owner', salt: legacy.salt, passwordHash: legacy.passwordHash, apr1Hash: legacy.apr1Hash, createdAt: new Date().toISOString() }], sessions: {} };
    persist();
  }
  if (state.version !== 1 || !Array.isArray(state.accounts) || !state.sessions ||
      state.accounts.some(a => !validId.test(a.id) || !['owner', 'op', 'player'].includes(a.role))) throw new Error('Invalid account database.');
  const cookieName = production ? '__Host-doom3_account' : 'doom3_account';
  const tokenFrom = req => String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  const accountFor = req => {
    const token = tokenFrom(req); if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const session = state.sessions[digest(token)]; return session ? state.accounts.find(a => a.id === session.accountId) || null : null;
  };
  const cookie = (res, token) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; ${production ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${token ? 34560000 : 0}`);
  const revoke = id => { for (const [token, s] of Object.entries(state.sessions)) if (s.accountId === id) delete state.sessions[token]; };
  function signIn(res, account) {
    // Newest successful login replaces this account's older device sessions.
    // Failed password attempts never reach this point and cannot evict a player.
    if (Object.values(state.sessions).filter(session => session.accountId !== account.id).length >= 10000) throw new Error('Device limit reached. Log out unused devices.');
    revoke(account.id);
    const token = randomBytes(32).toString('base64url'); state.sessions[digest(token)] = { accountId: account.id }; persist(); cookie(res, token);
  }
  const sameOrigin = req => {
    try { const origin = new URL(String(req.headers.origin)); return req.headers['sec-fetch-site'] !== 'cross-site' &&
      ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch { return false; }
  };
  let hashing = 0;
  async function hash(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('Password must contain 8–256 characters.');
    if (hashing >= 4) throw new Error('Sign-in is busy. Try again shortly.'); ++hashing;
    try { const salt = randomBytes(24).toString('hex'); return { salt, passwordHash: (await derive(password, salt, 64)).toString('hex') }; } finally { --hashing; }
  }
  async function verify(a, password) {
    if (typeof password !== 'string' || password.length > 256 || hashing >= 4) return false; ++hashing;
    try {
      if (a?.apr1Hash) {
        const r = spawnSync('/usr/bin/openssl', ['passwd', '-apr1', '-salt', a.apr1Hash.split('$')[2], '-stdin'], { input: password, encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true });
        const actual = Buffer.from(r.stdout?.trim() || ''), expected = Buffer.from(a.apr1Hash);
        return r.status === 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
      }
      const actual = await derive(password, a?.salt || 'invalid-account-dummy-salt', 64), expected = Buffer.from(a?.passwordHash || '00'.repeat(64), 'hex');
      return !!a && actual.length === expected.length && timingSafeEqual(actual, expected);
    } finally { --hashing; }
  }
  function details(body, except) {
    const name = typeof body.name === 'string' ? body.name.trim() : '', email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,47}$/u.test(name)) throw new Error('Name must contain 2–48 letters, numbers, spaces, dots, dashes or underscores.');
    if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
    if (state.accounts.some(a => a.id !== except && (a.name.toLowerCase() === name.toLowerCase() || a.email === email))) throw new Error('That name or email is already in use.');
    return { name, email };
  }
  function requireCurrent(req, actor, operator = false) {
    if (accountFor(req) !== actor) throw Object.assign(new Error('Sign in again.'), { status: 401 });
    if (operator && !['owner', 'op'].includes(actor.role)) throw Object.assign(new Error('Operator access changed.'), { status: 403 });
  }
  async function body(req, actor, operator = false) {
    let text = ''; for await (const chunk of req) { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > 16384) throw new Error('Request too large.'); }
    const result = JSON.parse(text || '{}'); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Invalid request.');
    if (actor) requireCurrent(req, actor, operator);
    return result;
  }
  const attempts = new Map();
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/__session/')) return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); return true; };
    const me = accountFor(req), route = url.pathname;
    if (route === '/__session/status' && req.method === 'GET') { if (me) cookie(res, tokenFrom(req)); return send(200, { required: true, authenticated: !!me, ...(me ? { user: view(me) } : {}) }); }
    if (req.method !== 'GET' && !sameOrigin(req)) return send(403, { error: 'Request origin rejected.' });
    if (route === '/__session/logout' && req.method === 'POST') {
      delete state.sessions[digest(tokenFrom(req))]; persist(); cookie(res, '');
      return send(200, { authenticated: false });
    }
    if (route === '/__session/login' && req.method === 'POST') {
      const now = Date.now(); for (const [ip, a] of attempts) if (a.until < now) attempts.delete(ip);
      const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress), prior = attempts.get(ip);
      if (attempts.size >= 2048 || (prior?.count || 0) >= 8) return send(429, { error: 'Too many attempts. Try again in one minute.' });
      attempts.set(ip, { count: (prior?.count || 0) + 1, until: prior?.until || now + 60000 });
      try {
        const value = await body(req), login = String(value.login || '').trim().toLowerCase();
        const a = state.accounts.find(a => a.name.toLowerCase() === login || a.email === login);
        if (!await verify(a, value.password)) return send(401, { error: 'Incorrect name or password.' });
        if (!state.accounts.includes(a)) return send(401, { error: 'Account removed.' });
        if (a.apr1Hash) { Object.assign(a, await hash(value.password)); delete a.apr1Hash; }
        attempts.delete(ip); signIn(res, a); return send(200, { authenticated: true, user: view(a) });
      } catch { return send(400, { error: 'Could not sign in. Check your details and try again.' }); }
    }
    if (!me) return send(401, { error: 'Sign in to continue.' });
    try {
      if (route === '/__session/profile' && req.method === 'PATCH') { Object.assign(me, details(await body(req, me), me.id)); persist(); return send(200, { user: view(me) }); }
      if (route === '/__session/password' && req.method === 'POST') {
        const v = await body(req, me); if (!await verify(me, v.currentPassword)) return send(403, { error: 'Current password is incorrect.' });
        const next = await hash(v.newPassword); if (!state.accounts.includes(me) || !accountFor(req)) return send(401, { error: 'Sign in again.' });
        Object.assign(me, next); delete me.apr1Hash; revoke(me.id); signIn(res, me); return send(200, { user: view(me) });
      }
      if (route === '/__session/profile' && req.method === 'DELETE') {
        const v = await body(req, me); if (v.confirm !== 'DELETE' || !await verify(me, v.password)) return send(403, { error: 'Confirm deletion with your current password.' });
        requireCurrent(req, me);
        if (me.role === 'owner' && state.accounts.length > 1) return send(409, { error: 'Remove other accounts before deleting the owner.' });
        revoke(me.id); state.accounts = state.accounts.filter(a => a.id !== me.id); persist(); await removeAccountSaves?.(me.id, { owner: me.role === 'owner' }); cookie(res, ''); return send(200, { authenticated: false });
      }
      if (!route.startsWith('/__session/accounts') || !['owner', 'op'].includes(me.role)) return send(403, { error: 'Operator access is required.' });
      if (route === '/__session/accounts' && req.method === 'GET') return send(200, { accounts: state.accounts.map(view) });
      if (route === '/__session/accounts' && req.method === 'POST') {
        if (state.accounts.length >= 1000) return send(409, { error: 'Account limit reached.' });
        const v = await body(req, me, true); details(v); const password = await hash(v.password);
        if (!accountFor(req) || !['owner', 'op'].includes(me.role)) return send(403, { error: 'Operator access changed.' });
        const a = { id: randomBytes(16).toString('hex'), ...details(v), ...password, role: v.role === 'op' && me.role === 'owner' ? 'op' : 'player', createdAt: new Date().toISOString() };
        state.accounts.push(a); persist(); return send(201, { user: view(a) });
      }
      if (route === '/__session/accounts' && req.method === 'DELETE') {
        const v = await body(req, me, true); if (v.confirm !== 'DELETE' || !Array.isArray(v.ids) || !v.ids.length || v.ids.length > 1000 || v.ids.some(id => !validId.test(id))) return send(400, { error: 'Select accounts and confirm deletion.' });
        const ids = new Set(v.ids), targets = state.accounts.filter(a => ids.has(a.id));
        if (targets.length !== ids.size || targets.some(a => a.role === 'owner' || (me.role !== 'owner' && a.role === 'op'))) return send(403, { error: 'Only the owner can remove operators. The owner cannot be batch deleted.' });
        for (const a of targets) revoke(a.id); state.accounts = state.accounts.filter(a => !ids.has(a.id)); persist();
        for (const a of targets) await removeAccountSaves?.(a.id); return send(200, { deleted: targets.length });
      }
      const match = route.match(/^\/__session\/accounts\/([a-f0-9]{32})(?:\/(logout|saves)(\/file)?)?$/);
      if (!match) return send(404, { error: 'Not found.' });
      const target = state.accounts.find(a => a.id === match[1]); if (!target) return send(404, { error: 'Account not found.' });
      if (me.role !== 'owner' && target.role !== 'player' && target.id !== me.id) return send(403, { error: 'Owner access is required.' });
      if (match[2] === 'logout' && req.method === 'POST') { revoke(target.id); persist(); return send(200, { loggedOut: true }); }
      if (match[2] === 'saves' && req.method === 'GET' && saveStoreForAccount) { const u = new URL(url); u.pathname = '/__browser_sync/' + (match[3] ? 'file' : 'manifest'); return await saveStoreForAccount(target.id).handle(req, res, u); }
      if (!match[2] && req.method === 'PATCH') {
        const v = await body(req, me, true); details(v, target.id);
        if (v.role && v.role !== target.role && (me.role !== 'owner' || target.role === 'owner' || !['op', 'player'].includes(v.role))) return send(403, { error: 'Only the owner can promote or demote operators.' });
        const password = v.password ? await hash(v.password) : null;
        if (!state.accounts.includes(target) || !accountFor(req) || !['owner', 'op'].includes(me.role)) return send(409, { error: 'Account changed. Reload the account list.' });
        if (me.role !== 'owner' && target.role !== 'player' && target.id !== me.id) return send(403, { error: 'Owner access is required.' });
        if (v.role && v.role !== target.role && (me.role !== 'owner' || target.role === 'owner' || !['op', 'player'].includes(v.role))) return send(403, { error: 'Only the owner can promote or demote operators.' });
        Object.assign(target, details(v, target.id)); if (v.role) target.role = v.role;
        if (password) { Object.assign(target, password); delete target.apr1Hash; revoke(target.id); }
        persist(); return send(200, { user: view(target) });
      }
      return send(405, { error: 'Method not allowed.' });
    } catch (error) { return send([401, 403].includes(error?.status) ? error.status : 400, { error: error instanceof Error ? error.message : 'Account request failed.' }); }
  }
  return { authenticated: req => !!accountFor(req), identity: req => { const a = accountFor(req); return a ? view(a) : null; },
    accountExists: id => state.accounts.some(a => a.id === id), handle };
}
