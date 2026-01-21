/**
 * Path utilities for resolving and managing file paths
 */

import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert';

/**
 * Expand ~ to home directory
 */
export function expandHome(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Resolve a path, expanding ~ and making it absolute
 */
export function resolvePath(path: string, basePath?: string): string {
  const expanded = expandHome(path);
  if (basePath) {
    return resolve(basePath, expanded);
  }
  return resolve(expanded);
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDir(path: string): string {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Generate a timestamped output directory name
 */
export function generateTimestampedDir(baseDir: string, prefix = 'run'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(resolvePath(baseDir), `${prefix}-${timestamp}`);
}

/**
 * Determines whether two paths are equal, using `baseDir` as the base if either
 * path is relative. `baseDir` defaults to the working directory and must be
 * absolute.
 */
export function pathsEqual(a: string, b: string, baseDir = process.cwd()): boolean {
  assert(isAbsolute(baseDir), 'baseDir must be absolute');
  const aNormalized = isAbsolute(a) ? a : join(baseDir, a);
  const bNormalized = isAbsolute(b) ? b : join(baseDir, b);
  return aNormalized === bNormalized;
}
