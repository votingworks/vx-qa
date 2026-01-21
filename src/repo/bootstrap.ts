/**
 * Bootstrap and setup VxSuite repository
 */

import { existsSync } from 'fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { execCommandWithOutput, execCommand } from '../utils/process.js';

/**
 * Check if the repository needs bootstrapping
 */
export function needsBootstrap(repoPath: string): boolean {
  // Check if node_modules exists in the root
  const nodeModulesPath = join(repoPath, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    return true;
  }

  // Check if the admin and scan apps are built
  const adminFrontendBuild = join(repoPath, 'apps/admin/frontend/build');
  const adminBackendBuild = join(repoPath, 'apps/admin/backend/build');
  const scanFrontendBuild = join(repoPath, 'apps/scan/frontend/build');
  const scanBackendBuild = join(repoPath, 'apps/scan/backend/build');

  const allBuildsExist =
    existsSync(adminFrontendBuild) &&
    existsSync(adminBackendBuild) &&
    existsSync(scanFrontendBuild) &&
    existsSync(scanBackendBuild);

  return !allBuildsExist;
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

  // First, run pnpm install at the root to set up all workspace symlinks
  logger.info('Installing workspace dependencies...');
  const installCode = await execCommandWithOutput('pnpm', ['install'], {
    cwd: repoPath,
    env: { ...process.env },
  });

  if (installCode !== 0) {
    throw new Error(`pnpm install failed with code ${installCode}`);
  }

  // Then build just the admin and scan apps (and their dependencies)
  // Use the "..." filter syntax to include all dependencies
  // Build each app separately in sequence to ensure dependencies are built first
  logger.info('Building admin and scan apps and their dependencies...');

  const appsToBuild = [
    '@votingworks/admin-frontend',
    '@votingworks/admin-backend',
    '@votingworks/scan-frontend',
    '@votingworks/scan-backend',
  ];

  for (const app of appsToBuild) {
    logger.info(`Building ${app} and its dependencies...`);
    const buildCode = await execCommandWithOutput('pnpm', ['--filter', `${app}...`, 'build'], {
      cwd: repoPath,
      env: { ...process.env, IS_CI: 'true' },
    });

    if (buildCode !== 0) {
      throw new Error(`Build failed for ${app} with code ${buildCode}`);
    }
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
