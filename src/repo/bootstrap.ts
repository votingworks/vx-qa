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

  // Run make bootstrap for admin and scan apps specifically
  // This follows the same pattern as the original script/bootstrap but only for the apps we need
  const appsToBootstrap = [
    join(repoPath, 'apps/admin/frontend'),
    join(repoPath, 'apps/admin/backend'),
    join(repoPath, 'apps/scan/frontend'),
    join(repoPath, 'apps/scan/backend'),
  ];

  for (const appPath of appsToBootstrap) {
    const appName = appPath.replace(repoPath + '/', '');
    logger.info(`Bootstrapping ${appName}...`);

    const makeCode = await execCommandWithOutput('make', ['-C', appPath, 'bootstrap'], {
      cwd: repoPath,
      env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}:/sbin/` },
    });

    if (makeCode !== 0) {
      throw new Error(`Bootstrap failed for ${appName} with code ${makeCode}`);
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
