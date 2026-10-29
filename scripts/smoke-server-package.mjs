// Exercise an extracted package with its own runtime and isolated synthetic state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
const folder = path.resolve(process.argv[2] || '.');
const runtime = process.argv[3] ? path.resolve(process.argv[3]) : path.join(folder, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'd3bfg-package-smoke-'));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const envFile = path.join(temporary, 'test.env');
fs.writeFileSync(envFile, `HOST=127.0.0.1\nPORT=${port}\nNODE_ENV=development\nDOOM3BFG_GAME_DIR=${temporary.replaceAll('\\', '/')}/owned-game\nDOOM3BFG_ACCOUNTS_DIR=${temporary.replaceAll('\\', '/')}/accounts\nDOOM3BFG_SYNC_DIR=${temporary.replaceAll('\\', '/')}/saves\nFIRST_USERNAME=PackageTest\nFIRST_EMAIL=package@example.test\nFIRST_PASSWORD=test-only-package-password-314159\nMULTIPLAYER_ENABLED=false\nBROWSER_CACHE_MODE=2\n`);
const env = { ...process.env, D3BFG_ENV_FILE: envFile };
// A parent process's deployment settings must not contaminate the fixture.
for (const key of ['HOST', 'PORT', 'NODE_ENV', 'DOOM3BFG_GAME_DIR', 'DOOM3BFG_ACCOUNTS_DIR', 'DOOM3BFG_SYNC_DIR', 'FIRST_USERNAME', 'FIRST_EMAIL', 'FIRST_PASSWORD']) delete env[key];
const child = spawn(runtime, [path.join(folder, 'web/server.js')], { cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100; ++i) {
    if (child.exitCode !== null) throw new Error(output);
    try { const response = await fetch(base + '/__session/status'); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, output);
  const root = await fetch(base); assert.equal(root.status, 200);
  assert.equal(root.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(root.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert((await root.text()).includes('D3BFG.js'));
  assert.equal((await fetch(base + '/__local_game/manifest')).status, 401);
  const config = await (await fetch(base + '/__server_config')).json();
  assert.equal(config.multiplayer, false); assert.equal(config.browserDefaults.cacheMode, 2);
  assert(!JSON.stringify(config).includes('PASSWORD'));
  const login = await fetch(base + '/__session/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'PackageTest', password: 'test-only-package-password-314159' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const manifest = await fetch(base + '/engine-worker/build-info.json', { headers: { Cookie: cookie } });
  assert.equal(manifest.status, 200);
  const build = await manifest.json(); assert.match(build.version, /^[a-f0-9]{24}$/);
  const shader = await fetch(base + '/__local_game/file?path=base%2Frenderprogs%2Fglobal.inc', { headers: { Cookie: cookie } });
  assert.equal(shader.status, 200);
  assert.equal((await fetch(base + '/.env')).status, 404);
  console.log(JSON.stringify({ package: path.basename(folder), runtime, status: 'PASS', engine: build.version,
    checked: ['startup', 'first owner/login', 'isolation headers', 'private assets', 'defaults', 'engine manifest', 'GPL shaders', 'env protection'] }));
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(); if (child.exitCode === null) await exited;
  fs.rmSync(temporary, { recursive: true, force: true });
}
