import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachMultiplayerServer } from './multiplayerServer.js';
import { attachSessionLease } from './sessionLease.js';
import { createSaveSyncStore } from './saveSyncServer.js';
import { createAccountSession } from './accountSession.js';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
};

function isLoopbackAddress(remoteAddr?: string): boolean {
  if (!remoteAddr) return false;
  return (
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr === '::ffff:127.0.0.1' ||
    remoteAddr.startsWith('127.')
  );
}

function resolveGameDir(): string {
  if (process.env.DOOM3BFG_GAME_DIR && process.env.DOOM3BFG_GAME_DIR.trim().length > 0) {
    return path.resolve(process.env.DOOM3BFG_GAME_DIR.trim());
  }
  // Default to ignored install folder in this checkout
  return path.resolve(import.meta.dirname, '..', 'DOOM 3 BFG Edition');
}

const rendererShaderDir = path.resolve(
  import.meta.dirname,
  '..',
  'engine',
  'chocolate-doom3-bfg',
  'base',
  'renderprogs',
);
const rendererShaderPathPrefix = 'base/renderprogs/';

interface ManifestEntry {
  path: string;
  size: number;
  etag: string;
}

interface PrivateManifest {
  files: ManifestEntry[];
  manifestEtag: string;
  gamePaths: Set<string>;
}

interface CachedPrivateManifest {
  manifest: PrivateManifest;
  expiresAt: number;
}

const privateManifestCacheTtlMs = 30_000;
const privateManifestCache = new Map<string, CachedPrivateManifest>();

const maxRuntimeTraceEntries = 512;
const maxRuntimeTraceBytes = 4096;
const runtimeTrace: string[] = [];
const maxPersistedRuntimeTraceBytes = 2 * 1024 * 1024;
const runtimeTracePath = path.resolve(import.meta.dirname, '..', '.runtime-trace', 'doom3bfg-runtime.log');
let runtimeTracePersistence = Promise.resolve();

if (fs.existsSync(runtimeTracePath)) {
  try {
    const persistedEntries = fs.readFileSync(runtimeTracePath, 'utf8').split(/\r?\n/).filter(Boolean);
    runtimeTrace.push(...persistedEntries.slice(-maxRuntimeTraceEntries));
  } catch (error) {
    console.warn('[DOOM 3 BFG Web] Unable to load persisted runtime trace:', error);
  }
}

function persistRuntimeTrace(entry: string): Promise<void> {
  runtimeTracePersistence = runtimeTracePersistence.then(async () => {
    await fs.promises.mkdir(path.dirname(runtimeTracePath), { recursive: true });
    const traceStats = await fs.promises.stat(runtimeTracePath).catch(() => undefined);
    if (traceStats && traceStats.size > maxPersistedRuntimeTraceBytes) {
      const persistedEntries = (await fs.promises.readFile(runtimeTracePath, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.floor(maxRuntimeTraceEntries / 2));
      await fs.promises.writeFile(runtimeTracePath, `${persistedEntries.join('\n')}\n`, 'utf8');
    }
    await fs.promises.appendFile(runtimeTracePath, `${entry}\n`, 'utf8');
  }).catch((error) => {
    console.warn('[DOOM 3 BFG Web] Unable to persist runtime trace:', error);
  });
  return runtimeTracePersistence;
}

function computeEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function scanGameDirManifest(rootDir: string): { files: ManifestEntry[]; manifestEtag: string } {
  const entries: ManifestEntry[] = [];
  let rootRealPath = '';
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch {
    return { files: [], manifestEtag: '""' };
  }

  const visitedRealDirs = new Set<string>();

  function walk(currentDir: string) {
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

    let items: fs.Dirent[] = [];
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

  // Compute a stable hash/etag for the entire manifest based on file paths, sizes, and etags
  const manifestContent = entries.map((e) => `${e.path}:${e.size}:${e.etag}`).join('\n');
  let hash = 0;
  for (let i = 0; i < manifestContent.length; i++) {
    hash = (hash * 31 + manifestContent.charCodeAt(i)) >>> 0;
  }
  const manifestEtag = `"${entries.length}-${hash.toString(16)}"`;

  return { files: entries, manifestEtag };
}

function scanPrivateManifest(rootDir: string): PrivateManifest {
  const { files: gameFiles } = scanGameDirManifest(rootDir);
  const { files: rendererShaders } = scanGameDirManifest(rendererShaderDir);
  const filesByPath = new Map(gameFiles.map((entry) => [entry.path, entry]));
  const gamePaths = new Set(filesByPath.keys());

  for (const shader of rendererShaders) {
    const assetPath = `${rendererShaderPathPrefix}${shader.path}`;
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

function getPrivateManifest(rootDir: string, refresh = false): PrivateManifest {
  const cacheKey = path.resolve(rootDir);
  const cached = privateManifestCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) {
    return cached.manifest;
  }

  const manifest = scanPrivateManifest(rootDir);
  privateManifestCache.set(cacheKey, {
    manifest,
    expiresAt: Date.now() + privateManifestCacheTtlMs,
  });
  return manifest;
}

function invalidatePrivateManifest(rootDir: string): void {
  privateManifestCache.delete(path.resolve(rootDir));
}

function localGameBridgePlugin(): Plugin {
  const gameDir = resolveGameDir();

  return {
    name: 'local-game-bridge',
    apply: 'serve', // localhost dev server only, not active in static build
    configureServer(server) {
      const localRoot = path.resolve(import.meta.dirname, '../.runtime-trace');
      const localStores = new Map<string, ReturnType<typeof createSaveSyncStore>>();
      const accountStore = (id: string) => {
        if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid account identifier.');
        if (!localStores.has(id)) localStores.set(id, createSaveSyncStore(path.join(localRoot, 'local-save-sync/accounts', id), { authorize: () => accounts.accountExists(id) }));
        return localStores.get(id)!;
      };
      const accounts = createAccountSession({ directory: path.join(localRoot, 'accounts'),
        legacyConfig: path.join(localRoot, 'account-seed.json'), ownerEmail: process.env.DOOM3BFG_OWNER_EMAIL,
        production: false, saveStoreForAccount: accountStore, removeAccountSaves: (id: string) => accountStore(id).remove() });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/__browser_sync/') && !url.pathname.startsWith('/__session/')) return next();
        if (!isLoopbackAddress(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
        if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return; }
        if (await accounts.handle(req, res, url)) return;
        const account = accounts.identity(req);
        if (!account) { res.writeHead(401); res.end(); return; }
        if (req.headers['x-doom-account'] !== account.id) { res.writeHead(409); res.end(); return; }
        if (await accountStore(account.id).handle(req, res, url)) return;
        res.writeHead(404); res.end();
      });
      if (server.httpServer) {
        const multiplayer = attachMultiplayerServer(server.httpServer, { authorize: req => accounts.authenticated(req), identity: req => accounts.identity(req) });
        const gameLease = attachSessionLease(server.httpServer, { authorize: req => accounts.authenticated(req), identity: req => accounts.identity(req) });
        server.httpServer.once('close', () => { multiplayer.close(); gameLease.close(); });
      }
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const urlString = req.url || '/';
        const parsedUrl = new URL(urlString, 'http://127.0.0.1');
        const pathname = parsedUrl.pathname;

        if (!pathname.startsWith('/__local_game/')) {
          return next();
        }

        // Restrict to loopback
        const remoteIp = req.socket.remoteAddress;
        if (!isLoopbackAddress(remoteIp)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/plain');
          res.end('Forbidden: Localhost loopback only');
          return;
        }

        if (pathname === '/__local_game/trace') {
          if (req.method === 'POST') {
            let body = '';
            let bodyBytes = 0;
            let tooLarge = false;
            req.setEncoding('utf8');
            req.on('data', (chunk: string) => {
              if (tooLarge) return;
              bodyBytes += Buffer.byteLength(chunk);
              if (bodyBytes > maxRuntimeTraceBytes) {
                tooLarge = true;
                body = '';
                return;
              }
              body += chunk;
            });
            req.on('end', () => {
              if (tooLarge) {
                res.statusCode = 413;
                res.end('Trace entry too large');
                return;
              }
              const message = body.trim();
              if (message) {
                const entry = `${new Date().toISOString()} ${message}`;
                runtimeTrace.push(entry);
                if (runtimeTrace.length > maxRuntimeTraceEntries) runtimeTrace.shift();
                void persistRuntimeTrace(entry).then(() => {
                  res.statusCode = 204;
                  res.end();
                });
                return;
              }
              res.statusCode = 204;
              res.end();
            });
            return;
          }

          if (req.method === 'GET' || req.method === 'HEAD') {
            const body = JSON.stringify(runtimeTrace);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', Buffer.byteLength(body));
            if (req.method === 'HEAD') res.end();
            else res.end(body);
            return;
          }

          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD, POST');
          res.setHeader('Content-Type', 'text/plain');
          res.end('Method Not Allowed');
          return;
        }

        // Reject methods other than GET and HEAD
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.setHeader('Content-Type', 'text/plain');
          res.end('Method Not Allowed');
          return;
        }

        // Manifest endpoint
        if (pathname === '/__local_game/manifest') {
          if (!fs.existsSync(gameDir)) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Game directory not found', gameDir }));
            return;
          }

          const { files: manifestFiles, manifestEtag } = getPrivateManifest(gameDir);

          const ifNoneMatch = req.headers['if-none-match'];
          if (ifNoneMatch && ifNoneMatch === manifestEtag) {
            res.statusCode = 304;
            res.setHeader('ETag', manifestEtag);
            res.end();
            return;
          }

          const body = JSON.stringify({
            gameDir: path.basename(gameDir),
            manifestEtag,
            files: manifestFiles,
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('ETag', manifestEtag);
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(body);
          }
          return;
        }

        // File endpoint: /__local_game/file?path=...
        if (pathname === '/__local_game/file') {
          const rawRelPath = parsedUrl.searchParams.get('path');
          if (!rawRelPath) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/plain');
            res.end('Bad Request: Missing "path" parameter');
            return;
          }

          // Reject NUL bytes, Windows drive letters, absolute paths, or backslashes
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

          let manifestEntry: ManifestEntry | undefined;
          let targetRealPath = '';
          let stat: fs.Stats | undefined;
          let resolutionFailure: { status: number; message: string } | undefined;

          // A map can contain thousands of files. Reuse the short-lived snapshot,
          // refreshing once if this selected file has changed since it was scanned.
          for (let attempt = 0; attempt < 2; attempt++) {
            const manifest = getPrivateManifest(gameDir);
            manifestEntry = manifest.files.find((entry) => entry.path === normalizedRelPath);
            if (!manifestEntry) {
              resolutionFailure = { status: 404, message: 'Not Found: File is not in manifest' };
              break;
            }

            const bundledRendererShaders =
              normalizedRelPath.startsWith(rendererShaderPathPrefix) &&
              !manifest.gamePaths.has(normalizedRelPath);
            const assetRoot = bundledRendererShaders ? rendererShaderDir : gameDir;
            const assetRelativePath = bundledRendererShaders
              ? normalizedRelPath.slice(rendererShaderPathPrefix.length)
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
              invalidatePrivateManifest(gameDir);
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
          // Game assets are cached in OPFS by the shell. Keep the browser HTTP
          // cache out of the path so a stale entry cannot fail an asset sync.
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
          return;
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Not Found');
      });
    },
  };
}

function offlineShellPlugin(): Plugin {
  return {
    name: 'doom3-offline-shell',
    apply: 'build',
    writeBundle(options) {
      const root = path.resolve(options.dir!);
      const files = ['/', '/favicon.png', '/launcher-page_bg_raw.jpg', '/loading-art.png'];
      for (const dir of ['assets', 'fonts']) {
        for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) files.push('/' + path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
        }
      }
      const worker = fs.readFileSync(path.join(root, 'offline-sw.js'), 'utf8');
      const hash = createHash('sha256').update(worker);
      for (const file of files) hash.update(fs.readFileSync(path.join(root, file === '/' ? 'index.html' : file.slice(1))));
      fs.writeFileSync(path.join(root, 'offline-sw.js'), worker
        .replace('__SHELL_VERSION__', hash.digest('hex').slice(0, 20))
        .replace('__SHELL_FILES__', JSON.stringify(files.sort())));
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [localGameBridgePlugin(), offlineShellPlugin()],
  build: {
    target: 'es2022',
    outDir: '../dist/site',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // An engine owns its canvas and workers for the whole session. Hot reload
    // would restart games mid-test and mix old Wasm with newly edited bridges.
    hmr: false,
    ...(headers ? { headers } : {}),
  },
  preview: {
    ...(headers ? { headers } : {}),
  },
});
