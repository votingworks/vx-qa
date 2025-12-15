/**
 * VxScan automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { insertElectionManagerCardAndLogin, insertPollWorkerCardAndLogin as insertPollWorkerCard } from './auth-helpers.js';
import {
  toggleDevDock,
  debugPageState,
  clickButtonWithDebug,
  waitForTextInApp,
} from './browser.js';
import { createScreenshotManager, SCREENSHOT_STEPS, ScreenshotManager } from './screenshot.js';
import type { ScanResult, BallotPattern } from '../config/types.js';
import { copyFileSync } from 'fs';
import { basename, join } from 'path';
import { createMockScannerController } from '../mock-hardware/scanner.js';
import { generateMarkedBallotForPattern } from '../ballots/ballot-marker.js';
import { Election, ElectionPackage } from '../ballots/election-loader.js';
import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';

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
  repoPath: string,
  page: Page,
  screenshots: ScreenshotManager,
  electionPackage: ElectionPackage,
  electionPackagePath: string,
  electionPath: string,
  ballotsToScan: BallotToScan[],
  outputDir: string,
  dataPath: string,
): Promise<ScanWorkflowResult> {
  logger.step('Running VxScan workflow');
  const election = electionPackage.electionDefinition.election;

  await page.setViewportSize({
    width: 1920,
    height: 1080,
  });
  const usbController = createMockUsbController({ dataPath });
  const scannerController = createMockScannerController();
  const scanResults: ScanResult[] = [];

  // Navigate to app and wait for it to load
  // Force a hard reload to ensure we're loading VxScan, not cached VxAdmin
  await page.goto(`http://localhost:3000/`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Give the app time to initialize (apps use polling)
  await toggleDevDock(page);
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_LOCKED, 'Initial locked screen');

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  copyFileSync(electionPackagePath, join(usbController.getDataPath(), packageFilename));
  await usbController.insert();

  // Log in as election manager
  const electionManagerCard = await insertElectionManagerCardAndLogin(page, electionPath);
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_UNCONFIGURED, 'Logged in');

  await debugPageState(page, 'After election manager login', outputDir);

  await page.getByText("Select a precinct…").click({ force: true });
  await page.getByText("All Precincts", { exact: true }).click({ force: true });
  await page.getByText("Official Ballot Mode").click();

  await screenshots.capture(SCREENSHOT_STEPS.SCAN_CONFIGURED, 'Configured');
  await electionManagerCard.removeCard();

  // Open polls
  logger.debug('Opening polls');

  // Need poll worker to open polls - will be used when poll opening is implemented
  const pollWorkerCardForOpeningPolls = await insertPollWorkerCard(page, electionPath);

  await page.getByText('Do you want to open the polls?').isVisible();

  await debugPageState(page, 'Prompting to open the polls', outputDir);

  // Confirm opening polls
  await clickButtonWithDebug(page, 'Open Polls', {
    timeout: 10000,
    outputDir,
    label: 'Confirming Open Polls',
  });

  await waitForTextInApp(page, 'Polls Opened');
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_POLLS_OPEN, 'Polls opened');
  pollWorkerCardForOpeningPolls.removeCard();

  // Ready to scan
  await waitForTextInApp(page, 'Insert Your Ballot');
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_READY, 'Ready to scan');

  // Scan each ballot
  for (const ballot of ballotsToScan) {
    logger.debug(`Scanning ballot: ${ballot.ballotStyleId} - ${ballot.pattern}`);

    const result = await scanBallot(repoPath, election, page, scannerController, ballot, screenshots);
    if (result) {
      scanResults.push(result);
    }
  }

  // Close polls
  logger.debug('Closing polls');
  const pollWorkerCardForClosingPolls = await insertPollWorkerCard(page, electionPath);
  await waitForTextInApp(page, 'Do you want to close the polls?');

  await clickButtonWithDebug(page, 'Close Polls', {
    timeout: 10000,
    outputDir,
    label: 'Confirming Close Polls',
  });

  await waitForTextInApp(page, 'Polls Closed');

  // Clean up
  await pollWorkerCardForClosingPolls.removeCard();
  await usbController.remove();

  await waitForTextInApp(page, 'Voting is complete.');
  await screenshots.capture(SCREENSHOT_STEPS.SCAN_POLLS_CLOSED, 'Polls Closed');

  return {
    scanResults,
    screenshots: screenshots.getAll().map((s) => s.path),
  };
}

async function scanBallot(
  repoPath: string,
  election: Election,
  page: Page,
  scannerController: ReturnType<typeof createMockScannerController>,
  ballot: BallotToScan,
  screenshots: ReturnType<typeof createScreenshotManager>
): Promise<ScanResult | undefined> {
  const { ballotStyleId, pattern, pdfPath } = ballot;
  const markedBallotPdf = await generateMarkedBallotForPattern(repoPath, election, ballotStyleId, pattern, await readFile(pdfPath));

  if (!markedBallotPdf) {
    return undefined;
  }

  const hasher = createHash('sha256');
  hasher.update(ballotStyleId).update(pattern).end();
  const digest = hasher.digest('hex')
  const markedBallotPdfPath = ballot.pdfPath.replace(/\.pdf$/i, `-${digest}.pdf`);
  await writeFile(markedBallotPdfPath, markedBallotPdf.pdfBytes);

  // Insert ballot into scanner
  await waitForTextInApp(page, 'Insert Your Ballot');
  await page.waitForTimeout(1000);
  await scannerController.insertSheet(markedBallotPdfPath);

  // Wait for scan to process
  await waitForTextInApp(page, 'Please wait…');
  await page.getByText('Please wait…').waitFor({ state: 'hidden' });

  const message = page.getByRole('heading').and(page.locator(':not([data-testid="ballot-count"])'));
  await message.waitFor({ state: 'visible' });
  const messageText = await message.innerText();
  logger.info(`MESSAGE: ${messageText}`);

  // Check result
  const accepted = messageText === 'Your ballot was counted!';

  const screenshotName = `scan-${ballotStyleId}-${pattern}`;

  if (accepted) {
    await screenshots.capture(screenshotName, `Ballot accepted: ${ballotStyleId} ${pattern}`);

    return {
      input: ballot,
      accepted: true,
      screenshotPath: screenshots.getAll().slice(-1)[0]?.path,
    };
  } else {
    await screenshots.capture(screenshotName, `Ballot rejected: ${ballotStyleId} ${pattern}`);

    // Handle rejected ballot - return it
    await page.waitForTimeout(1000);
    const returnButton = page.getByRole('button', { name: 'Return Ballot' });
    if (await returnButton.isVisible()) {
      await returnButton.click();

      // Wait until we're told to remove the ballot.
      await waitForTextInApp(page, 'Remove Your Ballot');
    }

    await page.waitForTimeout(1500);
    await scannerController.removeSheet();

    return {
      input: ballot,
      accepted: false,
      reason: pattern === 'overvote' ? 'overvote' : 'rejected',
      screenshotPath: screenshots.getAll().slice(-1)[0]?.path,
    };
  }
}

/**
 * Export CVRs from VxScan
 */
export async function exportCVRs(_page: Page): Promise<void> {
  logger.debug('Exporting CVRs');

  // This would navigate to the CVR export section and save to USB
  // Implementation depends on the specific VxScan UI
}
