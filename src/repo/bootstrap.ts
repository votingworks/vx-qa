/**
 * Bootstrap and setup VxSuite repository
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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

  // Allow the Rust addon builds to fetch crates. VxSuite's addons (pdi-scanner,
  // ballot-interpreter) build with `cargo build --offline`, which requires
  // every crate to already be in that build's cargo cache. The CI image only
  // caches crates for its own VxSuite version, so building a different ref hits
  // crates it hasn't seen (e.g. `csv`) and fails. Drop `--offline` so the build
  // downloads what it needs.
  await allowOnlineRustBuilds(repoPath);

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
 * Rust addon build scripts that hard-code `cargo build --offline`, relative to
 * the VxSuite repo root. Offline builds require all crates to be pre-cached,
 * which isn't guaranteed when building an arbitrary ref in CI.
 */
const RUST_ADDON_PACKAGE_JSONS = [
  'libs/pdi-scanner/package.json',
  'libs/ballot-interpreter/package.json',
];

/**
 * Strip `--offline` from VxSuite's Rust addon build scripts so cargo can
 * download any crates missing from the local cache. Idempotent; skips files
 * that don't exist or don't use `--offline`.
 */
async function allowOnlineRustBuilds(repoPath: string): Promise<void> {
  for (const relPath of RUST_ADDON_PACKAGE_JSONS) {
    const filePath = join(repoPath, relPath);
    if (!existsSync(filePath)) {
      continue;
    }

    const contents = await readFile(filePath, 'utf-8');
    if (!contents.includes(' --offline')) {
      continue;
    }

    await writeFile(filePath, contents.replaceAll(' --offline', ''));
    logger.info(`Removed --offline from ${relPath}`);
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
