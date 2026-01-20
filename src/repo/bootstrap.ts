/**
 * Bootstrap and setup VxSuite repository
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { execCommandWithOutput, execCommand } from '../utils/process.js';

/**
 * Check if the repository needs bootstrapping
 */
export function needsBootstrap(repoPath: string): boolean {
  // Check if node_modules exists in the root
  const nodeModulesPath = join(repoPath, 'node_modules');
  return !existsSync(nodeModulesPath);
}

/**
 * Run the bootstrap script to set up the repository
 * Only bootstraps admin and scan apps to save time
 */
export async function bootstrapRepo(repoPath: string): Promise<void> {
  if (!needsBootstrap(repoPath)) {
    logger.info('Repository already bootstrapped, skipping...');
    return;
  }

  logger.step('Bootstrapping admin and scan apps (this may take several minutes)...');

  // Install dependencies for admin and scan apps only using pnpm workspace filtering
  // The "..." syntax includes all dependencies (transitive)
  // We need to install admin, scan, and dev-dock (required for integration testing)
  logger.info('Running pnpm install for admin and scan apps and their dependencies...');
  const pnpmCode = await execCommandWithOutput(
    'pnpm',
    [
      'install',
      '--filter',
      '@votingworks/admin-frontend...',
      '--filter',
      '@votingworks/admin-backend...',
      '--filter',
      '@votingworks/scan-frontend...',
      '--filter',
      '@votingworks/scan-backend...',
    ],
    {
      cwd: repoPath,
      env: { ...process.env },
    },
  );

  if (pnpmCode !== 0) {
    throw new Error(`pnpm install failed with code ${pnpmCode}`);
  }

  // Build the libraries and apps that were installed
  // Use --recursive to build dependencies in the correct order
  logger.info('Building admin and scan apps and their dependencies...');
  const buildCode = await execCommandWithOutput(
    'pnpm',
    [
      '--recursive',
      '--filter',
      '@votingworks/admin-frontend...',
      '--filter',
      '@votingworks/admin-backend...',
      '--filter',
      '@votingworks/scan-frontend...',
      '--filter',
      '@votingworks/scan-backend...',
      'build',
    ],
    {
      cwd: repoPath,
      env: { ...process.env },
    },
  );

  if (buildCode !== 0) {
    throw new Error(`Build failed with code ${buildCode}`);
  }

  logger.success('Admin and scan apps bootstrapped successfully');
}

/**
 * Check if pnpm is available
 */
export async function checkPnpmAvailable(): Promise<boolean> {
  try {
    const result = await execCommand('pnpm', ['--version']);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check if node version matches requirements
 */
export async function checkNodeVersion(): Promise<{
  current: string;
  required: string;
  compatible: boolean;
}> {
  const result = await execCommand('node', ['--version']);
  const current = result.stdout.trim().replace('v', '');
  const required = '20.0.0';

  const [currentMajor] = current.split('.');
  const [requiredMajor] = required.split('.');

  return {
    current,
    required,
    compatible: parseInt(currentMajor) >= parseInt(requiredMajor),
  };
}
