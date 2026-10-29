import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Encoded game data remains outside both the licensed-data manifest and the
// public app. Source identity changes invalidate a precompressed representation.
export function encodedAssetPath(cacheRoot, relativePath, stat) {
  const key = createHash('sha256').update(`${relativePath}\n${stat.size}\n${stat.mtimeMs}`).digest('hex');
  return path.join(cacheRoot, `${key}.gz`);
}

export function findEncodedAsset(cacheRoot, relativePath, stat) {
  const target = encodedAssetPath(cacheRoot, relativePath, stat);
  try {
    const encoded = fs.lstatSync(target);
    return encoded.isFile() && !encoded.isSymbolicLink() && encoded.size > 0
      ? { path: target, size: encoded.size } : null;
  } catch { return null; }
}

export async function prepareEncodedAsset(cacheRoot, gameRoot, relativePath) {
  const realRoot = fs.realpathSync(gameRoot);
  const source = fs.realpathSync(path.resolve(realRoot, relativePath));
  const relative = path.relative(realRoot, source).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Asset must remain inside the game directory');
  const before = fs.statSync(source);
  if (!before.isFile()) throw new Error('Asset must be a regular file');
  const cached = findEncodedAsset(cacheRoot, relative, before);
  if (cached) return { sourceBytes: before.size, encodedBytes: cached.size, cached: true };
  await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const target = encodedAssetPath(cacheRoot, relative, before);
  const temporary = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await pipeline(fs.createReadStream(source), createGzip({ level: 6 }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const after = fs.statSync(source);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Asset changed during compression');
    await fs.promises.rename(temporary, target);
    return { sourceBytes: before.size, encodedBytes: fs.statSync(target).size, cached: false };
  } finally {
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gameRoot = path.resolve(process.argv[2] || 'DOOM 3 BFG Edition');
  const cacheRoot = path.resolve(process.env.DOOM3BFG_ENCODED_DIR || path.join(gameRoot, '..', '.doom3bfg-encoded'));
  const includeMaps = process.argv.includes('--all');
  const walk = async directory => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && includeMaps) await walk(full);
      if (entry.isFile() && entry.name.endsWith('.resources')) {
        const relative = path.relative(gameRoot, full).replace(/\\/g, '/');
        console.log(JSON.stringify({ asset: relative, ...await prepareEncodedAsset(cacheRoot, gameRoot, relative) }));
      }
    }
  };
  await walk(path.join(gameRoot, 'base'));
}
