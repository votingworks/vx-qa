/**
 * Bootstrap and setup VxSuite repository
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { execCommandWithOutput, execCommand } from '../utils/process.ts';
import { getVxSuiteEnvironment, readVxSuiteNodeVersion } from './vxsuite-env.ts';

/**
 * Marker file recording the commit that was last successfully bootstrapped in
 * a given repoPath. A repoPath is reused across VxSuite versions (see
 * cloneOrUpdateRepo checking out different tags in place), and node_modules /
 * build output from one version's dependencies (e.g. a different Vite major)
 * silently persists across a checkout switch unless something forces a
 * reinstall.
 */
const BOOTSTRAP_COMMIT_MARKER = '.vx-qa-bootstrap-commit';

function readBootstrappedCommit(repoPath: string): string | undefined {
  try {
    return readFileSync(join(repoPath, BOOTSTRAP_COMMIT_MARKER), 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if the repository needs bootstrapping. Returns true if node_modules
 * or the app builds are missing, or if the currently checked-out `commit`
 * doesn't match the one recorded by the last successful bootstrap of this
 * repoPath -- otherwise switching versions in a shared repoPath would reuse
 * stale, wrong-version node_modules instead of reinstalling.
 */
export function needsBootstrap(repoPath: string, commit: string): boolean {
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

  if (!allBuildsExist) {
    return true;
  }

  return readBootstrappedCommit(repoPath) !== commit;
}

/**
 * Run the bootstrap script to set up the repository
 * Only bootstraps admin and scan apps to save time
 */
export async function bootstrapRepo(repoPath: string, commit: string): Promise<void> {
  if (!needsBootstrap(repoPath, commit)) {
    logger.info('Repository already bootstrapped, skipping...');
    return;
  }

  logger.step('Bootstrapping admin and scan apps (this may take several minutes)...');

  // pnpm switches to the version VxSuite pins in `packageManager` on its own
  // (see `getVxSuiteEnvironment`), so nothing is installed globally here.
  logger.info(
    `Using VxSuite's pinned Node.js ${readVxSuiteNodeVersion(repoPath)} and ${await readVxSuitePinnedPnpm(repoPath)}`,
  );

  // First, run pnpm install at the root to set up all workspace symlinks
  logger.info('Installing workspace dependencies...');
  const installCode = await execCommandWithOutput('pnpm', ['install'], {
    cwd: repoPath,
    env: getVxSuiteEnvironment(repoPath),
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
    env: getVxSuiteEnvironment(repoPath, { IS_CI: 'true' }),
  });

  if (bootstrapCode !== 0) {
    throw new Error(`Build failed with code ${bootstrapCode}`);
  }

  await writeFile(join(repoPath, BOOTSTRAP_COMMIT_MARKER), commit);

  logger.success('Admin and scan apps bootstrapped successfully');
}

/** Reads the `packageManager` pin from VxSuite's package.json, e.g. `pnpm@9.15.9`. */
async function readVxSuitePinnedPnpm(repoPath: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf-8'));
  const packageManager: unknown = pkg.packageManager;
  if (typeof packageManager !== 'string' || !packageManager.startsWith('pnpm@')) {
    throw new Error(`VxSuite package.json does not pin pnpm in "packageManager"`);
  }
  return packageManager.split('+')[0];
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
      env: getVxSuiteEnvironment(repoPath),
    },
  );

  if (playwrightInstallCode !== 0) {
    throw new Error(`pnpm exec playwright install failed with code ${playwrightInstallCode}`);
  }
}

/** Oldest pnpm that switches to a project's `packageManager` version by default. */
export const REQUIRED_PNPM_VERSION = '10.0.0';

/** Check the pnpm running vx-qa itself. Returns `undefined` when pnpm is missing. */
export async function checkPnpmVersion(): Promise<
  { current: string; required: string; compatible: boolean } | undefined
> {
  let current: string;
  try {
    const result = await execCommand('pnpm', ['--version']);
    if (result.code !== 0) {
      return undefined;
    }
    current = result.stdout.trim();
  } catch {
    return undefined;
  }
  return {
    current,
    required: REQUIRED_PNPM_VERSION,
    compatible: compareVersions(current, REQUIRED_PNPM_VERSION) >= 0,
  };
}

/** Oldest Node.js that runs vx-qa's TypeScript sources directly. */
export const REQUIRED_NODE_VERSION = '22.18.0';

/**
 * Check the Node.js running vx-qa itself. VxSuite's Node.js is chosen
 * separately from its checkout (see `getVxSuiteEnvironment`).
 */
export function checkNodeVersion(current = process.versions.node): {
  current: string;
  required: string;
  compatible: boolean;
} {
  return {
    current,
    required: REQUIRED_NODE_VERSION,
    compatible: compareVersions(current, REQUIRED_NODE_VERSION) >= 0,
  };
}

function compareVersions(a: string, b: string): number {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
