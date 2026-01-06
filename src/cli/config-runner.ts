/**
 * Config file mode execution
 */

import { logger, formatDuration, printDivider } from '../utils/logger.js';
import { resolvePath } from '../utils/paths.js';
import type { QARunConfig } from '../config/types.js';

// Repository management
import { cloneOrUpdateRepo, getCurrentCommit } from '../repo/clone.js';
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
import { join } from 'node:path';
import { State } from '../repo/state.js';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

export interface RunOptions {
  headless?: boolean;
  limitBallots?: number;
}

/**
 * Run the QA workflow with the given configuration
 */
export async function runQAWorkflow(config: QARunConfig, options: RunOptions = {}): Promise<void> {
  const startTime = Date.now();
  const collector = createArtifactCollector(config.output.directory, config);

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
        pattern: 'blank',
        pdfPath,
        expectedAccepted: ballot.ballotMode === 'official',
      });

      if (ballot.ballotMode === 'official') {
        ballotsToScan.push(
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            pattern: 'valid',
            pdfPath,
            expectedAccepted: true,
          },
          {
            ballotStyleId: ballot.ballotStyleId,
            ballotMode: ballot.ballotMode,
            pattern: 'overvote',
            pdfPath,
            expectedAccepted: false,
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

    const { browser, page } = await createBrowserSession({
      headless: options.headless ?? true,
    });
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

    const orchestrator = createAppOrchestrator(repoPath);
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

        await runScanWorkflow(
          repoPath,
          page,
          electionPackage,
          adminExportedPackage.path,
          electionPackagePath, // Use the extracted election package ZIP
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
      // Create step for tallying CVRs
      const tallyStep = collector.startStep(
        page,
        'tallying-cvrs',
        'Tallying CVRs in VxAdmin',
        'Import CVRs from VxScan and generate tally reports',
      );

      await runAdminTallyWorkflow(
        page,
        election,
        electionPackagePath,
        config.output.directory,
        dataPath,
        tallyStep,
      );

      tallyStep.complete();
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
