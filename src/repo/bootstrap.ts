/**
 * Bootstrap and setup VxSuite repository
 */

import { existsSync } from 'node:fs';
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

  // Pre-fetch Rust crates for this ref. VxSuite's Rust addons (pdi-scanner,
  // ballot-interpreter) build with `cargo build --offline`, which requires
  // every crate to already be in the local cargo cache. The CI image only
  // caches crates for its own VxSuite version, so building a different ref can
  // hit crates it hasn't seen (e.g. `csv`). Fetching here (online, against this
  // ref's Cargo.lock) populates the cache so the offline builds resolve.
  await fetchRustDependencies(repoPath);

  // Then build just the admin and scan apps (and their dependencies)
  // Use the "..." filter syntax to include all dependencies
  // Build each app separately in sequence to ensure dependencies are built first
  logger.info('Building apps and their dependencies...');

  const bootstrapScriptPath = join(repoPath, 'script/bootstrap');

  const bootstrapCode = await execCommandWithOutput(bootstrapScriptPath, [], {
    cwd: repoPath,
    env: { ...process.env, IS_CI: 'true' },
  });

  if (bootstrapCode !== 0) {
    throw new Error(`Build failed with code ${bootstrapCode}`);
  }

  logger.success('Admin and scan apps bootstrapped successfully');
}

/**
 * Fetch all Rust crate dependencies for the VxSuite cargo workspace so that the
 * subsequent `cargo build --offline` addon builds can resolve them. Runs online
 * against the checked-out ref's Cargo.lock.
 *
 * A failure here is not fatal on its own: if crates are already cached the
 * offline build still succeeds, and if they are not, the build step will
 * surface the definitive error.
 */
async function fetchRustDependencies(repoPath: string): Promise<void> {
  logger.info('Fetching Rust crate dependencies (cargo fetch)...');

  const cargoBin = join(process.env.HOME ?? '', '.cargo/bin');
  const code = await execCommandWithOutput('cargo', ['fetch'], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ''}` },
  });

  if (code !== 0) {
    logger.warn(`cargo fetch exited with code ${code}; continuing to build`);
  }
}

/**
 * Installs the playwright browsers needed by vxsuite. Note that the versions
 * of these browser may be different than the versions installed by our version
 * of playwright.
 */
export async function installPlaywrightBrowsers(repoPath: string): Promise<void> {
  const playwrightInstallCode = await execCommandWithOutput(
    'pnpm',
    ['exec', 'playwright', 'install'],
    {
      cwd: join(repoPath, 'libs/printing'),
      env: { ...process.env },
    },
  );

  if (playwrightInstallCode !== 0) {
    throw new Error(`pnpm exec playwright install failed with code ${playwrightInstallCode}`);
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
