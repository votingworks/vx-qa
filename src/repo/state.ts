/**
 * State management - clearing mock state between runs
 */

import { rm, readdir, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { expandHome, resolvePath } from '../utils/paths.js';

export class State {
  static defaultFor(repoPath: string): State {
    return new State(
      repoPath,
      join(repoPath, 'libs/usb-drive/dev-workspace'),
      join(repoPath, 'libs/fujitsu-thermal-printer/dev-workspace'),
      expandHome('~/.vx-dev-dock'),
    );
  }

  private constructor(
    private readonly repoPath: string,
    private readonly usbDrivePath: string,
    private readonly printerPath: string,
    private readonly devDockPath: string,
  ) {}

  async clear(): Promise<void> {
    logger.step('Clearing all state for fresh QA run...');
    await this.clearMockState();
    await this.clearAppWorkspaces();
    logger.success('All state cleared');
  }

  private async clearMockState(): Promise<void> {
    const spinner = logger.spinner('Clearing mock state...');

    try {
      await clearDirectory(this.usbDrivePath);
      await clearDirectory(this.printerPath);
      await clearDirectory(this.devDockPath);
      await this.clearAppWorkspaces();

      spinner.succeed('Mock state cleared');
    } catch (error) {
      spinner.fail('Failed to clear mock state');
      throw error;
    }
  }

  private async clearAppWorkspaces(): Promise<void> {
    // Clear the dev workspace directory
    const appsRoot = join(this.repoPath, 'apps');
    const apps = await readdir(appsRoot);

    for (const app of apps) {
      const backendPath = join(appsRoot, app, 'backend');
      const devWorkspace = join(backendPath, 'dev-workspace');
      await clearDirectory(devWorkspace);
      logger.debug(`[${app}] Cleared dev workspace`);
    }
  }

  async copyWorkspacesTo(outputPath: string): Promise<void> {
    const spinner = logger.spinner('Copying workspace data...');

    try {
      await Promise.all(
        [
          ['admin', join(this.repoPath, 'apps/admin/backend/dev-workspace')],
          ['scan', join(this.repoPath, 'apps/scan/backend/dev-workspace')],
          ['usb-drive', this.usbDrivePath],
          ['fujitsu-thermal-printer', this.printerPath],
        ].map(async ([name, path]) => {
          const workspacePath = join(outputPath, name);
          await mkdir(workspacePath, { recursive: true });
          await cp(path, workspacePath, { recursive: true });
        }),
      );
      spinner.succeed('Workspace data copied to output');
    } catch (error) {
      spinner.fail('Failed to copy workspace data to output');
      throw error;
    }
  }
}

/**
 * Clear a directory by removing all its contents
 */
async function clearDirectory(dirPath: string): Promise<void> {
  const resolved = resolvePath(dirPath);

  try {
    await rm(resolved, { recursive: true, force: true });
    logger.debug(`Cleared ${resolved}`);
  } catch (error) {
    logger.warn(`Failed to clear ${resolved}: ${(error as Error).message}`);
  }
}
