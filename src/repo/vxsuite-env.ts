/**
 * Environment for running commands inside a VxSuite checkout.
 *
 * VxSuite pins its own Node.js version in `.node-version` and its pnpm version
 * in `packageManager`, and both may differ from what runs vx-qa. pnpm's
 * `use-node-version` setting makes it download that exact Node and use it for
 * every `pnpm run`/`pnpm exec` and lifecycle script, and
 * `manage-package-manager-versions` makes it switch to the pinned pnpm. Neither
 * depends on a version manager on the host.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NODE_VERSION_FILE = '.node-version';

/** Reads the Node.js version VxSuite pins in `<repoPath>/.node-version`. */
export function readVxSuiteNodeVersion(repoPath: string): string {
  const filePath = join(repoPath, NODE_VERSION_FILE);
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`VxSuite checkout has no ${NODE_VERSION_FILE} at ${filePath}`);
  }

  const version = contents.trim().replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Unexpected Node.js version "${contents.trim()}" in ${filePath}`);
  }
  return version;
}

export interface VxSuiteEnvironmentOptions {
  /** Environment to derive from. */
  base: NodeJS.ProcessEnv;
  /** Node.js version VxSuite should run under. */
  nodeVersion: string;
}

/**
 * Builds a VxSuite environment from explicit inputs. Every VxSuite command runs
 * through `pnpm`, which puts the pinned Node ahead of the host's on PATH, so
 * the host PATH is left untouched and `pnpm` itself stays reachable.
 */
export function buildVxSuiteEnvironment({
  base,
  nodeVersion,
}: VxSuiteEnvironmentOptions): NodeJS.ProcessEnv {
  return {
    ...base,
    npm_config_use_node_version: nodeVersion,
    npm_config_manage_package_manager_versions: 'true',
  };
}

/** Environment for running commands inside the VxSuite checkout at `repoPath`. */
export function getVxSuiteEnvironment(
  repoPath: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...buildVxSuiteEnvironment({
      base: process.env,
      nodeVersion: readVxSuiteNodeVersion(repoPath),
    }),
    ...extra,
  };
}
