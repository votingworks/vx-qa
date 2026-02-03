/**
 * Screenshot utilities for capturing app state
 */

import { Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import type { ScreenshotArtifact } from '../config/types.js';

export interface ScreenshotManager {
  /**
   * Take a screenshot at a named step
   */
  capture(name: string, label: string): Promise<ScreenshotArtifact>;

  /**
   * Get all captured screenshots
   */
  getAll(): ScreenshotArtifact[];
}

/**
 * Create a screenshot manager
 */
export async function createScreenshotManager(
  page: Page,
  outputDir: string,
): Promise<ScreenshotManager> {
  const screenshotsDir = join(outputDir, 'screenshots');
  const screenshots: ScreenshotArtifact[] = [];

  // Ensure screenshots directory exists
  await mkdir(screenshotsDir, { recursive: true });

  return {
    async capture(name: string, label: string): Promise<ScreenshotArtifact> {
      const filename = `${screenshots.length.toString().padStart(3, '0')}-${name}.png`;
      const path = join(screenshotsDir, filename);

      await page.screenshot({
        path,
        animations: 'disabled',
      });

      const artifact: ScreenshotArtifact = {
        name,
        label,
        path,
        timestamp: new Date(),
      };

      screenshots.push(artifact);
      logger.info(`Screenshot: ${name}`);

      return artifact;
    },

    getAll(): ScreenshotArtifact[] {
      return [...screenshots];
    },
  };
}
