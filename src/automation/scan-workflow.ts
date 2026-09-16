/**
 * VxScan automation workflow
 */

import type { Page } from '@playwright/test';
import { logger } from '../utils/logger.ts';
import { createMockUsbController } from '../mock-hardware/usb.ts';
import {
  insertElectionManagerCardAndLogin,
  insertPollWorkerCardAndLogin as insertPollWorkerCard,
} from './auth-helpers.ts';
import {
  toggleDevDock,
  clickButtonWithDebug,
  waitForTextInApp,
  waitForTextInAppWithDebug,
} from './browser.ts';
import type { BallotPattern } from '../config/types.ts';
import { getVersionSpec } from '../config/versions.ts';
import type { VxSuiteVersion } from '../config/versions.ts';
import type { StepCollector, ArtifactCollector } from '../report/artifacts.ts';
import { basename, join } from 'node:path';
import { createMockScannerController } from '../mock-hardware/scanner.ts';
import { generateMarkedBallotForPattern } from '../ballots/ballot-marker.ts';
import { MOCK_NODE_ENV } from '../apps/env-config.ts';
import type {
  BallotMode,
  BallotType,
  Election,
  ElectionPackage,
  PollingPlace,
  VotesDict,
} from '../ballots/election-loader.ts';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert';
import { PDFDocument } from 'pdf-lib';

export interface BallotToScan {
  ballotStyleId: string;
  precinctId: string;
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
  version: VxSuiteVersion,
  page: Page,
  electionPackage: ElectionPackage,
  electionPackagePath: string,
  electionPath: string,
  precinctId: string,
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

  // Track existing thermal printer files to avoid duplicates. VxSuite writes
  // mock printer output to <repo>/.mock-state/<NODE_ENV>/prints.
  const printerWorkspace = join(repoPath, '.mock-state', MOCK_NODE_ENV);
  const existingPrinterFiles = new Set<string>();
  try {
    const printsDir = join(printerWorkspace, 'prints');
    const files = await readdir(printsDir);
    for (const file of files) {
      existingPrinterFiles.add(file);
    }
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

  await selectScannerLocation(page, version, election, precinctId);

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
    const ballotStep = await collector.startStep(
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
  const closingPollsStep = await collector.startStep(
    page,
    'closing-polls',
    'Closing Polls',
    'Close the polls and print results reports',
  );

  // Insert the poll worker card to bring up the close-polls prompt. The mock
  // card insertion can occasionally race with the app settling after the last
  // scanned ballot, leaving the app on the voter screen, so retry the insertion
  // a few times before giving up.
  const closePollsPrompt = 'Do you want to close the polls?';
  let pollWorkerCardForClosingPolls = await insertPollWorkerCard(page, electionPath);
  for (let attempt = 1; ; attempt++) {
    try {
      await waitForTextInApp(page, closePollsPrompt, { timeout: 10000 });
      break;
    } catch {
      if (attempt >= 3) {
        // Capture debug state on the final attempt, then fail.
        await waitForTextInAppWithDebug(page, closePollsPrompt, {
          timeout: 5000,
          outputDir,
          label: 'Waiting for close polls confirmation prompt',
        });
        break;
      }
      logger.warn(
        `Close-polls prompt not shown (attempt ${attempt}); re-inserting poll worker card`,
      );
      await pollWorkerCardForClosingPolls.removeCard();
      await page.waitForTimeout(1000);
      pollWorkerCardForClosingPolls = await insertPollWorkerCard(page, electionPath);
    }
  }

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

  const unconfiguringStep = await collector.startStep(
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
    await confirmUnconfigureButton.waitFor({
      state: 'visible',
      timeout: 10000,
    });
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

/**
 * The dropdown VxScan's election manager screen offers for scoping the machine
 * to a location, and the option to pick from it.
 */
export interface ScannerLocationSelection {
  placeholder: string;
  optionName: string;
}

/**
 * The polling place VxScan ends up scoped to for a precinct's ballots: the one
 * polling place when there is only one (VxScan selects it itself), otherwise
 * the election day polling place covering the precinct.
 */
function pollingPlaceForPrecinct(election: Election, precinctId: string): PollingPlace {
  const pollingPlaces = election.pollingPlaces ?? [];
  assert.ok(pollingPlaces.length > 0, 'Election has no polling places');

  const place =
    pollingPlaces.length === 1
      ? pollingPlaces[0]
      : pollingPlaces.find(
          (pollingPlace) =>
            pollingPlace.type === 'election_day' && precinctId in pollingPlace.precincts,
        );
  assert.ok(place, `No election day polling place for precinct: ${precinctId}`);
  assert.ok(
    precinctId in place.precincts,
    `Polling place "${place.name}" does not cover precinct ${precinctId}`,
  );

  return place;
}

/**
 * The precincts whose ballots VxScan counts once scoped to the location for
 * `precinctId`. Ballots from any other precinct are returned as "Wrong
 * Precinct". v4.0 accepts only the selected precinct; v4.1 accepts every
 * precinct of the selected polling place.
 */
export function scannerAcceptedPrecinctIds(
  version: VxSuiteVersion,
  election: Election,
  precinctId: string,
): ReadonlySet<string> {
  if (getVersionSpec(version).locationModel === 'precinct') {
    return new Set([precinctId]);
  }

  return new Set(Object.keys(pollingPlaceForPrecinct(election, precinctId).precincts));
}

/**
 * Work out which location option VxScan needs for the ballots being scanned,
 * or `undefined` when VxScan offers no picker because there is only one choice.
 *
 * v4.0 scopes the machine to a precinct; v4.1 replaced that with a polling
 * place, so the same precinct selection maps onto a different dropdown.
 */
export function scannerLocationSelection(
  version: VxSuiteVersion,
  election: Election,
  precinctId: string,
): ScannerLocationSelection | undefined {
  if (getVersionSpec(version).locationModel === 'precinct') {
    if (election.precincts.length <= 1) return undefined;

    const precinct = election.precincts.find(({ id }) => id === precinctId)?.name;
    assert.ok(precinct, `Invalid precinct selection: ${precinctId}`);

    return { placeholder: 'Select a precinct…', optionName: precinct };
  }

  if ((election.pollingPlaces ?? []).length <= 1) return undefined;

  return {
    placeholder: 'Select a polling place…',
    optionName: pollingPlaceForPrecinct(election, precinctId).name,
  };
}

/** Scope VxScan to the location the ballots being scanned belong to. */
async function selectScannerLocation(
  page: Page,
  version: VxSuiteVersion,
  election: Election,
  precinctId: string,
): Promise<void> {
  const selection = scannerLocationSelection(version, election, precinctId);
  if (!selection) return;

  // Both versions' pickers are a VxSuite `SearchSelect`, whose placeholder sits
  // under react-select's input, so opening the menu needs a forced click.
  const placeholder = page.getByText(selection.placeholder, { exact: true });
  await placeholder.click({ force: true });

  const option = page
    .getByRole('option')
    .filter({ has: page.getByText(selection.optionName, { exact: true }) });
  await option.click({ timeout: 10000 });

  // The picker commits asynchronously. Without confirming it, a click that
  // lands before the menu is ready leaves the scanner on its previous location
  // and every ballot in the session scans as the wrong precinct.
  await placeholder.waitFor({ state: 'detached', timeout: 10000 });
  await page.getByText(selection.optionName, { exact: true }).first().waitFor({ timeout: 10000 });
}

function votesWithOnlyIds(votes: VotesDict): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(votes).map(([contestId, contestVotes]) => [
      contestId,
      contestVotes.map((vote) => (typeof vote === 'string' ? vote : vote.id)),
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

    const sheetVotes: VotesDict = Object.fromEntries(
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

    // A contest marked beyond its seat count is an overvote: the scanner counts
    // no selections for it (only an overvote). Drop such contests so the
    // recorded votes reflect what is actually counted — this matters when an
    // overvoted ballot is cast (accepted) rather than returned.
    const votesForSheet: VotesDict = Object.fromEntries(
      Object.entries(sheetVotes).filter(([contestId, contestVotes]) => {
        const contest = election.contests.find((c) => c.id === contestId);
        const seats = contest?.type === 'candidate' ? contest.seats : 1;
        return contestVotes.length <= seats;
      }),
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
    // Warning headings prefix the title with an icon, so compare on the text.
    const messageText = (await message.innerText()).trim();
    logger.debug(`Message after sheet ${sheetIndex + 1}: ${messageText}`);

    const isScanFailure = messageText === 'Ballot Scan Failed';

    // "Review Your Ballot" is the only screen offering a Cast/Return choice.
    // Every other non-success heading -- "Wrong Precinct", "Wrong Election",
    // "Test Ballot", "Multiple Sheets Detected" -- is an outright rejection
    // with no "Cast Ballot" button to click.
    const isReviewScreen = messageText === 'Review Your Ballot';

    const needsReview = !isScanFailure && messageText !== 'Your ballot was counted!';

    if (isScanFailure) {
      logger.warn(`Ballot scan failed after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}`);

      const screenshot = await stepCollector.captureScreenshot(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot scan failed: ${ballotStyleId} ${markPattern}`,
      );

      // No Cast/Return choice on this screen -- just remove the sheet so the
      // run can continue with the next ballot. "Remove Your Ballot" may or
      // may not appear first depending on the scan-failure reason, so don't
      // treat its absence as fatal.
      await page.waitForTimeout(1000);
      try {
        await waitForTextInApp(page, 'Remove Your Ballot', { timeout: 5000 });
      } catch {
        // Proceed regardless; the sheet still needs to be removed.
      }
      await scannerController.removeSheet();

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot scan failed',
        accepted: false,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        ballotMode: ballot.ballotMode,
        rejectedReason: 'scan-failed',
        markPattern,
        votes: votesForSheet,
      });
    } else if (isReviewScreen && ballot.expectedAccepted) {
      // A castable warning we choose to cast anyway, e.g. an overvote when the
      // election allows casting overvotes. Click "Cast Ballot" and confirm the
      // ballot is counted.
      logger.info(
        `Ballot needs review after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}; casting anyway`,
      );
      await stepCollector.captureScreenshot(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}-review`,
        `Ballot needs review (casting anyway): ${ballotStyleId} ${markPattern}`,
      );

      await page.waitForTimeout(1000);
      try {
        await page.getByRole('button', { name: 'Cast Ballot' }).click({ timeout: 10000 });
        await waitForTextInApp(page, 'Your ballot was counted!');
      } catch (error) {
        await stepCollector.captureScreenshot(
          'timeout-cast-ballot',
          'Timeout casting ballot after review',
        );
        throw error;
      }

      const screenshot = await stepCollector.captureScreenshot(
        `scan-${ballotStyleId}-${markPattern}-sheet-${sheetIndex + 1}`,
        `Ballot cast after review: ${ballotStyleId} ${markPattern} (${sheetIndex + 1}/${sheetCount})`,
      );

      await stepCollector.addOutput({
        type: 'scan-result',
        label: `Scan Result ${sheetIndex + 1} of ${sheetCount}`,
        description: 'Ballot cast after review',
        accepted: true,
        expected: ballot.expectedAccepted,
        screenshotPath: screenshot.path,
        ballotStyleId,
        ballotMode: ballot.ballotMode,
        markPattern,
        votes: votesForSheet,
      });
    } else if (needsReview) {
      const rejection = `Ballot rejected after sheet ${sheetIndex + 1}/${sheetCount}: ${messageText}`;
      if (ballot.expectedAccepted) {
        logger.warn(`${rejection} (expected it to be accepted)`);
      } else {
        logger.info(rejection);
      }

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
        rejectedReason: isReviewScreen
          ? markPattern === 'overvote'
            ? 'overvote'
            : markPattern === 'undervote'
              ? 'undervote'
              : 'rejected'
          : messageText,
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
