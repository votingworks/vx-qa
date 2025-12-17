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
 */
export async function bootstrapRepo(repoPath: string): Promise<void> {
  if (!needsBootstrap(repoPath)) {
    logger.info('Repository already bootstrapped, skipping...');
    return;
  }

  logger.step('Running repository bootstrap (this may take several minutes)...');

  // First, run script/bootstrap
  const bootstrapScript = join(repoPath, 'script', 'bootstrap');

  if (existsSync(bootstrapScript)) {
    logger.info('Running script/bootstrap...');
    const bootstrapCode = await execCommandWithOutput('bash', [bootstrapScript], {
      cwd: repoPath,
      env: { ...process.env },
    });

    if (bootstrapCode !== 0) {
      throw new Error(`Bootstrap script failed with code ${bootstrapCode}`);
    }
  } else {
    logger.warn('Bootstrap script not found, running pnpm install directly...');
  }

  // Then run pnpm install
  logger.info('Running pnpm install...');
  const pnpmCode = await execCommandWithOutput('pnpm', ['install'], {
    cwd: repoPath,
    env: { ...process.env },
  });

  if (pnpmCode !== 0) {
    throw new Error(`pnpm install failed with code ${pnpmCode}`);
  }

  logger.success('Repository bootstrapped successfully');
}

/**
 * Build a specific app in the repository
 */
export async function buildApp(
  repoPath: string,
  app: 'admin' | 'scan'
): Promise<void> {
  const spinner = logger.spinner(`Building ${app} app...`);

  try {
    const appPath = join(repoPath, 'apps', app);

    // Build frontend
    const frontendPath = join(appPath, 'frontend');
    const frontendResult = await execCommand('pnpm', ['build'], {
      cwd: frontendPath,
      env: { ...process.env },
    });

    if (frontendResult.code !== 0) {
      throw new Error(`Frontend build failed: ${frontendResult.stderr}`);
    }

    // Build backend
    const backendPath = join(appPath, 'backend');
    const backendResult = await execCommand('pnpm', ['build'], {
      cwd: backendPath,
      env: { ...process.env },
    });

    if (backendResult.code !== 0) {
      throw new Error(`Backend build failed: ${backendResult.stderr}`);
    }

    spinner.succeed(`${app} app built successfully`);
  } catch (error) {
    spinner.fail(`Failed to build ${app} app`);
    throw error;
  }
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
