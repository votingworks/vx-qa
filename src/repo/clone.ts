/**
 * Git repository cloning and checkout operations
 */

import { simpleGit, SimpleGit } from 'simple-git';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { ensureDir, resolvePath } from '../utils/paths.js';
import type { VxSuiteConfig } from '../config/types.js';
import { rm } from 'node:fs/promises';

const VXSUITE_REPO_URL = 'https://github.com/votingworks/vxsuite.git';

/**
 * Clone or update the VxSuite repository
 */
export async function cloneOrUpdateRepo(config: VxSuiteConfig): Promise<string> {
  const repoPath = resolvePath(config.repoPath);

  if (config.forceClone && existsSync(repoPath)) {
    logger.info('Force clone requested, removing existing repository...');
    await rm(repoPath, { recursive: true, force: true });
  }

  if (!existsSync(repoPath)) {
    await cloneRepo(repoPath);
  } else {
    await updateRepo(repoPath);
  }

  await checkoutTag(repoPath, config.ref);

  return repoPath;
}

/**
 * Clone the VxSuite repository
 */
async function cloneRepo(repoPath: string): Promise<void> {
  const spinner = logger.spinner(`Cloning VxSuite repository to ${repoPath}...`);

  try {
    // Ensure parent directory exists
    const parentDir = resolvePath(repoPath, '..');
    ensureDir(parentDir);

    const git: SimpleGit = simpleGit();
    await git.clone(VXSUITE_REPO_URL, repoPath, ['--depth', '1', '--no-single-branch']);

    spinner.succeed('Repository cloned successfully');
  } catch (error) {
    spinner.fail('Failed to clone repository');
    throw error;
  }
}

/**
 * Update (fetch) the existing repository
 */
async function updateRepo(repoPath: string): Promise<void> {
  const spinner = logger.spinner('Fetching latest changes...');

  try {
    const git: SimpleGit = simpleGit(repoPath);
    await git.fetch(['--tags', '--prune']);

    spinner.succeed('Repository updated');
  } catch (error) {
    spinner.fail('Failed to update repository');
    throw error;
  }
}

/**
 * Checkout a specific tag or branch
 */
async function checkoutTag(repoPath: string, tag: string): Promise<void> {
  const spinner = logger.spinner(`Checking out ${tag}...`);

  try {
    const git: SimpleGit = simpleGit(repoPath);

    // First try to fetch the specific tag/branch if not available locally
    try {
      await git.fetch(['origin', tag, '--depth', '1']);
    } catch {
      // Tag might already be available locally
    }

    // Checkout the tag/branch
    await git.checkout(tag);

    spinner.succeed(`Checked out ${tag}`);
  } catch (error) {
    spinner.fail(`Failed to checkout ${tag}`);
    throw error;
  }
}

/**
 * Get the current commit hash
 */
export async function getCurrentCommit(repoPath: string): Promise<string> {
  const git: SimpleGit = simpleGit(repoPath);
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || 'unknown';
}

/**
 * List available tags
 */
export async function listTags(repoPath: string): Promise<string[]> {
  const git: SimpleGit = simpleGit(repoPath);
  const tags = await git.tags();
  return tags.all;
}

/**
 * List available branches
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const git: SimpleGit = simpleGit(repoPath);
  const branches = await git.branch(['-r']);
  return branches.all.map((b) => b.replace('origin/', ''));
}
