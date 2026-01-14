/**
 * VxAdmin tally workflow - imports CVRs and generates reports
 */

import { Page, Locator } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockUsbController } from '../mock-hardware/usb.js';
import { dipElectionManagerCardAndLogin } from './auth-helpers.js';
import {
  navigateToApp,
  waitForTextWithDebug,
  clickButtonWithDebug,
  clickTextInApp,
  toggleDevDock,
} from './browser.js';
import { loadCollection, type StepCollector, type ArtifactCollector } from '../report/artifacts.js';
import { ArtifactCollection, StepOutput, ValidationResult } from '../config/types.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Contest,
  Election,
  getContestsForBallotStyle,
  Precinct,
} from '../ballots/election-loader.js';

/**
 * Contest result tallies for manual data entry
 */
interface ContestResult {
  contestId: string;
  ballots: number;
  overvotes: number;
  undervotes: number;
  tallies: Record<string, number>;
  validation?: {
    type: 'success' | 'warning' | 'error';
    message: string;
  };
}

/**
 * Parse a CSV line respecting quoted fields that may contain commas
 * Based on RFC 4180
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let wasQuoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentField += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        wasQuoted = true;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator - only trim unquoted fields
      fields.push(wasQuoted ? currentField : currentField.trim());
      currentField = '';
      wasQuoted = false;
    } else {
      currentField += char;
    }
  }

  // Add the last field - only trim if it wasn't quoted
  fields.push(wasQuoted ? currentField : currentField.trim());

  return fields;
}

/**
 * Add manual tallies for all ballot styles
 */
async function addManualTally(
  page: Page,
  election: Election,
  collector: ArtifactCollector,
  limitManualTallies?: number,
): Promise<void> {
  logger.step('Adding manual tallies for all ballot styles');

  logger.info(`Found ${election.ballotStyles.length} ballot styles`);

  // Navigate to Manual Tallies tab
  await clickTextInApp(page, 'Manual Tallies');
  await page.waitForTimeout(1000);

  if (election.ballotStyles.length === 0) {
    logger.info('No ballot styles in election - skipping manual tallies');
    return;
  }

  // Determine how many ballot styles to process
  const ballotStylesToProcess =
    limitManualTallies !== undefined && limitManualTallies >= 0
      ? Math.min(limitManualTallies, election.ballotStyles.length)
      : election.ballotStyles.length;

  if (limitManualTallies !== undefined && limitManualTallies >= 0) {
    logger.info(
      `Limited manual tallies to ${ballotStylesToProcess} ballot styles (from ${election.ballotStyles.length})`,
    );
  }

  // Loop through each ballot style
  for (let styleIndex = 0; styleIndex < ballotStylesToProcess; styleIndex++) {
    const ballotStyle = election.ballotStyles[styleIndex];
    const ballotStyleGroupId = ballotStyle.id;
    const precinctId = ballotStyle.precincts[0]; // Use first precinct
    const contests = getContestsForBallotStyle(election, ballotStyleGroupId);

    logger.info(
      `Processing ballot style ${styleIndex + 1}/${ballotStylesToProcess}: ${ballotStyleGroupId} (${contests.length} contests)`,
    );

    // Create a step for this ballot style's manual tally
    const manualTallyStep = collector.startStep(
      page,
      `manual-tally-${ballotStyleGroupId}`,
      `Manual Tally: ${ballotStyleGroupId}`,
      `Enter manual tallies for ballot style ${ballotStyleGroupId} in precinct ${precinctId}`,
    );

    await processBallotStyle(
      page,
      manualTallyStep,
      election,
      ballotStyleGroupId,
      precinctId,
      contests,
      styleIndex,
    );

    manualTallyStep.complete();
  }

  logger.success(`Added manual tallies for ${ballotStylesToProcess} ballot styles`);
}

/**
 * Process a single ballot style - select it and fill out all contests
 */
async function processBallotStyle(
  page: Page,
  stepCollector: StepCollector,
  election: Election,
  ballotStyleGroupId: string,
  precinctId: string,
  contests: Array<Contest>,
  styleIndex: number,
): Promise<void> {
  const votingMethod = 'precinct' as const;

  // Calculate ballot count: give 1 vote to each option in the contest with most options
  const maxOptionsPerContest = Math.max(
    ...contests.map((c) => {
      if (c.type === 'candidate') {
        return c.candidates.length + 2; // candidates + undervotes + overvotes
      }
      return 4; // yes-no contests: yes + no + undervotes + overvotes
    }),
  );
  const ballotCount = maxOptionsPerContest;

  logger.debug(`Using ballot count ${ballotCount} for ${ballotStyleGroupId}`);

  const contestResults: Record<string, ContestResult> = {};

  // Select ballot style from dropdown using the ID selector
  const ballotStyleSelect = page.locator('#selectPrecinctAndBallotStyle');

  // Check if it's disabled
  const isDisabled = await ballotStyleSelect.isDisabled();
  logger.debug(`Ballot style dropdown disabled: ${isDisabled}`);

  await ballotStyleSelect.click();

  // Wait for the menu to open - react-select uses a div with specific class or just wait for options
  await page.waitForTimeout(1000);

  await stepCollector.captureScreenshot(
    `admin-manual-tallies-style-${styleIndex}-clicked`,
    `After clicking ballot style dropdown for ${ballotStyleGroupId}`,
  );

  // Log all elements to debug what's actually present
  const allDivs = await page.locator('div').all();
  logger.debug(`Total divs on page: ${allDivs.length}`);

  // Find and click the ballot style option
  // The label format is "{Precinct or Split Name}" or "{Precinct or Split Name} - {Party}"
  const precinctInfo = election.precincts.find((p) => p.id === precinctId);
  const ballotStyleInfo = election.ballotStyles.find((bs) => bs.id === ballotStyleGroupId);

  // Determine the display name: if the precinct has splits, use the split name; otherwise use precinct name
  let displayName = precinctInfo?.name || precinctId;

  // Check for splits (not in our type definition, but may exist in runtime data)
  const precinctWithSplits = precinctInfo as Precinct & {
    splits?: Array<{ name: string; districtIds?: string[] }>;
  };
  if (precinctWithSplits.splits && precinctWithSplits.splits.length > 0) {
    // If there are splits, we need to find the right one for this ballot style
    // The ballot style's groupId corresponds to the split's corresponding district or identifier
    const matchingSplit = precinctWithSplits.splits.find((split) => {
      // The split corresponds to this ballot style if they share districts
      return ballotStyleInfo?.districts?.some((districtId: string) =>
        split.districtIds?.includes(districtId),
      );
    });

    if (matchingSplit) {
      displayName = matchingSplit.name;
    }
  }

  logger.debug(`Looking for ballot style option containing "${displayName}"`);

  // Click on the text - try multiple strategies
  try {
    // First try exact text match
    const optionElement = page.getByText(displayName, { exact: true });
    const count = await optionElement.count();
    logger.debug(`Found ${count} elements with text "${displayName}"`);

    if (count > 0) {
      // Click the last one (dropdown options are typically later in the DOM than labels)
      await optionElement.last().click({ timeout: 5000, force: true });
      logger.debug(`Selected ballot style option "${displayName}"`);
    } else {
      throw new Error(`No elements found with text "${displayName}"`);
    }
  } catch (error) {
    logger.error(`Failed to click ballot style option "${displayName}": ${String(error)}`);
    await stepCollector.captureScreenshot(
      `admin-manual-tallies-style-${styleIndex}-no-options`,
      'Failed to select option',
    );
    return;
  }

  await page.waitForTimeout(500);

  // Select voting method using the ID selector
  const votingMethodSelect = page.locator('#selectBallotType');
  await votingMethodSelect.click();
  await page.waitForTimeout(800);

  const precinctOption = page.getByText('Precinct', { exact: true });
  await precinctOption.first().click();
  await page.waitForTimeout(500);

  await stepCollector.captureScreenshot(
    `admin-manual-tallies-style-${styleIndex}-selected`,
    `Selected ${ballotStyleGroupId}`,
  );

  // Click "Enter Tallies" button
  const enterTalliesButton = page.getByText('Enter Tallies');
  await enterTalliesButton.click();
  await page.waitForTimeout(1000);

  // Fill ballot count
  const ballotCountInput = page.locator('input#ballotCount');
  await ballotCountInput.waitFor({ state: 'visible', timeout: 5000 });
  await ballotCountInput.fill(String(ballotCount));
  await page.waitForTimeout(500);

  // Click "Save & Next" to proceed to first contest
  await page.getByText('Save & Next').click();
  await page.waitForTimeout(1000);

  // Loop through each contest
  for (let contestIndex = 0; contestIndex < contests.length; contestIndex++) {
    const contest = contests[contestIndex];
    const isLastContest = contestIndex === contests.length - 1;

    logger.debug(`Contest ${contestIndex + 1}/${contests.length}: ${contest.id}`);

    await fillContest(
      page,
      stepCollector,
      contest,
      ballotCount,
      contestResults,
      styleIndex,
      contestIndex,
      isLastContest,
    );
  }

  // After filling all contests, we should be back at the manual tallies tab
  await page.waitForTimeout(1000);

  // Record the manual tally as output
  await stepCollector.addOutput({
    type: 'manual-tally',
    label: `Manual Tally: ${ballotStyleGroupId}`,
    description: `Manual tally for ${ballotStyleGroupId} in ${precinctId} (${votingMethod})`,
    precinctId,
    ballotStyleGroupId,
    votingMethod,
    ballotCount,
    contestResults,
  });
}

/**
 * Fill out a single contest with valid tallies
 */
async function fillContest(
  page: Page,
  stepCollector: StepCollector,
  contest: Contest,
  ballotCount: number,
  contestResults: Record<string, ContestResult>,
  styleIndex: number,
  contestIndex: number,
  isLastContest: boolean,
): Promise<void> {
  // Get contest ID from URL
  const contestUrl = page.url();
  const urlParts = contestUrl.split('/');
  const contestId = urlParts[urlParts.length - 1] || contest.id;

  // Wait for form to load
  await page.locator('input#undervotes').waitFor({ state: 'visible' });

  // Build a map of input IDs to actual option IDs
  // For yes-no contests, the input IDs are "yes" and "no", but we need the actual option IDs
  const inputIdToOptionId = new Map<string, string>();
  if (contest.type === 'yesno') {
    inputIdToOptionId.set('yes', contest.yesOption.id);
    inputIdToOptionId.set('no', contest.noOption.id);
  } else {
    // For candidate contests, the input ID is the candidate ID
    for (const candidate of contest.candidates) {
      inputIdToOptionId.set(candidate.id, candidate.id);
    }
  }

  // Find all number inputs
  const allInputs = await page.locator('input[type="text"]:not([disabled])').all();
  const candidateInputs: Array<{ input: Locator; id: string; optionId: string }> = [];

  // Step 1: Initialize all candidate inputs with 0
  for (const input of allInputs) {
    const inputId = await input.getAttribute('id');
    if (
      inputId &&
      inputId !== 'undervotes' &&
      inputId !== 'overvotes' &&
      inputId !== 'ballotCount'
    ) {
      await input.fill('0');
      const optionId = inputIdToOptionId.get(inputId) || inputId;
      candidateInputs.push({ input, id: inputId, optionId });
      await page.waitForTimeout(50);
    }
  }

  logger.debug(`Found ${candidateInputs.length} candidate/option inputs`);

  // Step 2: Fill undervotes and overvotes
  // For candidate contests with multiple seats, the total must equal ballotCount × seats
  // For yes-no contests, the total must equal ballotCount × 1
  const totalMarksNeeded = contest.type === 'candidate' ? ballotCount * contest.seats : ballotCount;

  // Give each candidate 1 vote, rest goes to undervotes
  const votesForCandidates = candidateInputs.length;
  const undervotes = totalMarksNeeded - votesForCandidates;

  await page.locator('input#undervotes').fill(String(undervotes));
  await page.locator('input#overvotes').fill('0');
  await page.waitForTimeout(200);

  // Step 3: Give 1 vote to each candidate/option
  const tallies: Record<string, number> = {};
  for (const { input, optionId } of candidateInputs) {
    await input.fill('1');
    tallies[optionId] = 1;
    await page.waitForTimeout(50);
  }

  // Record results
  contestResults[contestId] = {
    contestId,
    ballots: ballotCount,
    overvotes: 0,
    undervotes,
    tallies,
  };

  logger.debug(
    `Filled contest ${contestId}: ${candidateInputs.length} options with 1 vote each, ${undervotes} undervotes`,
  );

  await page.waitForTimeout(500);

  // Capture screenshot after all values are entered but before clicking button
  await stepCollector.captureScreenshot(
    `admin-manual-tallies-style-${styleIndex}-contest-${contestIndex}`,
    `Contest ${contest.id} with values entered`,
  );

  // Click appropriate button based on whether this is the last contest
  const buttonText = isLastContest ? 'Finish' : 'Save & Next';
  const button = page.getByText(buttonText);
  await button.click({ timeout: 120_000 });
  await page.waitForTimeout(1000);

  // Check for validation message (success or warning)
  const validationMessage = await captureValidationMessage(page);
  if (validationMessage) {
    if (validationMessage.type === 'error') {
      logger.error(`Contest ${contestId}: ${validationMessage.text}`);
    } else if (validationMessage.type === 'warning') {
      logger.warn(`Contest ${contestId}: ${validationMessage.text}`);
    } else {
      logger.info(`Contest ${contestId}: ${validationMessage.text}`);
    }

    // Store validation info in contest results
    contestResults[contestId].validation = {
      type: validationMessage.type,
      message: validationMessage.text,
    };
  }
}

/**
 * Capture validation message from the tally form
 * Returns the message text and type (success/warning/error)
 */
async function captureValidationMessage(
  page: Page,
): Promise<{ type: 'success' | 'warning' | 'error'; text: string } | null> {
  try {
    // VxAdmin shows validation messages in a <p> tag near the form actions
    // Messages can be:
    // - "Incomplete tallies" (warning)
    // - "Entered tallies do not match total ballots cast" (warning)
    // - "Entered tallies are valid" (success)

    // Wait a moment for the validation message to appear
    await page.waitForTimeout(500);

    // Try to find validation text
    const validationTexts = [
      'Entered tallies are valid',
      'Entered tallies do not match total ballots cast',
      'Incomplete tallies',
    ];

    for (const validationText of validationTexts) {
      try {
        const element = page.getByText(validationText, { exact: false });
        if (await element.isVisible({ timeout: 1000 })) {
          const text = validationText;
          const type = text.includes('valid')
            ? 'success'
            : text.includes('do not match') || text.includes('Incomplete')
              ? 'warning'
              : 'error';

          logger.debug(`Captured validation message: ${text} (${type})`);
          return { type, text };
        }
      } catch {
        // Not found, try next
      }
    }

    logger.debug('No validation message found');
    return null;
  } catch (error) {
    logger.debug(`Could not capture validation message: ${String(error)}`);
    return null;
  }
}

/**
 * Load CVRs from VxScan USB drives
 */
async function loadCvrs(
  page: Page,
  election: Election,
  outputDir: string,
  stepCollector: StepCollector,
): Promise<void> {
  await stepCollector.captureScreenshot('admin-tally-locked', 'VxAdmin locked (before tally)');
  await stepCollector.captureScreenshot('admin-tally-logged-in', 'Logged in as Election Manager');

  // Navigate to Tally section
  logger.debug('Navigating to Tally section');

  // Wait for the page to be ready
  await page.waitForTimeout(2000);

  // Click on "Tally" tab/link in the navigation
  try {
    // Try clicking as a role button first
    await page.getByRole('button', { name: 'Tally', exact: true }).click({ timeout: 5000 });
  } catch {
    // If that fails, try clicking as a link
    try {
      await page.getByRole('link', { name: 'Tally', exact: true }).click({ timeout: 5000 });
    } catch {
      // If both fail, try just clicking any element with the text
      await clickButtonWithDebug(page, 'Tally', {
        timeout: 10000,
        outputDir,
        label: 'Clicking Tally tab',
      });
    }
  }

  await page.waitForTimeout(1000);
  await stepCollector.captureScreenshot('admin-tally-page', 'Tally page');

  // Look for CVR files on USB and import them
  logger.debug('Looking for CVR files to import');

  for (let i = 0; i <= election.precincts.length + 1; i += 1) {
    if (i === election.precincts.length + 1) {
      throw new Error('Expected 1 VxScan per precinct, but found more than that');
    }

    await stepCollector.captureScreenshot('admin-tally-before-load-cvrs', 'Before click Load CVRs');

    // Click the "Load CVRs" button
    await page.getByText('Load CVRs').click();
    await page.waitForTimeout(1000);
    await stepCollector.captureScreenshot('admin-tally-load-cvr-dialog', 'Load CVR dialog');

    // Find and click the Load button in the modal table for the first CVR file
    // Each row in the table has a "Load" button (or "Loaded" if already imported)
    const modal = page.locator('[role="alertdialog"]');
    const loadButtons = modal.getByRole('button', { name: 'Load', exact: true });

    const loadButtonCount = await loadButtons.count();
    logger.debug(`Found ${loadButtonCount} Load buttons in CVR modal`);

    if (loadButtonCount === 0) {
      // No more to load, close the modal
      await modal.getByText('Cancel').click();
      break;
    }

    await loadButtons.first().click();

    // Wait for success message "X New CVR Loaded" or "X New CVRs Loaded"
    await waitForTextWithDebug(page, 'New CVR', {
      timeout: 30000,
      outputDir,
      label: 'Waiting for CVRs to be loaded',
    });

    await stepCollector.captureScreenshot(
      'admin-tally-cvrs-loaded-success',
      'CVRs loaded successfully',
    );

    // Close the success dialog
    await page.getByRole('button', { name: 'Close' }).click();
  }

  await page.waitForTimeout(1000);
  await stepCollector.captureScreenshot('admin-tally-after-cvr-load', 'Tally page after CVR load');

  logger.success('CVRs loaded successfully');
}

/**
 * Generate and export tally reports
 */
async function generateReports(
  page: Page,
  usbController: ReturnType<typeof createMockUsbController>,
  stepCollector: StepCollector,
): Promise<void> {
  // Navigate to Reports section
  logger.debug('Navigating to Reports section');

  await clickTextInApp(page, 'Reports');

  await page.waitForTimeout(1000);
  await stepCollector.captureScreenshot('admin-reports-page', 'Reports page');

  // Generate tally report by clicking the link
  logger.debug('Generating tally report');

  await clickTextInApp(page, 'Full Election Tally Report');

  await page.waitForTimeout(2000);
  await stepCollector.captureScreenshot('admin-tally-report-preview', 'Tally report preview');

  // Export the report as PDF
  logger.debug('Exporting tally report as PDF');

  await clickTextInApp(page, 'Export Report PDF');

  // Wait for the save dialog to appear and click Save
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Save' }).click();

  // Wait for the PDF to be exported to USB
  await page.waitForTimeout(3000);

  await stepCollector.captureScreenshot('admin-tally-report-exported', 'Tally report exported');

  // Close the "Tally Report Saved" modal
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(500);

  // Export CSV report
  logger.debug('Exporting tally report as CSV');

  await clickTextInApp(page, 'Export Report CSV');

  // Wait for the save dialog and click Save
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Save' }).click();

  // Wait for CSV to be exported
  await page.waitForTimeout(3000);

  // Close the success modal
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(500);

  // Find the exported PDF and CSV on the USB drive
  logger.debug('Looking for exported reports on USB');
  const usbDataPath = usbController.getDataPath();
  const exportedPdfPath = await findExportedTallyReport(usbDataPath);
  const exportedCsvPath = await findExportedTallyCsv(usbDataPath);

  if (exportedPdfPath) {
    await stepCollector.addOutput({
      type: 'report',
      label: 'Tally Report PDF',
      description: 'Exported Full Election Tally Report',
      path: exportedPdfPath,
    });
  }

  if (exportedCsvPath) {
    await stepCollector.addOutput({
      type: 'report',
      label: 'Tally Report CSV',
      description: 'Exported Full Election Tally CSV',
      path: exportedCsvPath,
    });
  }

  logger.success('Tally reports generated and exported');
}

export async function runAdminTallyWorkflow(
  page: Page,
  election: Election,
  electionPackagePath: string,
  outputDir: string,
  dataPath: string,
  collector: ArtifactCollector,
  limitManualTallies?: number,
): Promise<void> {
  logger.step('Running VxAdmin tally workflow');

  await page.setViewportSize({
    width: 1920,
    height: 1200,
  });
  const usbController = createMockUsbController({ dataPath });

  // Navigate to app
  await navigateToApp(page);
  await toggleDevDock(page);

  // Ensure USB is inserted with CVRs
  logger.debug('Inserting USB drive with CVRs');
  await usbController.insert();
  await page.waitForTimeout(1000);

  // Log in as election manager
  await dipElectionManagerCardAndLogin(page, electionPackagePath);

  // Step 1: Load CVRs
  const loadCvrsStep = collector.startStep(
    page,
    'loading-cvrs',
    'Loading CVRs in VxAdmin',
    'Import CVR files from VxScan USB drives',
  );

  await loadCvrs(page, election, outputDir, loadCvrsStep);
  loadCvrsStep.complete();

  // Step 2: Add manual tallies (creates individual steps for each ballot style)
  await addManualTally(page, election, collector, limitManualTallies);

  // Step 3: Generate reports
  const reportsStep = collector.startStep(
    page,
    'generating-reports',
    'Generating Tally Reports',
    'Generate and export tally reports as PDF and CSV',
  );

  await generateReports(page, usbController, reportsStep);
  reportsStep.complete();

  // Lock machine before logging out
  logger.debug('Locking machine');

  await clickTextInApp(page, 'Lock Machine');

  await page.waitForTimeout(500);

  await reportsStep.captureScreenshot('admin-tally-logged-out', 'Logged out after tally');

  // Remove USB
  await usbController.remove();
}

/**
 * Find the most recently exported tally report PDF on the USB drive
 */
async function findExportedTallyReport(usbDataPath: string): Promise<string | undefined> {
  const findPdfFiles = async (dir: string): Promise<string[]> => {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          results.push(...(await findPdfFiles(fullPath)));
        } else if (entry.name.includes('tally-report') && entry.name.endsWith('.pdf')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }

    return results;
  };

  const pdfFiles = await findPdfFiles(usbDataPath);

  if (pdfFiles.length === 0) {
    return undefined;
  }

  // Return the most recently modified PDF file
  const sorted = (
    await Promise.all(pdfFiles.map(async (path) => ({ path, mtime: (await stat(path)).mtime })))
  ).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return sorted[0].path;
}

/**
 * Find the most recently exported tally CSV on the USB drive
 */
async function findExportedTallyCsv(usbDataPath: string): Promise<string | undefined> {
  const findCsvFiles = async (dir: string): Promise<string[]> => {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          results.push(...(await findCsvFiles(fullPath)));
        } else if (entry.name.includes('tally-report') && entry.name.endsWith('.csv')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory might not exist
    }

    return results;
  };

  const csvFiles = await findCsvFiles(usbDataPath);

  if (csvFiles.length === 0) {
    return undefined;
  }

  // Return the most recently modified CSV file
  const sorted = (
    await Promise.all(csvFiles.map(async (path) => ({ path, mtime: (await stat(path)).mtime })))
  ).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return sorted[0].path;
}

export interface Adjudications {
  markedWriteIns: 'invalid' | 'new-candidate' | 'official-candidate';
  unmarkedWriteIns: 'invalid' | 'new-candidate' | 'official-candidate';
}

/**
 * Validate tally results against scanned ballots and manual tallies
 */
export async function validateTallyResults(
  collection: ArtifactCollection,
): Promise<ValidationResult> {
  try {
    let tallyCsvOutput: Extract<StepOutput, { type: 'report' }> | undefined;

    // Get votes from accepted scan results stored in step outputs
    const expectedVotes = new Map<string, Map<string, number>>(); // contestId -> optionId -> count
    let totalOutputs = 0;
    let manualTallyCount = 0;

    for (const step of collection.steps) {
      for (const output of step.outputs) {
        if (
          output.type === 'scan-result' &&
          output.accepted &&
          output.votes &&
          output.markPattern !== 'unmarked-write-in'
        ) {
          totalOutputs++;

          const votes = output.votes;
          for (const [contestId, contestVotes] of Object.entries(votes)) {
            if (!expectedVotes.has(contestId)) {
              expectedVotes.set(contestId, new Map());
            }
            for (const vote of contestVotes) {
              const optionId = typeof vote === 'string' ? vote : vote.id;
              const contestMap = expectedVotes.get(contestId) as Map<string, number>;
              if (optionId.startsWith('write-in')) {
                contestMap.set('write-in', (contestMap.get('write-in') ?? 0) + 1);
              } else {
                contestMap.set(optionId, (contestMap.get(optionId) ?? 0) + 1);
              }
            }
          }
        }

        // Include manual tallies in expected votes
        if (output.type === 'manual-tally') {
          manualTallyCount++;

          for (const [contestId, contestTally] of Object.entries(output.contestResults)) {
            if (!expectedVotes.has(contestId)) {
              expectedVotes.set(contestId, new Map());
            }
            const contestMap = expectedVotes.get(contestId) as Map<string, number>;

            // Add the manual tally votes to expected votes
            for (const [optionId, count] of Object.entries(contestTally.tallies)) {
              contestMap.set(optionId, (contestMap.get(optionId) ?? 0) + count);
            }
          }
        }

        if (
          output.type === 'report' &&
          output.path.includes('tally-report') &&
          output.path.endsWith('.csv')
        ) {
          tallyCsvOutput = output;
        }
      }
    }

    if (!tallyCsvOutput) {
      throw new Error('No tally report CSV output found');
    }

    logger.debug(
      `Validation: processed ${totalOutputs} scanned sheets and ${manualTallyCount} manual tally entries`,
    );

    // Parse CSV to get actual vote counts by selection ID
    // CSV format: Contest,Contest ID,Selection,Selection ID,Total Votes
    const csvContent = await readFile(tallyCsvOutput.path, 'utf-8');
    const lines = csvContent.trim().split('\n');

    const actualVotes = new Map<string, Map<string, number>>(); // contestId -> selectionId -> count
    let totalExpectedVotes = 0;
    let totalActualVotes = 0;

    for (let i = 2; i < lines.length; i += 1) {
      // Skip header row at index 1
      const line = lines[i];
      if (!line.trim()) continue;

      const fields = parseCsvLine(line);
      if (fields.length >= 5) {
        const contestId = fields[1];
        const selectionId = fields[3];
        const votes = parseInt(fields[4] || '0', 10);

        if (!isNaN(votes) && selectionId !== 'overvotes' && selectionId !== 'undervotes') {
          if (!actualVotes.has(contestId)) {
            actualVotes.set(contestId, new Map());
          }
          const contestMap = actualVotes.get(contestId) as Map<string, number>;
          contestMap.set(selectionId, (contestMap.get(selectionId) ?? 0) + votes);

          if (votes > 0) {
            totalActualVotes += votes;
          }
        }
      }
    }

    // Count expected votes
    for (const contest of expectedVotes.values()) {
      for (const count of contest.values()) {
        totalExpectedVotes += count;
      }
    }

    // Compare expected vs actual votes by candidate
    const mismatches: string[] = [];

    for (const [contestId, candidates] of expectedVotes) {
      for (const [candidateId, expectedCount] of candidates) {
        const actualCount = actualVotes.get(contestId)?.get(candidateId) ?? 0;
        if (actualCount !== expectedCount) {
          mismatches.push(
            `Contest ${contestId}, Candidate ${candidateId}: expected ${expectedCount} based on marked ballots, got ${actualCount} from tally CSV`,
          );
        }
      }
    }

    // Check for votes in CSV that weren't expected
    for (const [contestId, candidates] of actualVotes) {
      for (const [selectionId, actualCount] of candidates) {
        if (actualCount > 0) {
          let found = false;
          for (const candidates of expectedVotes.values()) {
            if (candidates.get(selectionId)) {
              found = true;
              break;
            }
          }
          if (!found) {
            mismatches.push(
              `Unexpected votes in CSV for ${contestId}/${selectionId}: ${actualCount}`,
            );
          }
        }
      }
    }

    logger.debug(
      `Validation - Expected votes: ${totalExpectedVotes}, Actual votes: ${totalActualVotes}`,
    );

    tallyCsvOutput.validationResult =
      mismatches.length > 0
        ? {
            isValid: false,
            message: `Tally mismatch: ${mismatches.join('; ')}`,
          }
        : {
            isValid: true,
            message: `Tally validated: ${totalExpectedVotes} vote(s) match CSV exactly`,
          };
    return tallyCsvOutput.validationResult;
  } catch (error) {
    throw new Error(
      `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export async function revalidateTallyResults(
  outputDir: string,
): Promise<{ isValid: boolean; message: string }> {
  return validateTallyResults(await loadCollection(join(outputDir, 'collection.json')));
}
