/**
 * VxAdmin automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { logInAsSystemAdministrator, logOut } from './auth-helpers.js';
import { navigateToApp, waitForText, clickButton, isTextVisible } from './browser.js';
import { createScreenshotManager, SCREENSHOT_STEPS } from './screenshot.js';
import { readFileSync } from 'fs';
import { basename } from 'path';

export interface AdminWorkflowResult {
  exportedPackagePath: string;
  screenshots: string[];
}

/**
 * Run the VxAdmin configuration workflow
 */
export async function runAdminWorkflow(
  page: Page,
  electionPackagePath: string,
  outputDir: string
): Promise<AdminWorkflowResult> {
  logger.step('Running VxAdmin workflow');

  const screenshots = createScreenshotManager(page, outputDir);
  const usbController = createMockUsbController();

  // Navigate to app
  await navigateToApp(page);
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_LOCKED, 'Initial locked screen');

  // Log in as system administrator
  await logInAsSystemAdministrator(page, electionPackagePath);
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_UNCONFIGURED, 'Logged in, unconfigured');

  // Wait for USB prompt or election screen
  const hasElection = await isTextVisible(page, 'Election');

  if (!hasElection) {
    // Need to load election from USB
    logger.debug('Loading election from USB');

    // Copy election package to USB
    const packageFilename = basename(electionPackagePath);
    const packageData = readFileSync(electionPackagePath);
    await usbController.writeFile(packageFilename, packageData);

    // Insert USB drive
    await usbController.insert();
    await page.waitForTimeout(1000);

    await screenshots.capture(SCREENSHOT_STEPS.ADMIN_USB_DETECTED, 'USB drive detected');

    // Wait for package to appear and click it
    await waitForText(page, packageFilename, { timeout: 10000 });
    await page.getByText(packageFilename).click();

    await page.waitForTimeout(2000);
    await screenshots.capture(SCREENSHOT_STEPS.ADMIN_ELECTION_LOADED, 'Election loaded');
  }

  // Verify election is configured
  await waitForText(page, 'Election', { timeout: 10000 });
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_CONFIGURED, 'Election configured');

  // Export election package for VxScan
  logger.debug('Exporting election package');

  // Click Save Election Package button
  await clickButton(page, 'Save Election Package');
  await page.waitForTimeout(500);
  await screenshots.captureModal(SCREENSHOT_STEPS.ADMIN_EXPORT_PACKAGE, 'Export dialog');

  // Confirm export
  await clickButton(page, 'Save');
  await waitForText(page, 'Saved', { timeout: 10000 });
  await page.getByRole('button', { name: 'Close' }).click();

  // Get the exported package path
  const exportedPackagePath = await getExportedPackagePath(usbController.getDataPath());

  // Log out
  await logOut(page);
  await screenshots.capture('admin-logged-out', 'Logged out');

  // Remove USB
  await usbController.remove();

  return {
    exportedPackagePath,
    screenshots: screenshots.getAll().map((s) => s.path),
  };
}

/**
 * Find the exported election package on the USB drive
 */
async function getExportedPackagePath(usbDataPath: string): Promise<string> {
  const { readdirSync, statSync } = await import('fs');
  const { join } = await import('path');

  // Look for ZIP files in the USB data directory
  const findZipFiles = (dir: string): string[] => {
    const results: string[] = [];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          results.push(...findZipFiles(fullPath));
        } else if (entry.name.endsWith('.zip')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }

    return results;
  };

  const zipFiles = findZipFiles(usbDataPath);

  if (zipFiles.length === 0) {
    throw new Error('No election package found on USB drive');
  }

  // Return the most recently modified ZIP file
  const sorted = zipFiles
    .map((path) => ({ path, mtime: statSync(path).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return sorted[0].path;
}

/**
 * Unconfigure VxAdmin (remove election data)
 */
export async function unconfigureAdmin(page: Page): Promise<void> {
  logger.debug('Unconfiguring VxAdmin');

  // Navigate to Election tab
  await page.getByRole('button', { name: 'Election', exact: true }).click();

  // Click Unconfigure Machine
  const unconfigureBtn = page.getByRole('button', { name: 'Unconfigure Machine' });

  if (await unconfigureBtn.isVisible()) {
    await unconfigureBtn.click();

    // Confirm
    const modal = page.getByRole('alertdialog');
    await modal.getByRole('button', { name: 'Delete All Election Data' }).click();

    await waitForText(page, 'Insert a USB', { timeout: 10000 });
  }
}
