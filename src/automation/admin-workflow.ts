/**
 * VxAdmin automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { dipSystemAdministratorCardAndLogin, logOut } from './auth-helpers.js';
import {
  navigateToApp,
  waitForTextInApp,
  clickTextInApp,
  waitForTextWithDebug,
  clickButtonWithDebug,
  toggleDevDock,
} from './browser.js';
import { ScreenshotManager } from './screenshot.js';
import { basename, join } from 'node:path';
import type { StepCollector } from '../report/artifacts.js';
import { readdir, readFile, stat } from 'node:fs/promises';

export interface AdminWorkflowResult {
  exportedPackagePath: string;
  screenshots: string[];
}

/**
 * Run the VxAdmin configuration workflow
 */
export async function runAdminWorkflow(
  page: Page,
  screenshots: ScreenshotManager,
  electionPackagePath: string,
  outputDir: string,
  dataPath: string,
  stepCollector: StepCollector,
): Promise<AdminWorkflowResult> {
  logger.step('Running VxAdmin workflow');

  await page.setViewportSize({
    width: 1920,
    height: 1200,
  });
  const usbController = createMockUsbController({ dataPath });

  // Navigate to app
  await navigateToApp(page);
  await toggleDevDock(page);
  const s1 = await screenshots.capture('admin-locked', 'Initial locked screen');
  stepCollector.addScreenshot(s1);

  // Log in as system administrator
  await dipSystemAdministratorCardAndLogin(page, electionPackagePath);
  const s2 = await screenshots.capture('admin-unconfigured', 'Logged in, unconfigured');
  stepCollector.addScreenshot(s2);

  // Need to load election from USB
  logger.debug('Loading election from USB');

  // Ensure USB is removed first, then copy file, then insert
  await usbController.remove();
  await page.waitForTimeout(500);

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  const packageData = await readFile(electionPackagePath);
  logger.debug(`Copying election package to USB: ${packageFilename} (${packageData.length} bytes)`);
  await usbController.writeFile(packageFilename, packageData);

  // Insert USB drive (this should trigger a re-scan)
  logger.debug('Inserting USB drive');
  await usbController.insert();
  await page.waitForTimeout(2000); // Give more time for USB detection

  const s3 = await screenshots.capture('admin-usb-detected', 'USB drive detected');
  stepCollector.addScreenshot(s3);

  // Wait for package to appear and click it (in main app, not dev-dock)
  await waitForTextInApp(page, packageFilename, { timeout: 15000 });
  await clickTextInApp(page, packageFilename);

  // Wait for election to load
  await page.waitForTimeout(3000);

  // After clicking the package, we should see election info
  // Wait for the election title or "Configured" text
  await waitForTextWithDebug(page, 'Configured', {
    timeout: 15000,
    outputDir,
    label: 'Waiting for election to be configured',
  });

  const s4 = await screenshots.capture('admin-election-loaded', 'Election loaded');
  stepCollector.addScreenshot(s4);

  // Verify election is configured - look for the Election nav link
  await waitForTextWithDebug(page, 'Election', {
    timeout: 10000,
    outputDir,
    label: 'Looking for Election nav link',
  });
  const s5 = await screenshots.capture('admin-configured', 'Election configured');
  stepCollector.addScreenshot(s5);

  // Export election package for VxScan
  logger.debug('Exporting election package');

  // Ensure USB is inserted before exporting
  logger.debug('Ensuring USB is inserted for export');
  const usbStatus = await usbController.getStatus();
  if (usbStatus === 'removed') {
    await usbController.insert();
    await page.waitForTimeout(1000); // Wait for USB to be detected
  }

  // Click Save Election Package button
  await clickButtonWithDebug(page, 'Save Election Package', {
    timeout: 10000,
    outputDir,
    label: 'Clicking Save Election Package button',
  });
  await page.waitForTimeout(500);

  // Confirm export - click the Save button in the modal
  await clickButtonWithDebug(page, 'Save', {
    timeout: 10000,
    outputDir,
    label: 'Clicking Save button in modal',
  });

  // Wait for success message
  await waitForTextWithDebug(page, 'Election Package Saved', {
    timeout: 30000,
    outputDir,
    label: 'Waiting for Election Package Saved message',
  });
  const s7 = await screenshots.capture('admin-package-saved', 'Election package saved');
  stepCollector.addScreenshot(s7);

  // Close the modal
  await page.getByRole('button', { name: 'Close' }).click();

  // Get the exported package path
  const exportedPackagePath = await getExportedPackagePath(usbController.getDataPath());

  // Log out
  await logOut(page);
  const s8 = await screenshots.capture('admin-logged-out', 'Logged out');
  stepCollector.addScreenshot(s8);

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
  // Look for ZIP files in the USB data directory
  const findZipFiles = async (dir: string): Promise<string[]> => {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          results.push(...(await findZipFiles(fullPath)));
        } else if (entry.name.endsWith('.zip')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }

    return results;
  };

  const zipFiles = await findZipFiles(usbDataPath);

  if (zipFiles.length === 0) {
    throw new Error('No election package found on USB drive');
  }

  // Return the most recently modified ZIP file
  const sorted = (
    await Promise.all(zipFiles.map(async (path) => ({ path, mtime: (await stat(path)).mtime })))
  ).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return sorted[0].path;
}
