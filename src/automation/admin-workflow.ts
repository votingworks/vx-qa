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
  debugPageState,
  waitForTextWithDebug,
  clickButtonWithDebug,
  toggleDevDock,
} from './browser.js';
import { SCREENSHOT_STEPS, ScreenshotManager } from './screenshot.js';
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
  screenshots: ScreenshotManager,
  electionPackagePath: string,
  outputDir: string,
  dataPath: string,
  backendPort = 3004
): Promise<AdminWorkflowResult> {
  logger.step('Running VxAdmin workflow');

  const usbController = createMockUsbController({ dataPath, port: backendPort });

  // Navigate to app
  await navigateToApp(page);
  await toggleDevDock(page);
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_LOCKED, 'Initial locked screen');

  // Log in as system administrator
  await dipSystemAdministratorCardAndLogin(page, electionPackagePath);
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_UNCONFIGURED, 'Logged in, unconfigured');

  // Need to load election from USB
  logger.debug('Loading election from USB');

  // Ensure USB is removed first, then copy file, then insert
  await usbController.remove();
  await page.waitForTimeout(500);

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  const packageData = readFileSync(electionPackagePath);
  logger.debug(`Copying election package to USB: ${packageFilename} (${packageData.length} bytes)`);
  await usbController.writeFile(packageFilename, packageData);

  // Insert USB drive (this should trigger a re-scan)
  logger.debug('Inserting USB drive');
  await usbController.insert();
  await page.waitForTimeout(2000); // Give more time for USB detection

  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_USB_DETECTED, 'USB drive detected');

  // Debug: show what we're looking for
  logger.debug(`Looking for package filename in app: ${packageFilename}`);
  await debugPageState(page, 'After USB insert, looking for package', outputDir);

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

  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_ELECTION_LOADED, 'Election loaded');

  // Debug: dump page state after login/config
  await debugPageState(page, 'After login/config', outputDir);

  // Verify election is configured - look for the Election nav link
  await waitForTextWithDebug(page, 'Election', {
    timeout: 10000,
    outputDir,
    label: 'Looking for Election nav link',
  });
  await screenshots.capture(SCREENSHOT_STEPS.ADMIN_CONFIGURED, 'Election configured');

  // Debug: dump page state after navigating to Election screen
  await debugPageState(page, 'On Election screen', outputDir);

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
  await screenshots.captureModal(SCREENSHOT_STEPS.ADMIN_EXPORT_PACKAGE, 'Export dialog');

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
  await screenshots.capture('admin-package-saved', 'Election package saved');

  // Close the modal
  await page.getByRole('button', { name: 'Close' }).click();

  // Get the exported package path
  const exportedPackagePath = await getExportedPackagePath(usbController.getDataPath());

  // Log out
  await logOut(page, outputDir);
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

    await waitForTextWithDebug(page, 'Insert a USB', { timeout: 10000 });
  }
}
