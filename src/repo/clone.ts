/**
 * Git repository cloning and checkout operations
 */

import { simpleGit, SimpleGit } from 'simple-git';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { ensureDir, resolvePath } from '../utils/paths.js';
import type { VxSuiteConfig } from '../config/types.js';
import { rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

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

    // Restore any modified tracked files to their committed state
    // This ensures the patch can be applied cleanly
    try {
      await git.raw(['restore', '.']);
      logger.debug('Restored modified tracked files');
    } catch {
      // Ignore if there are no changes to restore
    }

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
 * Apply a patch file to the repository using the patch command
 */
async function runPatchCommand(
  repoPath: string,
  patchContent: string,
  dryRun: boolean,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-p1', '--forward'];
    if (dryRun) {
      args.push('--dry-run');
    }

    const patchProcess = spawn('patch', args, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    patchProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    patchProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    patchProcess.on('error', (error) => {
      reject(error);
    });

    patchProcess.on('close', (code) => {
      const output = stdout + stderr;
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        resolve({ success: false, output });
      }
    });

    // Write patch content to stdin
    patchProcess.stdin?.write(patchContent);
    patchProcess.stdin?.end();
  });
}

/**
 * Apply a patch file to the repository
 */
export async function applyPatch(repoPath: string, patchPath: string): Promise<void> {
  const spinner = logger.spinner('Applying patch...');

  try {
    // Read patch content
    const patchContent = await readFile(patchPath, 'utf-8');

    // Try to apply the patch with dry-run first
    const dryRunResult = await runPatchCommand(repoPath, patchContent, true);

    if (!dryRunResult.success) {
      // Check if patch was already applied
      if (
        dryRunResult.output.includes('Reversed (or previously applied) patch detected') ||
        dryRunResult.output.includes('previously applied')
      ) {
        spinner.succeed('Patch already applied');
        return;
      }

      // Patch failed
      spinner.fail('Failed to apply patch');
      throw new Error(`Patch application failed:\n${dryRunResult.output}`);
    }

    // Apply for real
    const applyResult = await runPatchCommand(repoPath, patchContent, false);

    if (!applyResult.success) {
      spinner.fail('Failed to apply patch');
      throw new Error(`Patch application failed:\n${applyResult.output}`);
    }

    spinner.succeed('Patch applied successfully');
  } catch (error) {
    spinner.fail('Failed to apply patch');
    throw error;
  }
}
