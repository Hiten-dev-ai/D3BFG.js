import http from 'node:http';
import { serverConfig } from './serverConfig.js';
import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { attachMultiplayerServer } from './multiplayerServer.js';
import { createAccountSession } from './accountSession.js';
import { createSaveSyncStore } from './saveSyncServer.js';
import { findEncodedAsset } from './assetCompression.js';
import { createRuntimeDiagnostics } from './runtimeDiagnostics.js';
import { attachSessionLease } from './sessionLease.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Port and Host configuration
const HOST = serverConfig.host;
const PORT = serverConfig.port;
const syncRoot = serverConfig.saves;
const saveStores = new Map();
function saveStoreForAccount(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid account identifier.');
  if (!saveStores.has(id)) saveStores.set(id, createSaveSyncStore(path.join(syncRoot, 'accounts', id),
    { authorize: () => privateSession.accountExists(id) }));
  return saveStores.get(id);
}
const privateSession = createAccountSession({ directory: serverConfig.accounts,
  initialOwner: { name: process.env.FIRST_USERNAME, email: process.env.FIRST_EMAIL, password: process.env.FIRST_PASSWORD },
  legacyConfig: process.env.DOOM3BFG_AUTH_CONFIG, ownerEmail: process.env.DOOM3BFG_OWNER_EMAIL,
  production: process.env.NODE_ENV === 'production', saveStoreForAccount,
  removeAccountSaves: async (id, details) => {
    await saveStoreForAccount(id).remove(); saveStores.delete(id);
    if (details?.owner) await fs.promises.unlink(path.join(syncRoot, 'snapshot.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } });
const handleRuntimeDiagnostics = createRuntimeDiagnostics({ identity: req => privateSession.identity(req) });

// Root paths
const STATIC_ROOT = path.resolve(__dirname, '..', 'dist', 'site');

function resolveGameDir() {
  if (process.env.DOOM3BFG_GAME_DIR && process.env.DOOM3BFG_GAME_DIR.trim().length > 0) {
    return path.resolve(process.env.DOOM3BFG_GAME_DIR.trim());
  }
  // Default to checkout's install folder
  return path.resolve(__dirname, '..', 'DOOM 3 BFG Edition');
}

const GAME_DIR = serverConfig.game;
const ENCODED_ROOT = path.resolve(process.env.DOOM3BFG_ENCODED_DIR || path.join(GAME_DIR, '..', '.doom3bfg-encoded'));
const RENDERER_SHADER_DIR = path.resolve(
  __dirname,
  '..',
  'engine',
  'chocolate-doom3-bfg',
  'base',
  'renderprogs',
);
const RENDERER_SHADER_PATH_PREFIX = 'base/renderprogs/';
const PRIVATE_MANIFEST_CACHE_TTL_MS = 30_000;
const privateManifestCache = new Map();

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
};

function computeEtag(size, mtimeMs) {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function scanGameDirManifest(rootDir) {
  const entries = [];
  let rootRealPath = '';
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { files: [], manifestEtag: '""' };
  }

  const visitedRealDirs = new Set();

  function walk(currentDir) {
    let currentRealPath = '';
    try {
      currentRealPath = fs.realpathSync(currentDir);
    } catch {
      return;
    }

    if (visitedRealDirs.has(currentRealPath)) {
      return;
    }
    visitedRealDirs.add(currentRealPath);

    let items = [];
    try {
      items = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (item.isSymbolicLink()) {
        // Exclude all symlinks to prevent cycles or root escapes
        continue;
      }

      const fullPath = path.join(currentDir, item.name);
      try {
        if (item.isDirectory()) {
          walk(fullPath);
        } else if (item.isFile()) {
          const stat = fs.statSync(fullPath);
          const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          entries.push({
            path: relativePath,
            size: stat.size,
            etag: computeEtag(stat.size, stat.mtimeMs),
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(rootDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const manifestContent = entries.map((e) => `${e.path}:${e.size}:${e.etag}`).join('\n');
  let hash = 0;
  for (let i = 0; i < manifestContent.length; i++) {
    hash = (hash * 31 + manifestContent.charCodeAt(i)) >>> 0;
  }
  const manifestEtag = `"${entries.length}-${hash.toString(16)}"`;

  return { files: entries, manifestEtag };
}

function scanPrivateManifest(rootDir) {
  const { files: gameFiles } = scanGameDirManifest(rootDir);
  const { files: rendererShaders } = scanGameDirManifest(RENDERER_SHADER_DIR);
  const filesByPath = new Map(gameFiles.map((entry) => [entry.path, entry]));
  const gamePaths = new Set(filesByPath.keys());

  for (const shader of rendererShaders) {
    const assetPath = `${RENDERER_SHADER_PATH_PREFIX}${shader.path}`;
    if (!filesByPath.has(assetPath)) {
      filesByPath.set(assetPath, { ...shader, path: assetPath });
    }
  }

  const files = Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  const manifestContent = files.map((entry) => `${entry.path}:${entry.size}:${entry.etag}`).join('\n');
  let hash = 0;
  for (let i = 0; i < manifestContent.length; i++) {
    hash = (hash * 31 + manifestContent.charCodeAt(i)) >>> 0;
  }

  return { files, manifestEtag: `"${files.length}-${hash.toString(16)}"`, gamePaths };
}

function getPrivateManifest(rootDir, refresh = false) {
  const cacheKey = path.resolve(rootDir);
  const cached = privateManifestCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) {
    return cached.manifest;
  }

  const manifest = scanPrivateManifest(rootDir);
  privateManifestCache.set(cacheKey, {
    manifest,
    expiresAt: Date.now() + PRIVATE_MANIFEST_CACHE_TTL_MS,
  });
  return manifest;
}

function invalidatePrivateManifest(rootDir) {
  privateManifestCache.delete(path.resolve(rootDir));
}

function setSecurityAndCorpHeaders(res) {
  for (const [header, val] of Object.entries(COOP_COEP_HEADERS)) {
    res.setHeader(header, val);
  }
}

function handleGameManifest(req, res) {
  if (!fs.existsSync(GAME_DIR)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Game directory not found' }));
    return;
  }

  const { files: manifestFiles, manifestEtag } = getPrivateManifest(GAME_DIR);

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === manifestEtag) {
    res.statusCode = 304;
    res.setHeader('ETag', manifestEtag);
    res.end();
    return;
  }

  const body = JSON.stringify({
    gameDir: path.basename(GAME_DIR),
    manifestEtag,
    files: manifestFiles,
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('ETag', manifestEtag);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Length', Buffer.byteLength(body));

  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

function handleGameFile(req, res, parsedUrl) {
  const rawRelPath = parsedUrl.searchParams.get('path');
  if (!rawRelPath) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Missing "path" parameter');
    return;
  }

  // Reject NUL bytes, absolute paths, Windows drive letters, or backslashes before processing
  if (
    rawRelPath.includes('\0') ||
    rawRelPath.includes('\\') ||
    path.isAbsolute(rawRelPath) ||
    /^[a-zA-Z]:/.test(rawRelPath)
  ) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Invalid path format');
    return;
  }

  // parsedUrl.searchParams.get() is already decoded. Check for '..' path segments explicitly.
  const pathSegments = rawRelPath.split('/');
  if (pathSegments.some((seg) => seg === '..' || seg === '.')) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Invalid path traversal');
    return;
  }

  const normalizedRelPath = path.posix.normalize(rawRelPath).replace(/^\/+/, '');
  if (normalizedRelPath.startsWith('../') || normalizedRelPath === '..') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Invalid path traversal');
    return;
  }

  let manifestEntry;
  let targetRealPath = '';
  let stat;
  let resolutionFailure;

  // Reuse the shared snapshot across asset requests, refreshing once if this
  // selected file no longer matches the metadata collected by the scan.
  for (let attempt = 0; attempt < 2; attempt++) {
    const manifest = getPrivateManifest(GAME_DIR);
    manifestEntry = manifest.files.find((entry) => entry.path === normalizedRelPath);
    if (!manifestEntry) {
      resolutionFailure = { status: 404, message: 'Not Found: File is not in manifest' };
      break;
    }

    const bundledRendererShaders =
      normalizedRelPath.startsWith(RENDERER_SHADER_PATH_PREFIX) &&
      !manifest.gamePaths.has(normalizedRelPath);
    const assetRoot = bundledRendererShaders ? RENDERER_SHADER_DIR : GAME_DIR;
    const assetRelativePath = bundledRendererShaders
      ? normalizedRelPath.slice(RENDERER_SHADER_PATH_PREFIX.length)
      : normalizedRelPath;

    let rootRealPath = '';
    try {
      rootRealPath = fs.realpathSync(assetRoot);
    } catch {
      resolutionFailure = { status: 404, message: 'Asset directory not found' };
      break;
    }

    const targetPath = path.resolve(assetRoot, assetRelativePath);
    try {
      targetRealPath = fs.realpathSync(targetPath);
    } catch {
      resolutionFailure = { status: 404, message: 'File not found' };
      break;
    }

    const relFromRoot = path.relative(rootRealPath, targetRealPath);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      resolutionFailure = { status: 403, message: 'Forbidden: Traversal detected' };
      break;
    }

    try {
      stat = fs.statSync(targetRealPath);
      if (!stat.isFile()) {
        resolutionFailure = { status: 400, message: 'Bad Request: Target is not a file' };
        break;
      }
    } catch {
      resolutionFailure = { status: 404, message: 'File not found' };
      break;
    }

    if (stat.size === manifestEntry.size && computeEtag(stat.size, stat.mtimeMs) === manifestEntry.etag) {
      resolutionFailure = undefined;
      break;
    }

    if (attempt === 0) {
      invalidatePrivateManifest(GAME_DIR);
      continue;
    }

    resolutionFailure = { status: 409, message: 'Asset changed while resolving; retry the request' };
  }

  if (resolutionFailure || !manifestEntry || !stat) {
    res.statusCode = resolutionFailure?.status ?? 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end(resolutionFailure?.message ?? 'File not found');
    return;
  }

  const fileEtag = manifestEntry.etag;
  res.setHeader('ETag', fileEtag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === fileEtag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.end();
      return;
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (isNaN(start) || start >= fileSize || start < 0 || end < start) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.end();
      return;
    }

    if (end >= fileSize) {
      end = fileSize - 1;
    }

    const chunkLength = end - start + 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkLength);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetRealPath, { start, end });
    stream.pipe(res);
  } else {
    res.statusCode = 200;
      const useGzip = /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s*,|\s*$))[^,]*)?(?:\s*,|\s*$)/i.test(req.headers['accept-encoding'] ?? '') &&
        fileSize > 64 * 1024 && process.env.DOOM3BFG_COMPRESSION !== '0';
      res.setHeader('Vary', 'Accept-Encoding');
      if (useGzip) res.setHeader('Content-Encoding', 'gzip');
      else res.setHeader('Content-Length', fileSize);

    const encoded = useGzip && serverConfig.sharedAssetCache ? findEncodedAsset(ENCODED_ROOT, normalizedRelPath, stat) : null;
    if (encoded) {
      res.setHeader('Content-Length', encoded.size);
      if (req.method === 'HEAD') { res.end(); return; }
      pipeline(fs.createReadStream(encoded.path), res, error => { if (error && !res.destroyed) res.destroy(error); });
      return;
    }

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetRealPath);
      stream.on('error', () => res.destroy());
      if (useGzip) {
        const compressed = createGzip({ level: 1 });
        compressed.on('error', () => res.destroy());
        res.on('close', () => { stream.destroy(); compressed.destroy(); });
        stream.pipe(compressed).pipe(res);
      } else stream.pipe(res);
  }
}

function handleStaticFile(req, res, pathname) {
  if (!fs.existsSync(STATIC_ROOT)) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Static bundle not built. Please run `npm run build` in web/ first.');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Malformed URI');
    return;
  }

  // Reject NUL bytes, Windows drive letters, or backslashes
  if (decodedPath.includes('\0') || decodedPath.includes('\\') || /^[a-zA-Z]:/.test(decodedPath)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Invalid path format');
    return;
  }

  let relPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const pathSegments = relPath.split('/');
  if (pathSegments.some((seg) => seg === '..')) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Forbidden');
    return;
  }

  const normalized = path.posix.normalize(relPath).replace(/^\/+/, '');
  if (normalized.startsWith('../') || normalized === '..') {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Forbidden');
    return;
  }

  let staticRootRealPath = '';
  try {
    staticRootRealPath = fs.realpathSync(STATIC_ROOT);
  } catch {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Static root not available');
    return;
  }

  let filePath = path.resolve(staticRootRealPath, normalized);

  // Canonical check to ensure resolved path cannot escape staticRootRealPath
  let realFilePath = '';
  try {
    realFilePath = fs.realpathSync(filePath);
  } catch {
    // If not found and not an asset file, fall back to index.html (SPA routing)
    if (!path.extname(normalized)) {
      filePath = path.resolve(staticRootRealPath, 'index.html');
      try {
        realFilePath = fs.realpathSync(filePath);
      } catch {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Not Found');
        return;
      }
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not Found');
      return;
    }
  }

  const relFromRoot = path.relative(staticRootRealPath, realFilePath);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Forbidden');
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(realFilePath);
    if (stat.isDirectory()) {
      const indexFilePath = path.join(realFilePath, 'index.html');
      const indexReal = fs.realpathSync(indexFilePath);
      const indexRel = path.relative(staticRootRealPath, indexReal);
      if (indexRel.startsWith('..') || path.isAbsolute(indexRel)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Forbidden');
        return;
      }
      realFilePath = indexReal;
      stat = fs.statSync(realFilePath);
    }
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not Found');
    return;
  }

  if (!stat || !stat.isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not Found');
    return;
  }

  const ext = path.extname(realFilePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const compressible = ['.wasm', '.js', '.css'].includes(ext) && stat.size > 64 * 1024;
  const useGzip = compressible && !req.headers.range &&
    /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s*,|\s*$))[^,]*)?(?:\s*,|\s*$)/i.test(req.headers['accept-encoding'] ?? '');
  const rawEtag = computeEtag(stat.size, stat.mtimeMs);
  const etag = useGzip ? `W/${rawEtag}` : rawEtag;
  if (compressible) res.setHeader('Vary', 'Accept-Encoding');
  if (useGzip) res.setHeader('Content-Encoding', 'gzip');
  const isHashedViteAsset =
    relFromRoot.replace(/\\/g, '/').startsWith('assets/') &&
    /-[A-Za-z0-9_-]{8,}\./.test(path.basename(realFilePath));

  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  // Vite bundles have content-hashed names. Stable names such as engine JS/WASM
  // revalidate by ETag so updates are picked up without retransferring unchanged files.
  res.setHeader(
    'Cache-Control',
    isHashedViteAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  );
  res.setHeader('Accept-Ranges', 'bytes');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (!isNaN(start) && start < fileSize && start >= 0 && end >= start) {
        if (end >= fileSize) end = fileSize - 1;
        const chunkLen = end - start + 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkLen);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(realFilePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.statusCode = 200;
  if (!useGzip) res.setHeader('Content-Length', fileSize);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  if (useGzip) {
    pipeline(fs.createReadStream(realFilePath), createGzip({ level: 1 }), res, error => {
      if (error && !res.destroyed) res.destroy(error);
    });
  } else fs.createReadStream(realFilePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  setSecurityAndCorpHeaders(res);

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Request: Malformed URL');
    return;
  }

  const pathname = parsedUrl.pathname;
  if (/(^|\/)\.[^/]/.test(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Not found'); return;
  }
  if (pathname === '/__server_config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ browserDefaults: serverConfig.browserDefaults, multiplayer: serverConfig.multiplayer })); return;
  }

  try {
    if (await privateSession.handle(req, res, parsedUrl)) return;
    if ((pathname.startsWith('/__local_game/') || pathname.startsWith('/engine') || pathname.startsWith('/__browser_sync/')) && !privateSession.authenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Sign in to continue.' }));
      return;
    }
    if (pathname === '/__local_game/trace') { await handleRuntimeDiagnostics(req, res); return; }
    if (pathname.startsWith('/__browser_sync/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        let origin;
        try { origin = new URL(String(req.headers.origin)); } catch { /* Rejected below. */ }
        if (origin?.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
          res.writeHead(403); res.end(); return;
        }
      }
      const account = privateSession.identity(req);
      if (req.headers['x-doom-account'] !== account?.id) {
        res.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Account changed in another tab. Reload before syncing saves.' })); return;
      }
      if (account) { await saveStoreForAccount(account.id).handle(req, res, parsedUrl); return; }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Save sync is not configured on this server.' }));
      return;
    }
  } catch (error) {
    console.error('[DOOM 3 BFG Web] Private API request failed:', error instanceof Error ? error.message : 'request failed');
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'The server could not complete this request.' }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }

  if (pathname === '/__local_game/manifest') {
    handleGameManifest(req, res);
    return;
  }

  if (pathname === '/__local_game/file') {
    handleGameFile(req, res, parsedUrl);
    return;
  }

  handleStaticFile(req, res, pathname);
});

const multiplayer = attachMultiplayerServer(server, { authorize: req => serverConfig.multiplayer && privateSession.authenticated(req), identity: req => privateSession.identity(req) });
const gameLease = attachSessionLease(server, { authorize: req => privateSession.authenticated(req), identity: req => privateSession.identity(req) });
server.once('close', () => { multiplayer.close(); gameLease.close(); });
server.listen(PORT, HOST, () => {
  console.log(`[DOOM 3 BFG Private Server] Running on http://${HOST}:${PORT}`);
  console.log(`[DOOM 3 BFG Private Server] Bound to ${HOST} (default loopback protection)`);
  console.log(`[DOOM 3 BFG Private Server] Static web root: ${STATIC_ROOT}`);
  console.log(`[DOOM 3 BFG Private Server] Game data root: ${GAME_DIR}`);
});
