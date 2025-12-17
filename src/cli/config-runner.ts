/**
 * Config file mode execution
 */

import { logger, formatDuration, printDivider } from '../utils/logger.js';
import { resolvePath } from '../utils/paths.js';
import type { QARunConfig } from '../config/types.js';

// Repository management
import { cloneOrUpdateRepo, getCurrentCommit } from '../repo/clone.js';
import { bootstrapRepo, checkPnpmAvailable, checkNodeVersion } from '../repo/bootstrap.js';
import { clearAllState } from '../repo/state.js';

// Ballot generation
import { loadElection } from '../ballots/election-loader.js';
import { generateVotePatterns, hasOvervote } from '../ballots/vote-generator.js';
import { createPlaceholderBallot } from '../ballots/ballot-marker.js';
import { saveBallotArtifacts } from '../ballots/pdf-renderer.js';

// App orchestration
import { createAppOrchestrator, ensureNoAppsRunning } from '../apps/orchestrator.js';

// Browser automation
import { createBrowserSession } from '../automation/browser.js';
import { runAdminWorkflow } from '../automation/admin-workflow.js';
import { runScanWorkflow, type BallotToScan } from '../automation/scan-workflow.js';

// Reporting
import { createArtifactCollector } from '../report/artifacts.js';
import { generateHtmlReport } from '../report/html-generator.js';

export interface RunOptions {
  headless?: boolean;
}

/**
 * Run the QA workflow with the given configuration
 */
export async function runQAWorkflow(
  config: QARunConfig,
  options: RunOptions = {}
): Promise<void> {
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
    await clearAllState(repoPath);

    // Phase 3: Load election
    printDivider();
    logger.step('Phase 3: Loading Election');

    const electionPackage = await loadElection(config.election.source);
    const { election } = electionPackage.electionDefinition;

    logger.info(`Election: ${election.title}`);
    logger.info(`Ballot styles: ${election.ballotStyles.length}`);
    logger.info(`Contests: ${election.contests.length}`);

    // Phase 4: Generate ballots
    printDivider();
    logger.step('Phase 4: Generating Ballots');

    const ballotsToScan: BallotToScan[] = [];

    for (const ballotStyle of election.ballotStyles) {
      logger.info(`Generating ballots for style: ${ballotStyle.id}`);

      const votesMap = generateVotePatterns(
        election,
        ballotStyle.id,
        config.ballots.patterns
      );

      for (const [pattern, votes] of votesMap) {
        // Generate ballot (using placeholder for now)
        const pdfBytes = await createPlaceholderBallot(
          ballotStyle.id,
          pattern,
          votes
        );

        // Save artifacts
        const artifacts = await saveBallotArtifacts(
          pdfBytes,
          collector.getBallotsDir(),
          ballotStyle.id,
          pattern
        );

        collector.addBallot({
          ballotStyleId: ballotStyle.id,
          pattern,
          pdfPath: artifacts.pdfPath,
          pngPaths: artifacts.pngPaths,
        });

        // Add to scan list
        ballotsToScan.push({
          ballotStyleId: ballotStyle.id,
          pattern,
          pdfPath: artifacts.pdfPath,
          expectedAccepted: !hasOvervote(votes, election.contests),
        });
      }
    }

    logger.success(`Generated ${ballotsToScan.length} ballots`);

    // Phase 5: Run VxAdmin workflow
    printDivider();
    logger.step('Phase 5: VxAdmin Configuration');

    const orchestrator = createAppOrchestrator(repoPath);
    await orchestrator.startApp('admin');

    const { browser, page } = await createBrowserSession({
      headless: options.headless ?? true,
    });

    let exportedPackagePath: string;

    try {
      const adminResult = await runAdminWorkflow(
        page,
        resolvePath(config.election.source),
        config.output.directory
      );
      exportedPackagePath = adminResult.exportedPackagePath;
    } finally {
      await orchestrator.stopApp();
    }

    // Phase 6: Run VxScan workflow
    printDivider();
    logger.step('Phase 6: VxScan Scanning');

    await orchestrator.startApp('scan');

    try {
      const scanResult = await runScanWorkflow(
        page,
        exportedPackagePath,
        resolvePath(config.election.source),
        ballotsToScan,
        config.output.directory
      );

      collector.addScanResults(scanResult.scanResults);
    } finally {
      await orchestrator.stopApp();
      await browser.close();
    }

    // Phase 7: Generate report
    printDivider();
    logger.step('Phase 7: Generating Report');

    collector.complete();
    const reportPath = await generateHtmlReport(
      collector.getCollection(),
      config.output.directory
    );

    // Summary
    printDivider();
    const duration = formatDuration(Date.now() - startTime);
    logger.success(`QA workflow completed in ${duration}`);
    logger.info(`Report: ${reportPath}`);
    logger.info(`Output: ${config.output.directory}`);

    // Print scan summary
    const results = collector.getCollection().scanResults;
    const accepted = results.filter((r) => r.accepted).length;
    const rejected = results.filter((r) => !r.accepted).length;
    logger.info(`Scan results: ${accepted} accepted, ${rejected} rejected`);

  } catch (error) {
    if (error instanceof Error) {
      collector.logError(error, 'workflow');
    }

    // Generate partial report on error
    collector.complete();
    try {
      await generateHtmlReport(
        collector.getCollection(),
        config.output.directory
      );
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
    throw new Error(
      `Node.js ${nodeVersion.required}+ required, found ${nodeVersion.current}`
    );
  }
  logger.debug(`Node.js ${nodeVersion.current} is compatible`);

  logger.success('Pre-flight checks passed');
}
