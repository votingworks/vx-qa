/**
 * Path utilities for resolving and managing file paths
 */

import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

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
 * Ensure the parent directory of a file exists
 */
export function ensureParentDir(filePath: string): string {
  const parentDir = dirname(resolvePath(filePath));
  return ensureDir(parentDir);
}

/**
 * Generate a timestamped output directory name
 */
export function generateTimestampedDir(baseDir: string, prefix = 'run'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(resolvePath(baseDir), `${prefix}-${timestamp}`);
}

/**
 * Get the default VxSuite repository path
 */
export function getDefaultRepoPath(): string {
  return resolvePath('~/.vx-qa/vxsuite');
}

/**
 * Get the default output directory
 */
export function getDefaultOutputDir(): string {
  return resolvePath('./qa-output');
}

/**
 * Mock state directories that need to be cleared between runs
 */
export const MOCK_STATE_DIRS = {
  usb: '/tmp/mock-usb',
  printer: '/tmp/mock-printer',
  devDock: expandHome('~/.vx-dev-dock'),
};
