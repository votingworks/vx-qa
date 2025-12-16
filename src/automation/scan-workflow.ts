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
import type { StepCollector, ArtifactCollector } from '../report/artifacts.js';
import { copyFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { createMockScannerController } from '../mock-hardware/scanner.js';
import { generateMarkedBallotForPattern } from '../ballots/ballot-marker.js';
import { Election, ElectionPackage } from '../ballots/election-loader.js';
import { readFile, writeFile } from 'fs/promises';

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
  votes?: Record<string, string[]>; // VotesDict - contestId -> array of candidate/option IDs
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
  openingPollsStep?: StepCollector,
  collector?: ArtifactCollector,
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
    const files = readdirSync(printsDir);
    files.forEach(f => existingPrinterFiles.add(f));
  } catch {
    // Directory might not exist yet
  }

  // Navigate to app and wait for it to load
  // Force a hard reload to ensure we're loading VxScan, not cached VxAdmin
  await page.goto(`http://localhost:3000/`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Give the app time to initialize (apps use polling)
  await toggleDevDock(page);
  const s1 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_LOCKED, 'Initial locked screen');
  openingPollsStep?.addScreenshot(s1);

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  copyFileSync(electionPackagePath, join(usbController.getDataPath(), packageFilename));
  await usbController.insert();

  // Log in as election manager
  const electionManagerCard = await insertElectionManagerCardAndLogin(page, electionPath);
  const s2 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_UNCONFIGURED, 'Logged in');
  openingPollsStep?.addScreenshot(s2);

  await debugPageState(page, 'After election manager login', outputDir);

  await page.getByText("Select a precinct…").click({ force: true });
  await page.getByText("All Precincts", { exact: true }).click({ force: true });
  await page.getByText("Official Ballot Mode").click();

  const s3 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_CONFIGURED, 'Configured');
  openingPollsStep?.addScreenshot(s3);
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
  const s4 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_POLLS_OPEN, 'Polls opened');
  openingPollsStep?.addScreenshot(s4);
  pollWorkerCardForOpeningPolls.removeCard();

  // Add thermal printer reports from opening polls
  if (openingPollsStep) {
    addThermalPrinterReports(printerWorkspace, openingPollsStep, existingPrinterFiles);
  }

  // Ready to scan
  await waitForTextInApp(page, 'Insert Your Ballot');
  const s5 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_READY, 'Ready to scan');
  openingPollsStep?.addScreenshot(s5);

  // Mark opening polls step as complete
  openingPollsStep?.complete();

  // Scan each ballot
  for (const [index, ballot] of ballotsToScan.entries()) {
    logger.debug(`Scanning ballot: ${ballot.ballotStyleId} - ${ballot.pattern}`);

    // Create step for this ballot right before scanning
    const ballotStep = collector?.startStep(
      `scan-ballot-${index + 1}`,
      `Scan Ballot ${index + 1}: ${ballot.ballotStyleId} - ${ballot.pattern} (${ballot.ballotMode})`,
      `Scan ${ballot.pattern} ballot for ballot style ${ballot.ballotStyleId} in ${ballot.ballotMode} mode`
    );

    const result = await scanBallot(repoPath, election, page, scannerController, ballot, screenshots, ballotStep);
    if (result) {
      scanResults.push(result);
    }

    // Mark ballot step as complete
    ballotStep?.complete();
  }

  // Close polls
  logger.debug('Closing polls');

  // Create step for closing polls
  const closingPollsStep = collector?.startStep(
    'closing-polls',
    'Closing Polls',
    'Close the polls and print results reports'
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
  const s6 = await screenshots.capture(SCREENSHOT_STEPS.SCAN_POLLS_CLOSED, 'Polls Closed');
  closingPollsStep?.addScreenshot(s6);

  // Add thermal printer reports from closing polls
  if (closingPollsStep) {
    addThermalPrinterReports(printerWorkspace, closingPollsStep, existingPrinterFiles);
  }

  // Mark closing polls step as complete
  closingPollsStep?.complete();

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
  screenshots: ReturnType<typeof createScreenshotManager>,
  stepCollector?: StepCollector
): Promise<ScanResult | undefined> {
  const { ballotStyleId, pattern, pdfPath } = ballot;
  const markedBallotPdf = await generateMarkedBallotForPattern(repoPath, election, ballotStyleId, pattern, await readFile(pdfPath));

  if (!markedBallotPdf) {
    return undefined;
  }

  // Create descriptive filename: ballot-styleId-mode-pattern.pdf
  const markedBallotPdfPath = ballot.pdfPath.replace(/\.pdf$/i, `-${ballot.ballotMode}-${pattern}.pdf`);
  await writeFile(markedBallotPdfPath, markedBallotPdf.pdfBytes);

  // Add the marked ballot PDF as input to the step
  stepCollector?.addInput({
    type: 'ballot',
    label: 'Marked Ballot',
    description: `${ballotStyleId} - ${pattern}`,
    path: markedBallotPdfPath,
  });

  // Split PDF into sheets (pairs of pages: front and back)
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(markedBallotPdf.pdfBytes);
  const pageCount = pdfDoc.getPageCount();

  // Sheets are pairs of pages (front/back)
  const sheetCount = Math.ceil(pageCount / 2);
  logger.debug(`Ballot has ${pageCount} page(s), ${sheetCount} sheet(s)`);

  // Scan each sheet (2 pages at a time)
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const frontPageIndex = sheetIndex * 2;
    const backPageIndex = frontPageIndex + 1;

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

    // Insert sheet into scanner
    await waitForTextInApp(page, 'Insert Your Ballot');
    await page.waitForTimeout(1000);
    await scannerController.insertSheet(sheetPdfPath);

    // Wait for scan to process
    await waitForTextInApp(page, 'Please wait…');
    await page.getByText('Please wait…').waitFor({ state: 'hidden' });

    logger.debug(`Scanned sheet ${sheetIndex + 1}/${sheetCount}`);
    
    // After each sheet, check if ballot was rejected
    const message = page.getByRole('heading').and(page.locator(':not([data-testid="ballot-count"])'));
    await message.waitFor({ state: 'visible', timeout: 5000 });
    const messageText = await message.innerText();
    logger.debug(`Message after sheet ${sheetIndex + 1}: ${messageText}`);
    
    // If rejected, handle immediately and stop scanning more sheets
    if (messageText !== 'Your ballot was counted!' && messageText.toLowerCase().includes('ballot')) {
      logger.info(`Ballot rejected after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}`);
      
      // Handle rejected ballot - return it
      await page.waitForTimeout(1000);
      const returnButton = page.getByRole('button', { name: 'Return Ballot' });
      if (await returnButton.isVisible()) {
        await returnButton.click();
        await waitForTextInApp(page, 'Remove Your Ballot');
      }
      
      await page.waitForTimeout(1500);
      await scannerController.removeSheet();
      
      // Create rejection result and return immediately
      const screenshot = await screenshots.capture(`scan-${ballotStyleId}-${pattern}`, `Ballot rejected: ${ballotStyleId} ${pattern}`);
      stepCollector?.addScreenshot(screenshot);
      
      const result: ScanResult = {
        input: ballot,
        accepted: false,
        reason: pattern === 'overvote' ? 'overvote' : 'rejected',
        screenshotPath: screenshot.path,
      };
      
      stepCollector?.addOutput({
        type: 'scan-result',
        label: 'Scan Result',
        description: 'Ballot rejected',
        data: {
          accepted: result.accepted,
          expected: ballot.expectedAccepted,
          isExpected: result.accepted === ballot.expectedAccepted,
        },
      });
      
      return result;
    }
  }

  // If we got here, all sheets were scanned and ballot was accepted
  const message = page.getByRole('heading').and(page.locator(':not([data-testid="ballot-count"])'));
  const messageText = await message.innerText();
  logger.info(`MESSAGE: ${messageText}`);
  
  const screenshot = await screenshots.capture(`scan-${ballotStyleId}-${pattern}`, `Ballot accepted: ${ballotStyleId} ${pattern}`);
  stepCollector?.addScreenshot(screenshot);

  const result: ScanResult = {
    input: ballot,
    accepted: true,
    screenshotPath: screenshot.path,
  };

  // Convert votes to IDs for validation (handles both Candidate objects and string IDs)
  const votesAsIds: Record<string, string[]> = {};
  if (markedBallotPdf.votes) {
    for (const [contestId, votes] of Object.entries(markedBallotPdf.votes)) {
      votesAsIds[contestId] = votes.map(vote =>
        typeof vote === 'string' ? vote : (vote as any).id
      );
    }
  }

  logger.debug(`Votes as IDs for ${ballotStyleId} ${pattern}: ${JSON.stringify(votesAsIds)}`);

  stepCollector?.addOutput({
    type: 'scan-result',
    label: 'Scan Result',
    description: 'Ballot accepted',
    data: {
      accepted: result.accepted,
      expected: ballot.expectedAccepted,
      isExpected: result.accepted === ballot.expectedAccepted,
      screenshotPath: result.screenshotPath,
      votes: votesAsIds, // Store votes as IDs for validation
      ballotStyleId,
      pattern,
      ballotId: `${ballotStyleId}-${pattern}-${ballot.ballotMode}-${ballot.pdfPath}`, // Unique ID for this ballot (includes path to differentiate precinct/absentee)
    },
  });

  return result;
}

/**
 * Add thermal printer reports from a workspace directory to a step
 */
function addThermalPrinterReports(
  workspaceDir: string,
  stepCollector: StepCollector,
  existingFiles: Set<string>
): void {
  try {
    // The prints are in a 'prints' subdirectory
    const printsDir = join(workspaceDir, 'prints');
    const files = readdirSync(printsDir);

    for (const file of files) {
      // Only add new files that weren't there before this step
      if (file.endsWith('.pdf') && !existingFiles.has(file)) {
        const filePath = join(printsDir, file);
        const stats = statSync(filePath);

        // Store a relative path that will work after workspaces are copied to output
        // The workspace is copied to output/workspaces/fujitsu-thermal-printer/
        const relativePath = join('workspaces', 'fujitsu-thermal-printer', 'prints', file);

        stepCollector.addOutput({
          type: 'print',
          label: 'Thermal Printer Report',
          description: file,
          path: relativePath,
          data: { size: stats.size, mtime: stats.mtime },
        });

        // Add to existing files so it won't be added again in subsequent steps
        existingFiles.add(file);
      }
    }
  } catch (error) {
    logger.warn(`Failed to add thermal printer reports: ${error}`);
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
