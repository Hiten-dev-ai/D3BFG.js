export interface ScannedFile {
  file: File;
  relativePath: string; // e.g. "base/default.cfg", "base/_common.resources", "base/maps/game.resources"
}

export interface ValidationSummary {
  isValid: boolean;
  baseFolderFound: boolean;
  hasDefaultCfg: boolean;
  foundRootResources: string[];
  missingRootResources: string[];
  mapResourcesCount: number;
  totalFiles: number;
  totalBytes: number;
  issues: string[];
}

export const REQUIRED_ROOT_RESOURCES = [
  '_common.resources',
  '_ordered.resources',
  '_sound_pc.resources',
];

/**
 * Normalizes relative path separators to forward slashes and strips leading/trailing slashes.
 */
export function normalizeRelativePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Validates the staged files against the required BFG boot/menu data layout:
 * - base/default.cfg
 * - BFG root archives and localized PC sound data
 * - Maps are not required for boot/menu initialization.
 */
export function validateGameData(stagedFiles: ScannedFile[]): ValidationSummary {
  const pathToFiles = new Map<string, ScannedFile>();
  let totalBytes = 0;

  for (const item of stagedFiles) {
    const lower = item.relativePath.toLowerCase();
    pathToFiles.set(lower, item);
    totalBytes += item.file.size;
  }

  const issues: string[] = [];
  const baseFolderFound = Array.from(pathToFiles.keys()).some((k) => k.startsWith('base/'));
  if (!baseFolderFound) {
    issues.push('Missing "base" directory. Please check that game data is configured.');
  }

  const hasDefaultCfg = pathToFiles.has('base/default.cfg');
  if (!hasDefaultCfg) {
    issues.push('Missing "base/default.cfg". This file is required for engine configuration.');
  }

  const foundRootResources: string[] = [];
  const missingRootResources: string[] = [];

  for (const res of REQUIRED_ROOT_RESOURCES) {
    const target = `base/${res.toLowerCase()}`;
    if (pathToFiles.has(target)) {
      foundRootResources.push(res);
    } else {
      missingRootResources.push(res);
    }
  }

  const hasLocalizedPcSound = Array.from(pathToFiles.keys()).some(
    (path) => path.startsWith('base/_sound_pc_') && path.endsWith('.resources'),
  );
  if (hasLocalizedPcSound) {
    foundRootResources.push('_sound_pc_<language>.resources');
  } else {
    missingRootResources.push('_sound_pc_<language>.resources');
  }

  if (missingRootResources.length > 0) {
    issues.push(`Missing required root resource archive(s): ${missingRootResources.join(', ')}.`);
  }

  // Count maps if present (0 is now valid because map archives are loaded per-session, not at permanent startup)
  let mapResourcesCount = 0;
  for (const k of pathToFiles.keys()) {
    if (k.startsWith('base/maps/') && k.endsWith('.resources')) {
      mapResourcesCount++;
    }
  }

  const isValid = issues.length === 0;

  return {
    isValid,
    baseFolderFound,
    hasDefaultCfg,
    foundRootResources,
    missingRootResources,
    mapResourcesCount,
    totalFiles: stagedFiles.length,
    totalBytes,
    issues,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
