/**
 * State management - clearing mock state between runs
 */

import { existsSync } from 'fs';
import { rm, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { MOCK_STATE_DIRS, resolvePath } from '../utils/paths.js';

/**
 * Clear all mock state directories
 */
export async function clearMockState(): Promise<void> {
  const spinner = logger.spinner('Clearing mock state...');

  try {
    // Clear USB mock state
    await clearDirectory(MOCK_STATE_DIRS.usb);

    // Clear printer mock state
    await clearDirectory(MOCK_STATE_DIRS.printer);

    // Clear dev-dock state
    await clearDirectory(MOCK_STATE_DIRS.devDock);

    spinner.succeed('Mock state cleared');
  } catch (error) {
    spinner.fail('Failed to clear mock state');
    throw error;
  }
}

/**
 * Clear a directory by removing all its contents
 */
async function clearDirectory(dirPath: string): Promise<void> {
  const resolved = resolvePath(dirPath);

  if (!existsSync(resolved)) {
    return;
  }

  try {
    await rm(resolved, { recursive: true, force: true });
    logger.debug(`Cleared ${resolved}`);
  } catch (error) {
    logger.warn(`Failed to clear ${resolved}: ${error}`);
  }
}

/**
 * Clear app databases (SQLite files)
 */
export async function clearAppDatabases(repoPath: string): Promise<void> {
  const apps = ['admin', 'scan'];

  for (const app of apps) {
    const backendPath = join(repoPath, 'apps', app, 'backend');
    await clearSqliteFiles(backendPath);
  }

  logger.debug('App databases cleared');
}

/**
 * Find and clear SQLite database files in a directory
 */
async function clearSqliteFiles(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    return;
  }

  try {
    const files = await readdir(dirPath);
    const sqliteFiles = files.filter(
      (f) => f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3')
    );

    for (const file of sqliteFiles) {
      const filePath = join(dirPath, file);
      try {
        await unlink(filePath);
        logger.debug(`Removed database: ${filePath}`);
      } catch (error) {
        logger.warn(`Failed to remove ${filePath}: ${error}`);
      }
    }
  } catch (error) {
    logger.warn(`Failed to read directory ${dirPath}: ${error}`);
  }
}

/**
 * Clear VxSuite workspace state
 */
export async function clearWorkspaceState(repoPath: string): Promise<void> {
  // Clear the dev workspace directory
  const devWorkspace = join(repoPath, 'dev-workspace');
  if (existsSync(devWorkspace)) {
    await rm(devWorkspace, { recursive: true, force: true });
    logger.debug('Cleared dev workspace');
  }
}

/**
 * Clear all state for a fresh QA run
 */
export async function clearAllState(repoPath: string): Promise<void> {
  logger.step('Clearing all state for fresh QA run...');

  await clearMockState();
  await clearAppDatabases(repoPath);
  await clearWorkspaceState(repoPath);

  logger.success('All state cleared');
}
