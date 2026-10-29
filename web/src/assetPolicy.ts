import {
  getOpfsRoot,
  getOpfsSubdir,
  OPFS_MAP_CACHE_DIR,
  OPFS_PERM_DIR,
  readStoredMeta,
  streamFileToOpfs,
  type StoredMetaMap,
  withAssetCacheLock,
  writeStoredMeta,
} from './opfsCache';

export interface CacheableMapEntry {
  path: string;
  size: number;
  etag: string;
}

export interface CacheableMapManifest {
  manifestEtag?: string;
  files: CacheableMapEntry[];
}

export interface CacheAllMapArchivesProgress {
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
  currentPath: string;
}

export interface CacheAllMapArchivesResult {
  cachedFiles: number;
  cachedBytes: number;
  totalFiles: number;
  totalBytes: number;
}

export interface CacheAllMapArchivesOptions {
  manifest: CacheableMapManifest;
  fileUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: CacheAllMapArchivesProgress) => void;
}

const MAP_ARCHIVE_PATH = /^(?:base|d3xp|d3le)\/maps\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.resources$/i;

function mapEntriesFromManifest(manifest: CacheableMapManifest): CacheableMapEntry[] {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('The asset manifest does not contain a files array.');
  }
  const seen = new Set<string>();
  return manifest.files.filter((entry) => {
    const path = entry.path.replace(/\\/g, '/');
    if (!MAP_ARCHIVE_PATH.test(path)) return false;
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !entry.etag) {
      throw new Error(`Invalid map archive manifest entry: ${entry.path}`);
    }
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate map archive path in manifest: ${entry.path}`);
    seen.add(key);
    return true;
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Asset cache operation aborted.', 'AbortError');
  }
}

/**
 * Explicitly pre-caches every installed map archive under the owned map-cache
 * namespace. No unrelated files or save data are pruned.
 */
export async function cacheAllMapArchives(
  options: CacheAllMapArchivesOptions,
): Promise<CacheAllMapArchivesResult> {
  const entries = mapEntriesFromManifest(options.manifest);
  const root = await getOpfsRoot();
  const mapCacheRoot = await getOpfsSubdir(root, OPFS_MAP_CACHE_DIR, true);

  return await withAssetCacheLock('exclusive', async () => {
    throwIfAborted(options.signal);
    const storedMeta: StoredMetaMap = (await readStoredMeta(mapCacheRoot)) ?? {
      manifestEtag: options.manifest.manifestEtag ?? '',
      files: {},
    };
    const missing: CacheableMapEntry[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      totalBytes += entry.size;
      const existing = storedMeta.files[entry.path];
      if (
        !existing ||
        existing.etag !== entry.etag ||
        existing.size !== entry.size ||
        !(await fileMatches(mapCacheRoot, entry.path, entry.size))
      ) {
        missing.push(entry);
      }
    }

    if (missing.length > 0 && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const neededBytes = missing.reduce((sum, entry) => sum + entry.size, 0);
      if (quota > 0 && quota - usage < neededBytes) {
        throw new Error(`Insufficient browser storage for full map cache: need ${neededBytes} additional bytes.`);
      }
    }

    let completedFiles = entries.length - missing.length;
    let downloadedBytes = 0;
    let nextIndex = 0;
    let metadataQueue: Promise<void> = Promise.resolve();
    const report = (currentPath = '') => options.onProgress?.({
      completedFiles,
      totalFiles: entries.length,
      downloadedBytes,
      totalBytes: missing.reduce((sum, entry) => sum + entry.size, 0),
      currentPath,
    });

    const persistEntry = (entry: CacheableMapEntry) => {
      storedMeta.files[entry.path] = { etag: entry.etag, size: entry.size };
      storedMeta.manifestEtag = options.manifest.manifestEtag ?? storedMeta.manifestEtag;
      metadataQueue = metadataQueue.then(() => writeStoredMeta(mapCacheRoot, storedMeta));
      return metadataQueue;
    };

    const downloadWorker = async () => {
      while (true) {
        throwIfAborted(options.signal);
        const index = nextIndex++;
        if (index >= missing.length) return;
        const entry = missing[index];
        report(entry.path);
        let attemptBytes = 0;
        for (let attempt = 1; ; attempt++) {
          attemptBytes = 0;
          try {
            await streamFileToOpfs(
              mapCacheRoot,
              entry.path,
              `${options.fileUrl}?path=${encodeURIComponent(entry.path)}`,
              (count) => {
                downloadedBytes += count;
                attemptBytes += count;
                report(entry.path);
              },
              options.signal,
              entry.size,
            );
            await persistEntry(entry);
            completedFiles++;
            report(entry.path);
            break;
          } catch (error) {
            downloadedBytes -= attemptBytes;
            report(entry.path);
            if (attempt >= 3 || options.signal?.aborted) throw error;
            await new Promise((resolve) => window.setTimeout(resolve, 250 * attempt));
          }
        }
      }
    };

    const workers = Array.from({ length: Math.min(3, missing.length) }, () => downloadWorker());
    // Keep the exclusive cache lock until every writer settles, including when
    // one transfer fails. Another tab must never clear a still-open writer.
    const results = await Promise.allSettled(workers);
    await metadataQueue;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    throwIfAborted(options.signal);
    report();
    return {
      cachedFiles: entries.length,
      cachedBytes: totalBytes,
      totalFiles: entries.length,
      totalBytes,
    };
  });
}

async function fileMatches(
  root: FileSystemDirectoryHandle,
  path: string,
  expectedSize: number,
): Promise<boolean> {
  const parts = path.split('/');
  const filename = parts.pop();
  if (!filename) return false;
  let current = root;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part);
    } catch {
      return false;
    }
  }
  try {
    const file = await (await current.getFileHandle(filename)).getFile();
    return file.size === expectedSize;
  } catch {
    return false;
  }
}

export interface ClearAssetCacheResult {
  removedDirectories: string[];
}

/**
 * Clears only this application's boot and map cache namespaces. Save data and
 * legacy session directories are intentionally outside this operation.
 */
export async function clearAssetCache(): Promise<ClearAssetCacheResult> {
  const root = await getOpfsRoot();
  return await withAssetCacheLock('exclusive', async () => {
    const removedDirectories: string[] = [];
    for (const name of [OPFS_PERM_DIR, OPFS_MAP_CACHE_DIR]) {
      try {
        await root.removeEntry(name, { recursive: true });
        removedDirectories.push(name);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    }
    return { removedDirectories };
  }, true);
}

