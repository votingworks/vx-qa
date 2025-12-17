/**
 * VxScan automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { createMockScannerController } from '../mock-hardware/scanner.js';
import { logInAsElectionManager, logInAsPollWorker } from './auth-helpers.js';
import { navigateToApp, waitForText, clickButton, isTextVisible } from './browser.js';
import { createScreenshotManager, SCREENSHOT_STEPS } from './screenshot.js';
import type { ScanResult, BallotPattern } from '../config/types.js';
import { copyFileSync } from 'fs';
import { basename, join } from 'path';

export interface ScanWorkflowResult {
  scanResults: ScanResult[];
  screenshots: string[];
}

export interface BallotToScan {
  ballotStyleId: string;
  pattern: BallotPattern;
  pdfPath: string;
  expectedAccepted: boolean;
}

/**
 * Run the VxScan workflow
 */
export async function runScanWorkflow(
  page: Page,
  electionPackagePath: string,
  electionPath: string,
  ballotsToScan: BallotToScan[],
  outputDir: string
): Promise<ScanWorkflowResult> {
  logger.step('Running VxScan workflow');

  const screenshots = createScreenshotManager(page, outputDir);
  const usbController = createMockUsbController();
  const scannerController = createMockScannerController();
  const scanResults: ScanResult[] = [];

  // Navigate to app
  await navigateToApp(page);
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_LOCKED, 'Initial locked screen');

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  copyFileSync(electionPackagePath, join(usbController.getDataPath(), packageFilename));
  await usbController.insert();

  // Log in as election manager
  await logInAsElectionManager(page, electionPath);
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_UNCONFIGURED, 'Logged in');

  // Wait for election package detection and configure
  const needsConfig = await isTextVisible(page, 'No election');

  if (needsConfig) {
    logger.debug('Configuring VxScan with election package');

    await waitForText(page, packageFilename, { timeout: 10000 });
    await page.getByText(packageFilename).click();

    await page.waitForTimeout(2000);
  }

  await screenshots.capture(SCREENSHOT_STEPS.SCAN_CONFIGURED, 'Configured');

  // Check polls status
  const pollsOpen = await isTextVisible(page, 'Polls are open');

  if (!pollsOpen) {
    // Open polls
    logger.debug('Opening polls');

    // Need poll worker to open polls
    await page.getByRole('button', { name: 'Lock Machine' }).click();

    await logInAsPollWorker(page, electionPath);

    await clickButton(page, 'Open Polls');

    // Confirm opening polls
    if (await isTextVisible(page, 'Open Polls')) {
      await clickButton(page, 'Open Polls for All Precincts');
    }

    await page.waitForTimeout(1000);
    await screenshots.capture(SCREENSHOT_STEPS.SCAN_POLLS_OPEN, 'Polls opened');
  }

  // Ready to scan
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_READY, 'Ready to scan');

  // Scan each ballot
  for (const ballot of ballotsToScan) {
    logger.debug(`Scanning ballot: ${ballot.ballotStyleId} - ${ballot.pattern}`);

    const result = await scanBallot(page, scannerController, ballot, screenshots);
    scanResults.push(result);
  }

  // Close polls
  logger.debug('Closing polls');
  await clickButton(page, 'Close Polls');

  if (await isTextVisible(page, 'Close Polls')) {
    await clickButton(page, 'Close Polls for All Precincts');
  }

  await page.waitForTimeout(1000);
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_RESULTS, 'Final results');

  // Remove USB
  await usbController.remove();

  return {
    scanResults,
    screenshots: screenshots.getAll().map((s) => s.path),
  };
}

/**
 * Scan a single ballot
 */
async function scanBallot(
  page: Page,
  scannerController: ReturnType<typeof createMockScannerController>,
  ballot: BallotToScan,
  screenshots: ReturnType<typeof createScreenshotManager>
): Promise<ScanResult> {
  const { ballotStyleId, pattern, pdfPath } = ballot;

  // Insert ballot into scanner
  await scannerController.insertSheet(pdfPath);

  // Wait for scan to process
  await page.waitForTimeout(2000);

  // Check result
  const accepted = await isTextVisible(page, 'Ballot Counted');
  const rejected = await isTextVisible(page, 'Ballot Not Counted') ||
                   await isTextVisible(page, 'overvote') ||
                   await isTextVisible(page, 'Review Your Ballot');

  const screenshotName = `scan-${ballotStyleId}-${pattern}`;

  if (accepted) {
    await screenshots.capture(screenshotName, `Ballot accepted: ${ballotStyleId} ${pattern}`);

    // Wait for the scanner to be ready for next ballot
    await page.waitForTimeout(1000);

    return {
      ballotStyleId,
      pattern,
      accepted: true,
      screenshotPath: screenshots.getAll().slice(-1)[0]?.path,
    };
  }

  if (rejected) {
    await screenshots.capture(screenshotName, `Ballot rejected: ${ballotStyleId} ${pattern}`);

    // Handle rejected ballot - return it
    const returnButton = page.getByRole('button', { name: /Return|Reject/i });
    if (await returnButton.isVisible()) {
      await returnButton.click();
    }

    // Remove the sheet from the scanner
    await scannerController.removeSheet();
    await page.waitForTimeout(500);

    return {
      ballotStyleId,
      pattern,
      accepted: false,
      reason: pattern === 'overvote' ? 'overvote' : 'rejected',
      screenshotPath: screenshots.getAll().slice(-1)[0]?.path,
    };
  }

  // Unknown state
  await screenshots.capture(screenshotName, `Unknown scan result: ${ballotStyleId} ${pattern}`);

  // Try to remove the sheet
  await scannerController.removeSheet();

  return {
    ballotStyleId,
    pattern,
    accepted: false,
    reason: 'unknown',
    screenshotPath: screenshots.getAll().slice(-1)[0]?.path,
  };
}

/**
 * Export CVRs from VxScan
 */
export async function exportCVRs(page: Page): Promise<void> {
  logger.debug('Exporting CVRs');

  // This would navigate to the CVR export section and save to USB
  // Implementation depends on the specific VxScan UI
}
