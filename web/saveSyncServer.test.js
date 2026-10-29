import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createSaveSyncStore } from './saveSyncServer.js';

let server;
let store;
let root;
let origin;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doom3-save-sync-'));
  store = createSaveSyncStore(root);
  server = createServer(async (req, res) => {
    const handled = await store.handle(req, res, new URL(req.url, `http://${req.headers.host}`));
    if (!handled) {
      res.writeHead(404);
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
  if (root) await rm(root, { recursive: true, force: true });
});

function fileEntry(filePath, bytes, mtimeMs = 1_700_000_000_000) {
  const data = Buffer.from(bytes);
  return { path: filePath, mtimeMs, sha256: createHash('sha256').update(data).digest('hex'), base64: data.toString('base64') };
}

async function manifest() {
  const response = await fetch(`${origin}/__browser_sync/manifest`);
  assert.equal(response.status, 200);
  return response.json();
}

test('manifest starts empty and snapshot commit serves binary files', async () => {
  const initial = await manifest();
  assert.deepEqual(initial.files, []);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);

  const entry = fileEntry('base/savegame/slot 1.d3sv', Buffer.from([0, 255, 1, 128]));
  const committed = await fetch(`${origin}/__browser_sync/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: initial.revision, files: [entry] }),
  });
  assert.equal(committed.status, 200);
  const committedManifest = await committed.json();
  assert.equal(committedManifest.files[0].path, entry.path);
  assert.equal(committedManifest.files[0].size, 4);
  assert.equal(committedManifest.files[0].sha256, entry.sha256);

  const download = await fetch(`${origin}/__browser_sync/file?path=${encodeURIComponent(entry.path)}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-content-sha256'), entry.sha256);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from([0, 255, 1, 128]));
});

test('stale revisions conflict without replacing the committed snapshot', async () => {
  const before = await manifest();
  const entry = fileEntry('base/doom3.cfg', 'seta test 1\n');
  const response = await fetch(`${origin}/__browser_sync/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: '0'.repeat(64), files: [entry] }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).revision, before.revision);
  assert.deepEqual(await manifest(), before);
});

test('snapshot rejects unsafe paths and mismatched hashes', async () => {
  const before = await manifest();
  const unsafe = fileEntry('base/savegame/../../config.cfg', 'x');
  const badPathResponse = await fetch(`${origin}/__browser_sync/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: before.revision, files: [unsafe] }),
  });
  assert.equal(badPathResponse.status, 400);
  assert.equal((await badPathResponse.json()).error, 'BAD_REQUEST');

  const mismatch = { ...fileEntry('base/config.cfg', 'x'), sha256: '0'.repeat(64) };
  const hashResponse = await fetch(`${origin}/__browser_sync/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: before.revision, files: [mismatch] }),
  });
  assert.equal(hashResponse.status, 400);
  assert.equal((await hashResponse.json()).error, 'HASH_MISMATCH');
  assert.deepEqual(await manifest(), before);
});

test('matching empty snapshot explicitly removes all synchronized files', async () => {
  const before = await manifest();
  const response = await fetch(`${origin}/__browser_sync/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: before.revision, files: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).files, []);
});

test('file endpoint rejects config and save paths outside the allowlist', async () => {
  for (const filePath of ['base/pak000.pk4', 'base/doomclassic/config.cfg', '../base/config.cfg']) {
    const response = await fetch(`${origin}/__browser_sync/file?path=${encodeURIComponent(filePath)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'BAD_PATH');
  }
});
