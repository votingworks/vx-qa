/**
 * Screenshot utilities for capturing app state
 */

import { Page } from '@playwright/test';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import type { ScreenshotArtifact } from '../config/types.js';

export interface ScreenshotManager {
  /**
   * Take a screenshot at a named step
   */
  capture(name: string, step: string): Promise<ScreenshotArtifact>;

  /**
   * Take a screenshot of a modal/dialog
   */
  captureModal(name: string, step: string): Promise<ScreenshotArtifact>;

  /**
   * Get all captured screenshots
   */
  getAll(): ScreenshotArtifact[];
}

/**
 * Create a screenshot manager
 */
export function createScreenshotManager(page: Page, outputDir: string): ScreenshotManager {
  const screenshotsDir = join(outputDir, 'screenshots');
  const screenshots: ScreenshotArtifact[] = [];

  // Ensure screenshots directory exists
  if (!existsSync(screenshotsDir)) {
    mkdirSync(screenshotsDir, { recursive: true });
  }

  return {
    async capture(name: string, step: string): Promise<ScreenshotArtifact> {
      const filename = `${screenshots.length.toString().padStart(3, '0')}-${name}.png`;
      const path = join(screenshotsDir, filename);

      await page.screenshot({
        path,
        animations: 'disabled',
      });

      const artifact: ScreenshotArtifact = {
        name,
        step,
        path,
        timestamp: new Date(),
      };

      screenshots.push(artifact);
      logger.info(`Screenshot: ${name}`);

      return artifact;
    },

    async captureModal(name: string, step: string): Promise<ScreenshotArtifact> {
      const filename = `${screenshots.length.toString().padStart(3, '0')}-${name}.png`;
      const path = join(screenshotsDir, filename);

      // Try to screenshot just the modal dialog
      try {
        const dialog = page.getByRole('alertdialog');
        await dialog.screenshot({
          path,
          animations: 'disabled',
        });
      } catch {
        // Fall back to full page screenshot
        await page.screenshot({
          path,
          animations: 'disabled',
        });
      }

      const artifact: ScreenshotArtifact = {
        name,
        step,
        path,
        timestamp: new Date(),
      };

      screenshots.push(artifact);
      logger.debug(`Screenshot (modal): ${name}`);

      return artifact;
    },

    getAll(): ScreenshotArtifact[] {
      return [...screenshots];
    },
  };
}
