/**
 * VxAdmin automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { dipSystemAdministratorCardAndLogin, logOut } from './auth-helpers.js';
import {
  navigateToApp,
  waitForTextInAppWithDebug,
  clickTextInAppWithDebug,
  waitForTextWithDebug,
  clickButtonWithDebug,
  toggleDevDock,
} from './browser.js';
import { basename, join } from 'node:path';
import type { StepCollector } from '../report/artifacts.js';
import { readdir, readFile, stat } from 'node:fs/promises';

/**
 * Run the VxAdmin configuration workflow
 */
export async function runAdminConfigureWorkflow(
  page: Page,
  electionPackagePath: string,
  outputDir: string,
  dataPath: string,
  stepCollector: StepCollector,
): Promise<void> {
  logger.step('Running VxAdmin workflow');

  await page.setViewportSize({
    width: 1920,
    height: 1200,
  });
  const usbController = createMockUsbController({ dataPath });

  // Navigate to app
  await navigateToApp(page);
  await toggleDevDock(page);
  await stepCollector.captureScreenshot('admin-locked', 'Initial locked screen');

  // Log in as system administrator
  await dipSystemAdministratorCardAndLogin(page, electionPackagePath, outputDir);
  await stepCollector.captureScreenshot('admin-unconfigured', 'Logged in, unconfigured');

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

  await stepCollector.captureScreenshot('admin-usb-detected', 'USB drive detected');

  // Wait for package to appear and click it (in main app, not dev-dock)
  await waitForTextInAppWithDebug(page, packageFilename, {
    timeout: 15000,
    outputDir,
    label: 'Waiting for election package to appear',
  });
  await clickTextInAppWithDebug(page, packageFilename, {
    timeout: 10000,
    outputDir,
    label: 'Clicking election package',
  });

  // Wait for election to load
  await page.waitForTimeout(3000);

  // After clicking the package, we should see election info
  // Wait for the election title or "Configured" text
  await waitForTextWithDebug(page, 'Configured', {
    timeout: 15000,
    outputDir,
    label: 'Waiting for election to be configured',
  });

  await stepCollector.captureScreenshot('admin-election-loaded', 'Election loaded');

  // Verify election is configured - look for the Election nav link
  await waitForTextWithDebug(page, 'Election', {
    timeout: 10000,
    outputDir,
    label: 'Looking for Election nav link',
  });
  await stepCollector.captureScreenshot('admin-configured', 'Election configured');

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
  await stepCollector.captureScreenshot('admin-package-saved', 'Election package saved');

  // Close the modal
  await page.getByRole('button', { name: 'Close' }).click();

  // Get the exported package path
  const exportedPackagePath = await getExportedPackagePath(usbController.getDataPath());

  await stepCollector.addOutput({
    type: 'election-package',
    label: 'Exported Election Package',
    description: 'Election package exported for VxScan',
    path: exportedPackagePath,
  });

  // Log out
  await logOut(page);
  await stepCollector.captureScreenshot('admin-logged-out', 'Logged out');

  // Remove USB
  await usbController.remove();
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
