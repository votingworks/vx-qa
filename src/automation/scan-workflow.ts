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
  clickButtonWithDebug,
  waitForTextInApp,
  waitForTextInAppWithDebug,
} from './browser.js';
import type { BallotPattern, PrecinctSelection } from '../config/types.js';
import type { StepCollector, ArtifactCollector } from '../report/artifacts.js';
import { basename, join } from 'node:path';
import { createMockScannerController } from '../mock-hardware/scanner.js';
import { generateMarkedBallotForPattern } from '../ballots/ballot-marker.js';
import {
  BallotMode,
  BallotType,
  Election,
  ElectionPackage,
  VotesDict,
} from '../ballots/election-loader.js';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert';
import { PDFDocument } from 'pdf-lib';

export interface BallotToScan {
  ballotStyleId: string;
  ballotMode: BallotMode;
  ballotType: BallotType;
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
  electionPackage: ElectionPackage,
  electionPackagePath: string,
  electionPath: string,
  precinctSelection: PrecinctSelection,
  ballotsToScan: BallotToScan[],
  outputDir: string,
  dataPath: string,
  openingPollsStep: StepCollector,
  collector: ArtifactCollector,
): Promise<void> {
  logger.step('Running VxScan workflow');
  const election = electionPackage.electionDefinition.election;

  await page.setViewportSize({
    width: 1920,
    height: 1080,
  });
  const usbController = createMockUsbController({ dataPath });
  const scannerController = createMockScannerController();

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
  await openingPollsStep.captureScreenshot('scan-locked', 'Initial locked screen');

  // Copy election package to USB
  const packageFilename = basename(electionPackagePath);
  await copyFile(electionPackagePath, join(usbController.getDataPath(), packageFilename));
  await usbController.insert();

  // Log in as election manager
  const electionManagerCard = await insertElectionManagerCardAndLogin(
    page,
    electionPath,
    outputDir,
  );
  await openingPollsStep.captureScreenshot('scan-unconfigured', 'Logged in');

  const precinctsForAllBallots = new Set(election.precincts.map((p) => p.id));

  for (const ballotToScan of ballotsToScan) {
    const ballotStylePrecincts = election.ballotStyles.find(
      ({ id }) => id === ballotToScan.ballotStyleId,
    )?.precincts;
    assert(ballotStylePrecincts, `Invalid ballot style ID: ${ballotToScan.ballotStyleId}`);

    for (const precinct of election.precincts) {
      if (!ballotStylePrecincts.includes(precinct.id)) {
        precinctsForAllBallots.delete(precinct.id);
      }
    }
  }

  if (election.precincts.length > 1) {
    const precinctToSelect =
      precinctSelection.kind === 'AllPrecincts'
        ? 'All Precincts'
        : election.precincts.find(({ id }) => id === precinctSelection.precinctId)?.name;
    assert(precinctToSelect, 'Invalid precinct selection');

    await page.getByText('Select a precinct…').click({ force: true });
    await page.getByText(precinctToSelect, { exact: true }).click({ force: true });
  }

  await page.getByText('Official Ballot Mode').click();

  await openingPollsStep.captureScreenshot('scan-configured', 'Configured');
  await electionManagerCard.removeCard();

  // Open polls
  logger.debug('Opening polls');

  // Need poll worker to open polls - will be used when poll opening is implemented
  const pollWorkerCardForOpeningPolls = await insertPollWorkerCard(page, electionPath);

  await page.getByText('Do you want to open the polls?').isVisible();

  // Confirm opening polls
  await clickButtonWithDebug(page, 'Open Polls', {
    timeout: 10000,
    outputDir,
    label: 'Confirming Open Polls',
  });

  await waitForTextInAppWithDebug(page, 'Polls Opened', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for polls opened confirmation',
  });
  await openingPollsStep.captureScreenshot('scan-polls-open', 'Polls opened');
  await pollWorkerCardForOpeningPolls.removeCard();

  // Add thermal printer reports from opening polls
  await addThermalPrinterReports(printerWorkspace, openingPollsStep, existingPrinterFiles);

  // Ready to scan
  await waitForTextInAppWithDebug(page, 'Insert Your Ballot', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for ready to scan screen',
  });
  await openingPollsStep.captureScreenshot('scan-ready', 'Ready to scan');

  // Mark opening polls step as complete
  openingPollsStep.complete();

  // Scan each ballot
  for (const [index, ballot] of ballotsToScan.entries()) {
    logger.debug(`Scanning ballot: ${ballot.ballotStyleId} - ${ballot.pattern}`);

    // Create step for this ballot right before scanning
    const ballotStep = collector.startStep(
      page,
      `scan-ballot-${index + 1}`,
      `Scan Ballot ${index + 1}: ${ballot.ballotStyleId} - ${ballot.pattern} (${ballot.ballotMode} ${ballot.ballotType})`,
      `Scan ${ballot.pattern} ballot for ballot style ${ballot.ballotStyleId} in ${ballot.ballotMode} mode`,
    );

    await scanBallot(repoPath, election, page, scannerController, ballot, ballotStep);

    // Mark ballot step as complete
    ballotStep.complete();
  }

  // Close polls
  logger.debug('Closing polls');

  // Create step for closing polls
  const closingPollsStep = collector.startStep(
    page,
    'closing-polls',
    'Closing Polls',
    'Close the polls and print results reports',
  );

  const pollWorkerCardForClosingPolls = await insertPollWorkerCard(page, electionPath);
  await waitForTextInAppWithDebug(page, 'Do you want to close the polls?', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for close polls confirmation prompt',
  });

  await clickButtonWithDebug(page, 'Close Polls', {
    timeout: 10000,
    outputDir,
    label: 'Confirming Close Polls',
  });

  await waitForTextInAppWithDebug(page, 'Polls Closed', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for polls closed confirmation',
  });

  // Clean up
  await pollWorkerCardForClosingPolls.removeCard();
  await usbController.remove();

  await waitForTextInAppWithDebug(page, 'Voting is complete.', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for voting complete message',
  });
  await closingPollsStep.captureScreenshot('scan-polls-closed', 'Polls Closed');

  // Add thermal printer reports from closing polls
  await addThermalPrinterReports(printerWorkspace, closingPollsStep, existingPrinterFiles);

  // Mark closing polls step as complete
  closingPollsStep.complete();

  const unconfiguringStep = collector.startStep(
    page,
    'unconfiguring',
    'Unconfiguring',
    'Unconfigure scanner to prepare for the next precinct',
  );

  // Unconfigure
  const unconfiguringElectionManagerCard = await insertElectionManagerCardAndLogin(
    page,
    electionPackagePath,
    outputDir,
  );

  await page.getByText('Unconfigure Machine').click();

  const confirmUnconfigureButton = page.getByText('Delete All Election Data');
  try {
    await confirmUnconfigureButton.waitFor({ state: 'visible', timeout: 10000 });
  } catch (error) {
    await unconfiguringStep.captureScreenshot(
      'timeout-unconfigure-button',
      'Timeout waiting for unconfigure button',
    );
    throw error;
  }

  await unconfiguringStep.captureScreenshot('confirm-unconfigure', 'Confirming unconfigure');
  await confirmUnconfigureButton.click();

  await waitForTextInAppWithDebug(page, 'Insert a USB drive containing an election package', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for USB drive prompt after unconfigure',
  });
  await unconfiguringElectionManagerCard.removeCard();
  await waitForTextInAppWithDebug(page, 'Insert an election manager card to configure VxScan', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for card prompt after unconfigure',
  });
  await unconfiguringStep.captureScreenshot('unconfigured', 'VxScan unconfigured');

  unconfiguringStep.complete();
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
  stepCollector: StepCollector,
): Promise<void> {
  const { ballotStyleId, pattern: markPattern, pdfPath } = ballot;
  const markedBallotPdf = await generateMarkedBallotForPattern(
    repoPath,
    election,
    ballotStyleId,
    markPattern,
    await readFile(pdfPath),
  );

  if (!markedBallotPdf) {
    return;
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

  // Scan each sheet (2 pages at a time)
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const frontPageIndex = sheetIndex * 2;
    const backPageIndex = frontPageIndex + 1;

    const votesForSheet: VotesDict = Object.fromEntries(
      Object.entries(markedBallotPdf.votes)
        .map(([contestId, votes]) => [
          contestId,
          votes.filter((vote) => {
            // Handle write-in votes
            if (typeof vote !== 'string' && vote.isWriteIn) {
              return gridLayout.gridPositions.some(
                (p) =>
                  p.sheetNumber === sheetIndex + 1 &&
                  p.contestId === contestId &&
                  p.type === 'write-in' &&
                  p.writeInIndex === vote.writeInIndex,
              );
            }

            // Handle regular option votes
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
    try {
      await page.getByText('Please wait…').waitFor({ state: 'hidden', timeout: 30000 });
    } catch (error) {
      await stepCollector.captureScreenshot(
        'timeout-scan-processing',
        'Timeout waiting for scan to complete',
      );
      throw error;
    }

    logger.debug(`Scanned sheet ${sheetIndex + 1}/${sheetCount}`);

    // After each sheet, check if ballot was rejected
    const message = page
      .getByRole('heading')
      .and(page.locator(':not([data-testid="ballot-count"])'));
    try {
      await message.waitFor({ state: 'visible', timeout: 5000 });
    } catch (error) {
      await stepCollector.captureScreenshot(
        'timeout-scan-result',
        'Timeout waiting for scan result message',
      );
      throw error;
    }
    const messageText = await message.innerText();
    logger.debug(`Message after sheet ${sheetIndex + 1}: ${messageText}`);

    // If rejected, handle immediately and stop scanning more sheets
    if (messageText !== 'Your ballot was counted!' && /ballot|wrong/i.test(messageText)) {
      logger.info(`Ballot rejected after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}`);

      const screenshot = await stepCollector.captureScreenshot(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot rejected: ${ballotStyleId} ${markPattern}`,
      );

      // Handle rejected ballot - return it
      await page.waitForTimeout(1000);
      const returnButton = page.getByRole('button', { name: 'Return Ballot' });
      if (await returnButton.isVisible()) {
        await returnButton.click();
        try {
          await waitForTextInApp(page, 'Remove Your Ballot');
        } catch (error) {
          await stepCollector.captureScreenshot(
            'timeout-remove-ballot',
            'Timeout waiting for remove ballot prompt',
          );
          throw error;
        }
      }

      await page.waitForTimeout(1500);
      await scannerController.removeSheet();

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot rejected',
        accepted: false,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        ballotMode: ballot.ballotMode,
        rejectedReason: markPattern === 'overvote' ? 'overvote' : 'rejected',
        markPattern,
        votes: votesForSheet,
      });
    } else {
      const screenshot = await stepCollector.captureScreenshot(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot accepted: ${ballotStyleId} ${markPattern} (${sheetIndex + 1}/${sheetCount})`,
      );

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot accepted',
        accepted: true,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        ballotMode: ballot.ballotMode,
        markPattern,
        votes: votesForSheet,
      });
    }
  }
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
        // Use absolute path - it will be copied to the step directory
        const absolutePath = join(printsDir, file);

        await stepCollector.addOutput({
          type: 'print',
          label: 'Thermal Printer Report',
          description: file,
          path: absolutePath,
        });

        // Add to existing files so it won't be added again in subsequent steps
        existingFiles.add(file);
      }
    }
  } catch (error) {
    logger.warn(`Failed to add thermal printer reports: ${(error as Error).message}`);
  }
}
