/**
 * VxScan automation workflow
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import {
  insertElectionManagerCardAndLogin,
  insertPollWorkerCardAndLogin as insertPollWorkerCard,
} from './auth-helpers.js';
import {
  toggleDevDock,
  debugPageState,
  clickButtonWithDebug,
  waitForTextInApp,
} from './browser.js';
import { createScreenshotManager, ScreenshotManager } from './screenshot.js';
import type { ScanResult, BallotPattern } from '../config/types.js';
import type { StepCollector, ArtifactCollector } from '../report/artifacts.js';
import { basename, join } from 'path';
import { createMockScannerController } from '../mock-hardware/scanner.js';
import { generateMarkedBallotForPattern } from '../ballots/ballot-marker.js';
import { Election, ElectionPackage } from '../ballots/election-loader.js';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { VotesDict } from '../ballots/vote-generator.js';
import { PDFDocument } from 'pdf-lib';

export interface ScanWorkflowResult {
  scanResults: ScanResult[];
  screenshots: string[];
}

export interface BallotToScan {
  ballotStyleId: string;
  ballotMode: string;
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
  openingPollsStep: StepCollector,
  collector: ArtifactCollector,
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

  // Track existing thermal printer files to avoid duplicates
  const printerWorkspace = join(repoPath, 'libs/fujitsu-thermal-printer/dev-workspace');
  const existingPrinterFiles = new Set<string>();
  try {
    const printsDir = join(printerWorkspace, 'prints');
    const files = await readdir(printsDir);
    files.forEach((f) => existingPrinterFiles.add(f));
  } catch {
    // Directory might not exist yet
  }

  // Navigate to app and wait for it to load
  // Force a hard reload to ensure we're loading VxScan, not cached VxAdmin
  await page.goto(`http://localhost:3000/`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Give the app time to initialize (apps use polling)
  await toggleDevDock(page);
  const s1 = await screenshots.capture('scan-locked', 'Initial locked screen');
  openingPollsStep.addScreenshot(s1);

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  await copyFile(electionPackagePath, join(usbController.getDataPath(), packageFilename));
  await usbController.insert();

  // Log in as election manager
  const electionManagerCard = await insertElectionManagerCardAndLogin(page, electionPath);
  const s2 = await screenshots.capture('scan-unconfigured', 'Logged in');
  openingPollsStep.addScreenshot(s2);

  await debugPageState(page, 'After election manager login', outputDir);

  await page.getByText('Select a precinct…').click({ force: true });
  await page.getByText('All Precincts', { exact: true }).click({ force: true });
  await page.getByText('Official Ballot Mode').click();

  const s3 = await screenshots.capture('scan-configured', 'Configured');
  openingPollsStep.addScreenshot(s3);
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
  const s4 = await screenshots.capture('scan-polls-open', 'Polls opened');
  openingPollsStep.addScreenshot(s4);
  await pollWorkerCardForOpeningPolls.removeCard();

  // Add thermal printer reports from opening polls
  await addThermalPrinterReports(printerWorkspace, openingPollsStep, existingPrinterFiles);

  // Ready to scan
  await waitForTextInApp(page, 'Insert Your Ballot');
  const s5 = await screenshots.capture('scan-ready', 'Ready to scan');
  openingPollsStep.addScreenshot(s5);

  // Mark opening polls step as complete
  openingPollsStep.complete();

  // Scan each ballot
  for (const [index, ballot] of ballotsToScan.entries()) {
    logger.debug(`Scanning ballot: ${ballot.ballotStyleId} - ${ballot.pattern}`);

    // Create step for this ballot right before scanning
    const ballotStep = collector.startStep(
      `scan-ballot-${index + 1}`,
      `Scan Ballot ${index + 1}: ${ballot.ballotStyleId} - ${ballot.pattern} (${ballot.ballotMode})`,
      `Scan ${ballot.pattern} ballot for ballot style ${ballot.ballotStyleId} in ${ballot.ballotMode} mode`,
    );

    const results = await scanBallot(
      repoPath,
      election,
      page,
      scannerController,
      ballot,
      screenshots,
      ballotStep,
    );
    scanResults.push(...results);

    // Mark ballot step as complete
    ballotStep?.complete();
  }

  // Close polls
  logger.debug('Closing polls');

  // Create step for closing polls
  const closingPollsStep = collector.startStep(
    'closing-polls',
    'Closing Polls',
    'Close the polls and print results reports',
  );

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
  const s6 = await screenshots.capture('scan-polls-closed', 'Polls Closed');
  closingPollsStep.addScreenshot(s6);

  // Add thermal printer reports from closing polls
  await addThermalPrinterReports(printerWorkspace, closingPollsStep, existingPrinterFiles);

  // Mark closing polls step as complete
  closingPollsStep.complete();

  return {
    scanResults,
    screenshots: screenshots.getAll().map((s) => s.path),
  };
}

function votesWithOnlyIds(votes: VotesDict): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(votes).map(([contestId, votes]) => [
      contestId,
      votes.map((vote) => (typeof vote === 'string' ? vote : vote.id)),
    ]),
  );
}

async function scanBallot(
  repoPath: string,
  election: Election,
  page: Page,
  scannerController: ReturnType<typeof createMockScannerController>,
  ballot: BallotToScan,
  screenshots: ReturnType<typeof createScreenshotManager>,
  stepCollector: StepCollector,
): Promise<ScanResult[]> {
  const { ballotStyleId, pattern: markPattern, pdfPath } = ballot;
  const markedBallotPdf = await generateMarkedBallotForPattern(
    repoPath,
    election,
    ballotStyleId,
    markPattern,
    await readFile(pdfPath),
  );

  if (!markedBallotPdf) {
    return [];
  }

  const gridLayout = election.gridLayouts?.find((layout) => layout.ballotStyleId === ballotStyleId);

  if (!gridLayout) {
    throw new Error(`No grid layout found for ballot style: ${ballotStyleId}`);
  }

  // Create descriptive filename: ballot-styleId-mode-pattern.pdf
  const markedBallotPdfPath = ballot.pdfPath.replace(
    /\.pdf$/i,
    `-${ballot.ballotMode}-${markPattern}.pdf`,
  );
  await writeFile(markedBallotPdfPath, markedBallotPdf.pdfBytes);

  // Split PDF into sheets (pairs of pages: front and back)
  const pdfDoc = await PDFDocument.load(markedBallotPdf.pdfBytes);
  const pageCount = pdfDoc.getPageCount();

  // Sheets are pairs of pages (front/back)
  const sheetCount = Math.ceil(pageCount / 2);
  logger.debug(`Ballot has ${pageCount} page(s), ${sheetCount} sheet(s)`);

  const results: ScanResult[] = [];

  // Scan each sheet (2 pages at a time)
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const frontPageIndex = sheetIndex * 2;
    const backPageIndex = frontPageIndex + 1;

    const votesForSheet: VotesDict = Object.fromEntries(
      Object.entries(markedBallotPdf.votes)
        .map(([contestId, votes]) => [
          contestId,
          votes.filter((vote) => {
            const optionId = typeof vote === 'string' ? vote : vote.id;
            return gridLayout.gridPositions.some(
              (p) =>
                p.sheetNumber === sheetIndex + 1 &&
                p.contestId === contestId &&
                p.type === 'option' &&
                p.optionId === optionId,
            );
          }),
        ])
        .filter(([, votes]) => votes.length > 0),
    );

    // Convert votes to IDs for validation (handles both Candidate objects and string IDs)
    const votesAsIds = votesWithOnlyIds(votesForSheet);

    logger.debug(
      `Votes for ${ballotStyleId} ${markPattern} sheet #${sheetIndex + 1}: ${JSON.stringify(votesAsIds)}`,
    );

    // Create a new PDF with this sheet (front and back pages)
    const sheetDoc = await PDFDocument.create();

    // Copy front page
    const [frontPage] = await sheetDoc.copyPages(pdfDoc, [frontPageIndex]);
    sheetDoc.addPage(frontPage);

    // Copy back page if it exists
    if (backPageIndex < pageCount) {
      const [backPage] = await sheetDoc.copyPages(pdfDoc, [backPageIndex]);
      sheetDoc.addPage(backPage);
    }

    const sheetPdfBytes = await sheetDoc.save();

    // Write the sheet PDF
    const sheetPdfPath = markedBallotPdfPath.replace(/\.pdf$/i, `-sheet${sheetIndex + 1}.pdf`);
    await writeFile(sheetPdfPath, sheetPdfBytes);

    stepCollector.addInput({
      type: 'ballot',
      label: `Marked Ballot Sheet (${sheetIndex + 1} of ${sheetCount})`,
      description: `${ballotStyleId} - ${markPattern}`,
      path: sheetPdfPath,
    });

    // Insert sheet into scanner
    await waitForTextInApp(page, 'Insert Your Ballot');
    await page.waitForTimeout(1000);
    await scannerController.insertSheet(sheetPdfPath);

    // Wait for scan to process
    await waitForTextInApp(page, 'Please wait…');
    await page.getByText('Please wait…').waitFor({ state: 'hidden' });

    logger.debug(`Scanned sheet ${sheetIndex + 1}/${sheetCount}`);

    // After each sheet, check if ballot was rejected
    const message = page
      .getByRole('heading')
      .and(page.locator(':not([data-testid="ballot-count"])'));
    await message.waitFor({ state: 'visible', timeout: 5000 });
    const messageText = await message.innerText();
    logger.debug(`Message after sheet ${sheetIndex + 1}: ${messageText}`);

    // If rejected, handle immediately and stop scanning more sheets
    if (
      messageText !== 'Your ballot was counted!' &&
      messageText.toLowerCase().includes('ballot')
    ) {
      logger.info(`Ballot rejected after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}`);

      const screenshot = await screenshots.capture(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot rejected: ${ballotStyleId} ${markPattern}`,
      );
      stepCollector.addScreenshot(screenshot);

      // Handle rejected ballot - return it
      await page.waitForTimeout(1000);
      const returnButton = page.getByRole('button', { name: 'Return Ballot' });
      if (await returnButton.isVisible()) {
        await returnButton.click();
        await waitForTextInApp(page, 'Remove Your Ballot');
      }

      await page.waitForTimeout(1500);
      await scannerController.removeSheet();

      const result: ScanResult = {
        input: ballot,
        accepted: false,
        reason: markPattern === 'overvote' ? 'overvote' : 'rejected',
        screenshotPath: screenshot.path,
      };

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot rejected',
        accepted: result.accepted,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        markPattern,
        votes: votesForSheet,
      });

      results.push(result);
    } else {
      const screenshot = await screenshots.capture(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot accepted: ${ballotStyleId} ${markPattern} (${sheetIndex + 1}/${sheetCount})`,
      );
      stepCollector.addScreenshot(screenshot);

      const result: ScanResult = {
        input: ballot,
        accepted: true,
        screenshotPath: screenshot.path,
      };

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot accepted',
        accepted: result.accepted,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        markPattern,
        votes: votesForSheet,
      });

      results.push(result);
    }
  }

  return results;
}

/**
 * Add thermal printer reports from a workspace directory to a step
 */
async function addThermalPrinterReports(
  workspaceDir: string,
  stepCollector: StepCollector,
  existingFiles: Set<string>,
): Promise<void> {
  try {
    // The prints are in a 'prints' subdirectory
    const printsDir = join(workspaceDir, 'prints');
    const files = await readdir(printsDir);

    for (const file of files) {
      // Only add new files that weren't there before this step
      if (file.endsWith('.pdf') && !existingFiles.has(file)) {
        // Store a relative path that will work after workspaces are copied to output
        // The workspace is copied to output/workspaces/fujitsu-thermal-printer/
        const relativePath = join('workspaces', 'fujitsu-thermal-printer', 'prints', file);

        await stepCollector.addOutput({
          type: 'print',
          label: 'Thermal Printer Report',
          description: file,
          path: relativePath,
        });

        // Add to existing files so it won't be added again in subsequent steps
        existingFiles.add(file);
      }
    }
  } catch (error) {
    logger.warn(`Failed to add thermal printer reports: ${(error as Error).message}`);
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
