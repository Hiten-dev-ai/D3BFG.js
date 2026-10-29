export interface StoredMetaEntry {
  etag: string;
  size: number;
}

export interface StoredMetaMap {
  manifestEtag: string;
  files: Record<string, StoredMetaEntry>;
}

const META_FILE = '.bfg_meta.json';

export const OPFS_PERM_DIR = 'permanent';
export const OPFS_MAP_CACHE_DIR = 'map-cache';
export const ASSET_CACHE_LOCK_NAME = 'doom3-bfg-asset-cache-v1';

/**
 * Serializes cache reads/writes against an explicit cache clear across tabs.
 * Shared operations may overlap; clearing must hold the exclusive lock.
 */
export async function withAssetCacheLock<T>(
  mode: 'shared' | 'exclusive',
  callback: () => Promise<T>,
  ifAvailable = false,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('Cross-tab asset cache locking is unavailable in this browser.');
  }
  return await navigator.locks.request(
    ASSET_CACHE_LOCK_NAME,
    { mode, ...(ifAvailable ? { ifAvailable: true } : {}) },
    async (lock) => {
      if (!lock) {
        throw new Error('Asset cache is currently in use by another tab. Close other game tabs and retry.');
      }
      return await callback();
    },
  );
}

/**
 * Returns the root OPFS directory handle if supported.
 */
export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('Origin Private File System (OPFS) is not supported in this browser.');
  }
  return await navigator.storage.getDirectory();
}

/**
 * Gets or creates a sub-directory in OPFS.
 */
export async function getOpfsSubdir(
  root: FileSystemDirectoryHandle,
  dirName: string,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  return await root.getDirectoryHandle(dirName, { create });
}

/**
 * Reads the cached metadata manifest from OPFS directory.
 */
export async function readStoredMeta(dir: FileSystemDirectoryHandle): Promise<StoredMetaMap | null> {
  try {
    const handle = await dir.getFileHandle(META_FILE);
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text) as StoredMetaMap;
  } catch {
    return null;
  }
}

/**
 * Writes the metadata manifest into OPFS directory.
 */
export async function writeStoredMeta(
  dir: FileSystemDirectoryHandle,
  meta: StoredMetaMap,
): Promise<void> {
  const handle = await dir.getFileHandle(META_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/**
 * Checks whether a file exists in OPFS and matches the expected size.
 */
export async function verifyOpfsFileExistsAndSize(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  expectedSize: number,
): Promise<boolean> {
  const parts = relativePath.split('/').filter(Boolean);
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
    const fileHandle = await current.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return file.size === expectedSize;
  } catch {
    return false;
  }
}

/**
 * Ensures all parent directories exist for a given relative path in OPFS.
 */
export async function ensureOpfsParentDirectories(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<{ dirHandle: FileSystemDirectoryHandle; filename: string }> {
  const parts = relativePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }

  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }

  return { dirHandle: current, filename };
}

/**
 * Streams a remote file body directly into an OPFS file handle without keeping it in memory.
 */
export async function streamFileToOpfs(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  url: string,
  onChunk?: (bytesRead: number) => void,
  signal?: AbortSignal,
  expectedSize?: number,
): Promise<void> {
  const resp = await fetch(url, { ...(signal ? { signal } : {}), cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`Failed to download ${relativePath}: ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) {
    throw new Error(`Download body empty for ${relativePath}`);
  }

  const { dirHandle, filename } = await ensureOpfsParentDirectories(root, relativePath);
  let hadExistingFile = false;
  try {
    await dirHandle.getFileHandle(filename);
    hadExistingFile = true;
  } catch {
    // The destination is new.
  }
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  if (hadExistingFile) {
    try {
    await fileHandle.getFile();
    } catch {
      hadExistingFile = false;
    }
  }
  const writable = await fileHandle.createWritable();

  const reader = resp.body.getReader();
  let completed = false;
  let totalBytes = 0;
  // Network chunks can be only 16 KiB after gzip decoding. Batch the disk IPC
  // without retaining the archive in RAM or changing the final cached bytes.
  const writeBuffer = new Uint8Array(1024 * 1024);
  let bufferedBytes = 0;
  const flush = async () => {
    if (!bufferedBytes) return;
    await writable.write(writeBuffer.subarray(0, bufferedBytes));
    onChunk?.(bufferedBytes);
    bufferedBytes = 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (expectedSize !== undefined && value.byteLength > expectedSize - totalBytes) {
          throw new Error(`Download exceeded expected size for ${relativePath}`);
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const count = Math.min(writeBuffer.byteLength - bufferedBytes, value.byteLength - offset);
          writeBuffer.set(value.subarray(offset, offset + count), bufferedBytes);
          bufferedBytes += count;
          offset += count;
          if (bufferedBytes === writeBuffer.byteLength) await flush();
        }
        totalBytes += value.byteLength;
      }
    }
    if (expectedSize !== undefined && totalBytes !== expectedSize) {
      throw new Error(`Download size mismatch for ${relativePath}: ${totalBytes}/${expectedSize} bytes`);
    }
    await flush();
    await writable.close();
    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The response may already have failed or been aborted.
      }
      try {
        await writable.abort();
      } catch {
        // Ignore secondary abort failure
      }
      if (!hadExistingFile) {
        try {
          await deleteOpfsFile(root, relativePath);
        } catch {
          // Ignore cleanup failure
        }
      }
    }
  }
}

/**
 * Deletes a file and cleans up empty parent directories in OPFS.
 */
export async function deleteOpfsFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) return;

  const stack: { handle: FileSystemDirectoryHandle; name: string }[] = [];
  let current = root;

  for (const part of parts) {
    try {
      const next = await current.getDirectoryHandle(part);
      stack.push({ handle: current, name: part });
      current = next;
    } catch {
      // Directory doesn't exist
      return;
    }
  }

  try {
    await current.removeEntry(filename);
  } catch {
    // File already gone
  }

  // Attempt to remove empty parent directories in reverse order
  while (stack.length > 0) {
    const { handle: parentHandle, name: childName } = stack.pop()!;
    try {
      const childHandle = await parentHandle.getDirectoryHandle(childName);
      let isEmpty = true;
      for await (const _entry of (childHandle as any).entries()) {
        isEmpty = false;
        break;
      }
      if (isEmpty) {
        await parentHandle.removeEntry(childName);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Recursively scans an OPFS directory and collects File objects with their normalized relative paths.
 * Optionally accepts a Set of allowed relative paths from the active manifest to filter out stale/unmanifested files.
 */
export async function collectOpfsFiles(
  dirHandle: FileSystemDirectoryHandle,
  prefix = '',
  allowedPaths?: Set<string>,
): Promise<{ file: File; relativePath: string }[]> {
  const results: { file: File; relativePath: string }[] = [];

  // Directory iteration using async iterable entries
  for await (const [name, handle] of (dirHandle as any).entries()) {
    if (name === META_FILE) {
      continue;
    }
    const currentPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      if (allowedPaths && !allowedPaths.has(currentPath)) {
        // Skip stale or unmanifested file
        continue;
      }
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      // Ensure relativePath property is attached to the File instance
      Object.defineProperty(file, 'relativePath', {
        value: currentPath,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      results.push({
        file,
        relativePath: currentPath,
      });
    } else if (handle.kind === 'directory') {
      const subHandle = handle as FileSystemDirectoryHandle;
      const subFiles = await collectOpfsFiles(subHandle, currentPath, allowedPaths);
      results.push(...subFiles);
    }
  }

  return results;
}
