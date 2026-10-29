import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const route = '/__browser_sync';
const maxSnapshotBytes = 256 * 1024 * 1024;
const maxTotalFileBytes = 128 * 1024 * 1024;
const maxFileBytes = 64 * 1024 * 1024;
const maxFiles = 1024;
const maxPathLength = 1024;
const emptySnapshot = { version: 1, files: [] };

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxPathLength || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  if (value === 'base/doom3.cfg' || value === 'base/config.cfg') return true;
  if (/^base\/savegame\/profile\.bin$/i.test(value)) return true;
  return value.startsWith('base/savegame/') || /^base\/doomclassic\/savegame\/.+\.dsg$/i.test(value);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code) {
  sendJson(res, status, { error: code });
}

async function readBody(req) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxSnapshotBytes) {
    req.resume();
    return { error: 413 };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSnapshotBytes) {
      req.resume();
      return { error: 413 };
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks, size) };
}

async function loadSnapshot(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    const snapshot = JSON.parse(text);
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.files)) throw new Error('invalid snapshot');
    return snapshot;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySnapshot;
    throw error;
  }
}

function snapshotManifest(snapshot) {
  const files = snapshot.files.map(({ path: filePath, mtimeMs, sha256, base64 }) => {
    if (!validPath(filePath) || !Number.isFinite(mtimeMs) || mtimeMs < 0 || mtimeMs > 8.64e15 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || typeof base64 !== 'string') {
      throw new Error('invalid stored snapshot entry');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxFileBytes || bytes.toString('base64') !== base64 || digest(bytes) !== sha256) throw new Error('invalid stored snapshot content');
    return { path: filePath, size: bytes.length, sha256, mtimeMs };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const revision = digest(JSON.stringify(files));
  return { revision, files };
}

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.baseRevision !== 'string' || !Array.isArray(value.files) || value.files.length > maxFiles) {
    return { error: 400, code: 'BAD_REQUEST' };
  }
  let totalBytes = 0;
  const seen = new Set();
  const files = [];
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validPath(entry.path) || seen.has(entry.path) ||
        !Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0 || entry.mtimeMs > 8.64e15 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof entry.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.base64)) {
      return { error: 400, code: 'BAD_REQUEST' };
    }
    seen.add(entry.path);
    const bytes = Buffer.from(entry.base64, 'base64');
    if (bytes.toString('base64') !== entry.base64 || bytes.length > maxFileBytes) return { error: 413, code: 'FILE_TOO_LARGE' };
    totalBytes += bytes.length;
    if (totalBytes > maxTotalFileBytes) return { error: 413, code: 'SNAPSHOT_TOO_LARGE' };
    if (digest(bytes) !== entry.sha256) return { error: 400, code: 'HASH_MISMATCH' };
    files.push({ path: entry.path, mtimeMs: entry.mtimeMs, sha256: entry.sha256, base64: entry.base64 });
  }
  return { value: { baseRevision: value.baseRevision, files } };
}

export function createSaveSyncStore(directory, { authorize = () => true } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('createSaveSyncStore requires a directory');
  const root = path.resolve(directory);
  const snapshotPath = path.join(root, 'snapshot.json');
  let writeQueue = Promise.resolve();

  async function commitSnapshot(value) {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (!authorize()) return { denied: true };
      const current = await loadSnapshot(snapshotPath);
      const currentManifest = snapshotManifest(current);
      if (value.baseRevision !== currentManifest.revision) return { conflict: currentManifest };

      const next = { version: 1, files: value.files };
      const temporaryPath = path.join(root, `.snapshot-${randomBytes(12).toString('hex')}.tmp`);
      try {
        await writeFile(temporaryPath, JSON.stringify(next), { flag: 'wx' });
        if (!authorize()) return { denied: true };
        await rename(temporaryPath, snapshotPath);
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
      return { manifest: snapshotManifest(next) };
    } finally {
      release();
    }
  }

  async function handle(req, res, url) {
    if (!(url instanceof URL) || (url.pathname !== route && !url.pathname.startsWith(`${route}/`))) return false;
    if (url.pathname !== `${route}/manifest` && url.pathname !== `${route}/file` && url.pathname !== `${route}/snapshot`) {
      sendError(res, 404, 'NOT_FOUND');
      return true;
    }

    try {
      if (url.pathname === `${route}/manifest`) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          sendError(res, 405, 'METHOD_NOT_ALLOWED');
          return true;
        }
        const manifest = snapshotManifest(await loadSnapshot(snapshotPath));
        sendJson(res, 200, manifest);
        return true;
      }

      if (url.pathname === `${route}/file`) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          sendError(res, 405, 'METHOD_NOT_ALLOWED');
          return true;
        }
        const filePath = url.searchParams.get('path');
        if (!validPath(filePath)) {
          sendError(res, 400, 'BAD_PATH');
          return true;
        }
        const snapshot = await loadSnapshot(snapshotPath);
        const entry = snapshot.files.find((file) => file.path === filePath);
        if (!entry) {
          sendError(res, 404, 'NOT_FOUND');
          return true;
        }
        const bytes = Buffer.from(entry.base64, 'base64');
        if (bytes.length > maxFileBytes || digest(bytes) !== entry.sha256) throw new Error('invalid stored snapshot content');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'content-length': bytes.length,
          'x-content-sha256': entry.sha256,
          'last-modified': new Date(entry.mtimeMs).toUTCString(),
        });
        res.end(bytes);
        return true;
      }

      if (url.pathname !== `${route}/snapshot` || req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendError(res, 405, 'METHOD_NOT_ALLOWED');
        return true;
      }
      const bodyResult = await readBody(req);
      if (bodyResult.error) {
        sendError(res, bodyResult.error, 'SNAPSHOT_TOO_LARGE');
        return true;
      }
      let parsed;
      try {
        parsed = JSON.parse(bodyResult.body.toString('utf8'));
      } catch {
        sendError(res, 400, 'BAD_REQUEST');
        return true;
      }
      const validated = validateSnapshot(parsed);
      if (validated.error) {
        sendError(res, validated.error, validated.code);
        return true;
      }
      await mkdir(root, { recursive: true });
      const result = await commitSnapshot(validated.value);
      if (result.denied) { sendError(res, 401, 'ACCOUNT_REMOVED'); return true; }
      if (result.conflict) {
        sendJson(res, 409, { error: 'REVISION_CONFLICT', ...result.conflict });
        return true;
      }
      sendJson(res, 200, result.manifest);
      return true;
    } catch {
      sendError(res, 500, 'STORE_ERROR');
      return true;
    }
  }

  async function remove() {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { await unlink(snapshotPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { release(); }
  }
  return { handle, remove };
}
