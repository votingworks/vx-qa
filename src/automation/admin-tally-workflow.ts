/**
 * VxAdmin tally workflow - imports CVRs and generates reports
 */

import { Page } from '@playwright/test';
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
import { ScreenshotManager } from './screenshot.js';
import { loadCollection, type StepCollector } from '../report/artifacts.js';
import { ArtifactCollection, StepOutput, ValidationResult } from '../config/types.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface AdminTallyWorkflowResult {
  screenshots: string[];
  tallyReportPath?: string;
}

/**
 * Run the VxAdmin tally workflow - import CVRs and generate reports
 */
export async function runAdminTallyWorkflow(
  page: Page,
  screenshots: ScreenshotManager,
  electionPackagePath: string,
  outputDir: string,
  dataPath: string,
  stepCollector: StepCollector,
): Promise<AdminTallyWorkflowResult> {
  logger.step('Running VxAdmin tally workflow');

  await page.setViewportSize({
    width: 1920,
    height: 1200,
  });
  const usbController = createMockUsbController({ dataPath });

  // Navigate to app
  await navigateToApp(page);
  await toggleDevDock(page);
  const s1 = await screenshots.capture('admin-tally-locked', 'VxAdmin locked (before tally)');
  stepCollector.addScreenshot(s1);

  // Ensure USB is inserted with CVRs
  logger.debug('Inserting USB drive with CVRs');
  await usbController.insert();
  await page.waitForTimeout(1000);

  // Log in as election manager
  await dipElectionManagerCardAndLogin(page, electionPackagePath);
  const s2 = await screenshots.capture('admin-tally-logged-in', 'Logged in as Election Manager');
  stepCollector.addScreenshot(s2);

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
  const s3 = await screenshots.capture('admin-tally-page', 'Tally page');
  stepCollector.addScreenshot(s3);

  // Look for CVR files on USB and import them
  logger.debug('Looking for CVR files to import');

  // Click the "Load CVRs" button
  await clickButtonWithDebug(page, 'Load CVRs', {
    timeout: 10000,
    outputDir,
    label: 'Clicking Load CVRs button',
  });

  await page.waitForTimeout(1000);
  const s4 = await screenshots.capture('admin-tally-load-cvr-dialog', 'Load CVR dialog');
  stepCollector.addScreenshot(s4);

  // Find and click the Load button in the modal table for the first CVR file
  // Each row in the table has a "Load" button (or "Loaded" if already imported)
  const modal = page.locator('[role="alertdialog"]');
  const loadButtons = modal.getByRole('button', { name: 'Load', exact: true });

  const loadButtonCount = await loadButtons.count();
  logger.debug(`Found ${loadButtonCount} Load buttons in CVR modal`);

  if (loadButtonCount > 0) {
    // Click the first Load button
    await loadButtons.first().click();

    // Wait for success message "X New CVR Loaded" or "X New CVRs Loaded"
    await waitForTextWithDebug(page, 'New CVR', {
      timeout: 30000,
      outputDir,
      label: 'Waiting for CVRs to be loaded',
    });

    const s5 = await screenshots.capture(
      'admin-tally-cvrs-loaded-success',
      'CVRs loaded successfully',
    );
    stepCollector.addScreenshot(s5);

    // Close the modal
    await page.getByRole('button', { name: 'Close' }).click();
  } else {
    logger.warn('No Load buttons found in CVR modal - CVRs may already be loaded');
  }

  await page.waitForTimeout(1000);
  const s6 = await screenshots.capture('admin-tally-after-cvr-load', 'Tally page after CVR load');
  stepCollector.addScreenshot(s6);

  // Navigate to Reports section
  logger.debug('Navigating to Reports section');

  await clickTextInApp(page, 'Reports');

  await page.waitForTimeout(1000);
  const s7 = await screenshots.capture('admin-reports-page', 'Reports page');
  stepCollector.addScreenshot(s7);

  // Generate tally report by clicking the link
  logger.debug('Generating tally report');

  await clickTextInApp(page, 'Full Election Tally Report');

  await page.waitForTimeout(2000);
  const s8 = await screenshots.capture('admin-tally-report-preview', 'Tally report preview');
  stepCollector.addScreenshot(s8);

  // Export the report as PDF
  logger.debug('Exporting tally report as PDF');

  await clickTextInApp(page, 'Export Report PDF');

  // Wait for the save dialog to appear and click Save
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Save' }).click();

  // Wait for the PDF to be exported to USB
  await page.waitForTimeout(3000);

  const s9 = await screenshots.capture('admin-tally-report-exported', 'Tally report exported');
  stepCollector.addScreenshot(s9);

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

  // Lock machine before logging out
  logger.debug('Locking machine');

  await clickTextInApp(page, 'Lock Machine');

  await page.waitForTimeout(500);

  const s10 = await screenshots.capture('admin-tally-logged-out', 'Logged out after tally');
  stepCollector.addScreenshot(s10);

  // Remove USB
  await usbController.remove();

  return {
    screenshots: screenshots.getAll().map((s) => s.path),
    tallyReportPath: exportedPdfPath,
  };
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

/**
 * Validate tally results against scanned ballots
 */
export async function validateTallyResults(
  collection: ArtifactCollection,
): Promise<ValidationResult> {
  try {
    let tallyCsvOutput: Extract<StepOutput, { type: 'report' }> | undefined;

    // Get votes from accepted scan results stored in step outputs
    const expectedVotes: Record<string, Record<string, number>> = {}; // contestId -> optionId -> count
    let totalOutputs = 0;

    for (const step of collection.steps) {
      for (const output of step.outputs) {
        if (output.type === 'scan-result' && output.accepted && output.votes) {
          totalOutputs++;

          const votes = output.votes;
          for (const [contestId, contestVotes] of Object.entries(votes)) {
            if (!expectedVotes[contestId]) {
              expectedVotes[contestId] = {};
            }
            for (const vote of contestVotes) {
              const optionId = typeof vote === 'string' ? vote : vote.id;
              expectedVotes[contestId][optionId] = (expectedVotes[contestId][optionId] || 0) + 1;
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

    logger.debug(`Validation: processed ${totalOutputs} scanned sheets`);

    // Parse CSV to get actual vote counts by selection ID
    // CSV format: Contest,Contest ID,Selection,Selection ID,Total Votes
    const csvContent = await readFile(tallyCsvOutput.path, 'utf-8');
    const lines = csvContent.trim().split('\n');

    const actualVotes: Record<string, number> = {}; // selectionId -> count
    let totalExpectedVotes = 0;
    let totalActualVotes = 0;

    for (let i = 2; i < lines.length; i += 1) {
      // Skip header row at index 1
      const line = lines[i];
      if (!line.trim()) continue;

      const fields = line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
      if (fields.length >= 5) {
        const selectionId = fields[3];
        const votes = parseInt(fields[4] || '0', 10);

        if (!isNaN(votes) && selectionId !== 'overvotes' && selectionId !== 'undervotes') {
          actualVotes[selectionId] = votes;
          if (votes > 0) {
            totalActualVotes += votes;
          }
        }
      }
    }

    // Count expected votes
    for (const contest of Object.values(expectedVotes)) {
      for (const count of Object.values(contest)) {
        totalExpectedVotes += count;
      }
    }

    // Compare expected vs actual votes by candidate
    const mismatches: string[] = [];

    for (const [contestId, candidates] of Object.entries(expectedVotes)) {
      for (const [candidateId, expectedCount] of Object.entries(candidates)) {
        const actualCount = actualVotes[candidateId] || 0;
        if (actualCount !== expectedCount) {
          mismatches.push(
            `Contest ${contestId}, Candidate ${candidateId}: expected ${expectedCount}, got ${actualCount}`,
          );
        }
      }
    }

    // Check for votes in CSV that weren't expected
    for (const [selectionId, actualCount] of Object.entries(actualVotes)) {
      if (actualCount > 0) {
        let found = false;
        for (const candidates of Object.values(expectedVotes)) {
          if (candidates[selectionId]) {
            found = true;
            break;
          }
        }
        if (!found) {
          mismatches.push(`Unexpected votes in CSV for ${selectionId}: ${actualCount}`);
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
