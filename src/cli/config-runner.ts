/**
 * Config file mode execution
 */

import { logger, formatDuration, printDivider } from '../utils/logger.js';
import { resolvePath } from '../utils/paths.js';
import type { QARunConfig } from '../config/types.js';
import { existsSync } from 'fs';

// Repository management
import { cloneOrUpdateRepo, getCurrentCommit, applyPatch } from '../repo/clone.js';
import { bootstrapRepo, checkPnpmAvailable, checkNodeVersion } from '../repo/bootstrap.js';

// Election package loading
import { getBallotStylesForPrecinct, loadElectionPackage } from '../ballots/election-loader.js';

// App orchestration
import { createAppOrchestrator, ensureNoAppsRunning } from '../apps/orchestrator.js';

// Browser automation
import { createBrowserSession } from '../automation/browser.js';
import { runAdminConfigureWorkflow } from '../automation/admin-workflow.js';
import { runScanWorkflow, type BallotToScan } from '../automation/scan-workflow.js';
import { runAdminTallyWorkflow } from '../automation/admin-tally-workflow.js';

// Reporting
import { createArtifactCollector } from '../report/artifacts.js';
import { generateHtmlReport } from '../report/html-generator.js';
import { join, dirname } from 'node:path';
import { State } from '../repo/state.js';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import type { AppOrchestrator } from '../apps/orchestrator.js';
import { fileURLToPath } from 'node:url';

export interface RunOptions {
  headless?: boolean;
  limitBallots?: number;
  limitManualTallies?: number;
}

/**
 * Get the project root directory (where vxsuite.patch is located)
 */
function getProjectRoot(): string {
  // Get the directory of this source file
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);
  // Go up from src/cli/config-runner.ts to project root
  return join(dirname(currentFilePath), '..', '..');
}

/**
 * Run the QA workflow with the given configuration
 */
export async function runQAWorkflow(config: QARunConfig, options: RunOptions = {}): Promise<void> {
  const startTime = Date.now();
  const collector = createArtifactCollector(config.output.directory, config);
  let orchestrator: AppOrchestrator | null = null;
  let browser: Awaited<ReturnType<typeof createBrowserSession>>['browser'] | null = null;

  // Set up signal handlers to ensure clean shutdown
  const handleShutdown = async (signal: string) => {
    logger.info(`\nReceived ${signal}, cleaning up...`);
    try {
      if (orchestrator?.isRunning()) {
        await orchestrator.stopApp();
      }
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      logger.error(`Error during cleanup: ${(error as Error).message}`);
    }
    process.exit(1);
  };

  const sigintHandler = () => void handleShutdown('SIGINT');
  const sigtermHandler = () => void handleShutdown('SIGTERM');

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // Set up log file in the run directory
  const logFilePath = join(config.output.directory, 'run.log');
  logger.setLogFile(logFilePath);

  logger.step('Starting VxSuite QA automation');
  logger.info(`Output directory: ${config.output.directory}`);

  try {
    // Pre-flight checks
    await runPreflightChecks();

    // Ensure no apps are running
    await ensureNoAppsRunning();

    // Phase 1: Repository setup
    printDivider();
    logger.step('Phase 1: Repository Setup');

    const repoPath = await cloneOrUpdateRepo(config.vxsuite);
    const commit = await getCurrentCommit(repoPath);
    logger.info(`Repository at ${repoPath} (commit: ${commit.slice(0, 8)})`);

    // Apply patch if it exists (look in project root, not CWD)
    const projectRoot = getProjectRoot();
    const patchPath = join(projectRoot, 'vxsuite.patch');
    if (existsSync(patchPath)) {
      logger.info(`Applying patch from ${patchPath}`);
      await applyPatch(repoPath, patchPath);
    }

    await bootstrapRepo(repoPath);

    // Phase 2: Clear state
    printDivider();
    logger.step('Phase 2: Clearing State');
    const state = State.defaultFor(repoPath);
    await state.clear();

    // Phase 3: Load election package and ballots
    printDivider();
    logger.step('Phase 3: Loading Election Package');

    const electionSourcePath = resolvePath(config.election.source, config.basePath);
    const { electionPackage, electionPackagePath } = await loadElectionPackage(
      electionSourcePath,
      collector.getBallotsDir(),
    );
    assert(
      electionPackage.systemSettings['disallowCastingOvervotes'],
      `System setting 'disallowCastingOvervotes' must be true`,
    );

    const { election } = electionPackage.electionDefinition;

    logger.info(`Election: ${election.title}`);
    logger.info(`Ballot styles: ${election.ballotStyles.length}`);
    logger.info(`Contests: ${election.contests.length}`);
    logger.info(`Ballot PDFs loaded: ${electionPackage.ballots.length}`);

    // Phase 4: Prepare ballots for scanning
    printDivider();
    logger.step('Phase 4: Preparing Ballots');

    const ballotsToScan: BallotToScan[] = [];
    const ballotsPath = join(config.output.directory, 'ballots');

    for (const ballot of electionPackage.ballots) {
      logger.info(
        `Prepared ballot: ${ballot.ballotStyleId}/${ballot.precinctId}/${ballot.ballotMode}/${ballot.ballotType}`,
      );

      const pdfName =
        `ballot-${ballot.ballotStyleId}-${ballot.precinctId}-${ballot.ballotMode}-${ballot.ballotType}.pdf`.replace(
          /[/ ]/g,
          '_',
        );
      const pdfPath = join(ballotsPath, pdfName);

      await writeFile(pdfPath, ballot.pdfData);

      collector.addBallot({
        ballotStyleId: ballot.ballotStyleId,
        precinctId: ballot.precinctId,
        ballotType: ballot.ballotType,
        ballotMode: ballot.ballotMode,
        pdfPath,
      });

      ballotsToScan.push({
        ballotStyleId: ballot.ballotStyleId,
        ballotMode: ballot.ballotMode,
        ballotType: ballot.ballotType,
        pattern: 'blank',
        pdfPath,
        expectedAccepted: ballot.ballotMode === 'official',
      });

      if (ballot.ballotMode === 'official') {
        ballotsToScan.push(
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            ballotType: ballot.ballotType,
            pattern: 'valid',
            pdfPath,
            expectedAccepted: true,
          },
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            ballotType: ballot.ballotType,
            pattern: 'overvote',
            pdfPath,
            expectedAccepted: false,
          },
        );

        ballotsToScan.push(
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            ballotType: ballot.ballotType,
            pattern: 'marked-write-in',
            pdfPath,
            expectedAccepted: true,
          },
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            ballotType: ballot.ballotType,
            pattern: 'unmarked-write-in',
            pdfPath,
            expectedAccepted: true,
          },
        );
      }
    }

    // Apply ballot limit if specified
    if (options.limitBallots && options.limitBallots > 0) {
      const originalCount = ballotsToScan.length;
      ballotsToScan.splice(options.limitBallots);
      logger.info(`Limited ballots from ${originalCount} to ${ballotsToScan.length} for testing`);
    }

    logger.success(`Prepared ${ballotsToScan.length} ballots for scanning`);

    // Phase 5: Run VxAdmin workflow
    printDivider();
    logger.step('Phase 5: VxAdmin Configuration');

    const browserSession = await createBrowserSession({
      headless: options.headless ?? true,
    });
    browser = browserSession.browser;
    const { page } = browserSession;
    const adminStep = collector.startStep(
      page,
      'programming-vxadmin',
      'Programming VxAdmin',
      'Configure VxAdmin with the election package and export election package for VxScan',
    );

    adminStep.addInput({
      type: 'election-package',
      label: 'Election Package',
      description: `${election.title}`,
      path: electionPackagePath,
    });

    orchestrator = createAppOrchestrator(repoPath);
    await orchestrator.startApp('admin');

    // FIXME: It'd be nice to not need to hardcode this as the mock USB drive data location.
    // Perhaps the dev dock API could offer a way to add files, or we'd use a mocking approach
    // that happens more at the Linux system level.
    const dataPath = join(config.vxsuite.repoPath, 'libs/usb-drive/dev-workspace/mock-usb-data');

    try {
      await runAdminConfigureWorkflow(
        page,
        electionPackagePath, // Use the extracted election package ZIP
        config.output.directory,
        dataPath,
        adminStep,
      );
      adminStep.complete();
    } finally {
      await orchestrator.stopApp();
    }

    // Phase 6: Run VxScan workflow
    printDivider();
    logger.step('Phase 6: VxScan Scanning');

    await orchestrator.startApp('scan');

    const ballotsToScanByPrecinct = new Map(
      election.precincts.map((p) => {
        const ballotStyleIds = getBallotStylesForPrecinct(election, p.id).map((bs) => bs.id);
        return [p, ballotsToScan.filter((b) => ballotStyleIds.includes(b.ballotStyleId))] as const;
      }),
    );

    try {
      for (const [precinct, precinctBallotsToScan] of ballotsToScanByPrecinct) {
        // Create step for opening polls
        const openingPollsStep = collector.startStep(
          page,
          'opening-polls',
          'Opening Polls',
          `Configure VxScan and open the polls for voting in precinct "${precinct.name}"`,
        );

        const adminExportedPackage = adminStep
          .getOutputs()
          .find((output) => output.type === 'election-package');

        if (!adminExportedPackage) {
          throw new Error('VxAdmin did not export an election package');
        }

        openingPollsStep.addInput({
          type: 'election-package',
          label: 'Election Package',
          description: `${election.title}`,
          path: adminExportedPackage.path,
        });

        const otherPrecinctAndBallotsToScan = [...ballotsToScanByPrecinct].find(
          ([otherPrecinct]) => otherPrecinct.id !== precinct.id,
        );

        if (otherPrecinctAndBallotsToScan) {
          // Add a ballot from another precinct to ensure it's rejected.
          const ballotToScan = otherPrecinctAndBallotsToScan[1].find((b) => b.expectedAccepted);

          if (ballotToScan) {
            precinctBallotsToScan.push({
              ...ballotToScan,
              expectedAccepted: false,
            });
          }
        } else {
          assert(election.precincts.length === 1);
        }

        await runScanWorkflow(
          repoPath,
          page,
          electionPackage,
          adminExportedPackage.path,
          electionPackagePath, // Use the extracted election package ZIP
          { kind: 'SinglePrecinct', precinctId: precinct.id },
          precinctBallotsToScan,
          config.output.directory,
          dataPath,
          openingPollsStep,
          collector, // Pass the collector so steps can be created on-demand
        );
      }
    } finally {
      await orchestrator.stopApp();
    }

    // Phase 7: Run VxAdmin Tally Workflow
    printDivider();
    logger.step('Phase 7: VxAdmin Tally');

    await orchestrator.startApp('admin');

    try {
      await runAdminTallyWorkflow(
        page,
        election,
        electionPackagePath,
        config.output.directory,
        dataPath,
        collector,
        options.limitManualTallies,
      );
    } finally {
      await orchestrator.stopApp();
      await browser.close();
    }

    // Phase 8: Copy Workspaces
    printDivider();
    logger.step('Phase 8: Copy Workspaces');
    await state.copyWorkspacesTo(join(collector.getOutputDir(), 'workspaces'));

    // Phase 9: Generate report
    printDivider();
    logger.step('Phase 9: Generating Report');

    collector.complete();
    const reportPath = await generateHtmlReport(collector.getCollection(), config.output.directory);

    // Summary
    printDivider();
    const duration = formatDuration(Date.now() - startTime);
    logger.success(`QA workflow completed in ${duration}`);
    logger.info(`Report: ${reportPath}`);
    logger.info(`Output: ${config.output.directory}`);

    // Print scan summary
    const results = collector
      .getCollection()
      .steps.flatMap((step) => step.outputs.filter((output) => output.type === 'scan-result'));
    const accepted = results.filter((r) => r.accepted).length;
    const rejected = results.filter((r) => !r.accepted).length;
    logger.info(`Scan results: ${accepted} accepted, ${rejected} rejected`);

    // Open the report in the default browser
    if (reportPath) {
      // Spawn detached process so it doesn't block
      spawn('open', [reportPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } catch (error) {
    if (error instanceof Error) {
      collector.logError(error, 'workflow');
    }

    // Generate partial report on error
    collector.complete();
    try {
      await generateHtmlReport(collector.getCollection(), config.output.directory);
    } catch {
      // Ignore report generation errors
    }

    throw error;
  } finally {
    // Clean up signal handlers
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  }
}

/**
 * Run pre-flight checks
 */
async function runPreflightChecks(): Promise<void> {
  logger.step('Running pre-flight checks');

  // Check pnpm
  const pnpmAvailable = await checkPnpmAvailable();
  if (!pnpmAvailable) {
    throw new Error('pnpm is not available. Please install pnpm: npm install -g pnpm');
  }
  logger.debug('pnpm is available');

  // Check Node.js version
  const nodeVersion = await checkNodeVersion();
  if (!nodeVersion.compatible) {
    throw new Error(`Node.js ${nodeVersion.required}+ required, found ${nodeVersion.current}`);
  }
  logger.debug(`Node.js ${nodeVersion.current} is compatible`);

  logger.success('Pre-flight checks passed');
}
