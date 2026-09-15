/**
 * Config file mode execution
 */

import { logger, formatDuration, printDivider } from '../utils/logger.ts';
import { resolvePath } from '../utils/paths.ts';
import type { QARunConfig, WebhookConfig } from '../config/types.ts';
import { getVersionSpec, type VxSuiteVersion } from '../config/versions.ts';
import { determineTallyMode } from '../config/tally-mode.ts';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';

// Repository management
import { cloneOrUpdateRepo, getCurrentCommit, applyPatch } from '../repo/clone.ts';
import {
  bootstrapRepo,
  checkPnpmVersion,
  checkNodeVersion,
  installPlaywrightBrowsers,
} from '../repo/bootstrap.ts';

// Election package loading
import { applySystemSettingsOverrides, loadElectionPackage } from '../ballots/election-loader.ts';

// App orchestration
import { createAppOrchestrator, ensureNoAppsRunning } from '../apps/orchestrator.ts';
import { MOCK_NODE_ENV } from '../apps/env-config.ts';

// Browser automation
import { createBrowserSession } from '../automation/browser.ts';
import {
  runAdminConfigureWorkflow,
  runAdminUnconfigureWorkflow,
} from '../automation/admin-workflow.ts';
import {
  runScanWorkflow,
  scannerAcceptedPrecinctIds,
  type BallotToScan,
} from '../automation/scan-workflow.ts';
import { planBallotsToScan, scanExpectationsFromSystemSettings } from '../ballots/scan-plan.ts';
import { runAdminTallyWorkflow } from '../automation/admin-tally-workflow.ts';
import { createMockUsbController } from '../mock-hardware/usb.ts';

// Proof ballot generation
import { generateProofBallot } from '../ballots/proof-ballot.ts';
import type { Election, Precinct } from '../ballots/election-loader.ts';

// Reporting
import { createArtifactCollector, PROOF_PREFIX } from '../report/artifacts.ts';
import { generateHtmlReport } from '../report/html-generator.ts';
import { join, dirname } from 'node:path';
import { sendWebhookUpdate } from '../webhook/client.ts';
import { State } from '../repo/state.ts';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { AppOrchestrator } from '../apps/orchestrator.ts';
import { fileURLToPath } from 'node:url';

export interface RunOptions {
  headless?: boolean;
  limitBallots?: number;
  limitManualTallies?: number;
  webhook?: WebhookConfig;
}

/**
 * Construct a CircleCI artifacts URL for the report, if running in CI.
 */
function buildResultsUrl(reportPath: string): string | undefined {
  const jobId = process.env.CIRCLE_WORKFLOW_JOB_ID;
  if (!jobId) {
    return undefined;
  }
  const projectRoot = getProjectRoot();
  const relativePath = relative(projectRoot, reportPath);
  return `https://output.circle-artifacts.com/output/job/${jobId}/artifacts/0/${relativePath}`;
}

/**
 * Get the project root directory (where the vxsuite-*.patch files are located)
 */
function getProjectRoot(): string {
  // Get the directory of this source file
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);
  // Go up from src/cli/config-runner.ts to project root
  return join(dirname(currentFilePath), '..', '..');
}

/**
 * A ballot VxScan should return as "Wrong Precinct" while scoped to
 * `precinct`: a would-be-accepted ballot from a precinct outside the scanner's
 * location. `undefined` when every precinct's ballots are accepted there, e.g.
 * a single-precinct election or a v4.1 polling place covering every precinct.
 */
function wrongPrecinctBallotFor(
  version: VxSuiteVersion,
  election: Election,
  precinct: Precinct,
  ballotsToScanByPrecinct: ReadonlyMap<Precinct, readonly BallotToScan[]>,
): BallotToScan | undefined {
  const acceptedPrecinctIds = scannerAcceptedPrecinctIds(version, election, precinct.id);

  for (const [otherPrecinct, otherBallots] of ballotsToScanByPrecinct) {
    if (acceptedPrecinctIds.has(otherPrecinct.id)) continue;

    const ballot = otherBallots.find((b) => b.expectedAccepted);
    if (ballot) {
      return { ...ballot, expectedAccepted: false };
    }
  }

  if (election.precincts.length > 1) {
    logger.info(
      `Every precinct's ballots are accepted at the scanner location for "${precinct.name}"; ` +
        `skipping the wrong-precinct ballot`,
    );
  }
  return undefined;
}

/**
 * Run the QA workflow with the given configuration
 */
export async function runQAWorkflow(config: QARunConfig, options: RunOptions = {}): Promise<void> {
  const startTime = Date.now();
  const collector = await createArtifactCollector(config.output.directory, config);
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

  if (options.webhook) {
    await sendWebhookUpdate(options.webhook, 'in_progress', 'QA automation starting');
  }

  try {
    // Pre-flight checks
    await runPreflightChecks();

    // Ensure no apps are running
    await ensureNoAppsRunning();

    // Phase 1: Repository setup
    printDivider();
    logger.step('Phase 1: Repository Setup');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Setting up VxSuite repository');
    }

    const repoPath = await cloneOrUpdateRepo(config.vxsuite);
    const commit = await getCurrentCommit(repoPath);
    logger.info(`Repository at ${repoPath} (commit: ${commit.slice(0, 8)})`);

    // Apply the version-specific patch if it exists (look in project root, not CWD)
    const projectRoot = getProjectRoot();
    const { patchFile } = getVersionSpec(config.vxsuite.version);
    const patchPath = join(projectRoot, patchFile);
    if (existsSync(patchPath)) {
      logger.info(`Applying patch from ${patchPath}`);
      await applyPatch(repoPath, patchPath);
    } else {
      throw new Error(`Patch file not found for version ${config.vxsuite.version}: ${patchPath}`);
    }

    await bootstrapRepo(repoPath, commit);
    await installPlaywrightBrowsers(repoPath);

    // Phase 2: Clear state
    printDivider();
    logger.step('Phase 2: Clearing State');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Clearing previous run state');
    }
    const state = State.defaultFor(repoPath);
    await state.clear();

    // Phase 3: Load election package and ballots
    printDivider();
    logger.step('Phase 3: Loading Election Package');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Loading election package');
    }

    const electionSourcePath = resolvePath(config.election.source, config.basePath);
    const { electionPackage, electionPackagePath } = await loadElectionPackage(
      electionSourcePath,
      collector.getBallotsDir(),
    );

    // Apply any systemSettings overrides to the package VxAdmin will load (and
    // re-export to VxScan), so a single package can exercise different behaviors.
    // VxScan blocks closing the polls in official mode until the package's
    // `electionDayPollsCloseTime`, which a QA run can't wait for, so runs would
    // pass or fail based on the time of day they start. Off unless the config
    // asks for it.
    const systemSettingsOverrides = {
      disallowClosingPollsBeforeElectionDayPollsCloseTime: false,
      ...config.election.systemSettingsOverrides,
    };
    logger.info(`Applying systemSettings overrides: ${JSON.stringify(systemSettingsOverrides)}`);
    electionPackage.systemSettings = await applySystemSettingsOverrides(
      electionPackagePath,
      systemSettingsOverrides as Record<string, unknown>,
    );

    const { election } = electionPackage.electionDefinition;

    // Which ballots VxScan returns to the voter for review (vs. counts) depends
    // on the election's precinct-scan adjudication reasons and whether
    // overvotes may be cast. This drives which marked variants of each ballot
    // we scan and the outcome we expect for each.
    const scanExpectations = scanExpectationsFromSystemSettings(electionPackage.systemSettings);
    const precinctScanAdjudicationReasons = Array.isArray(
      electionPackage.systemSettings['precinctScanAdjudicationReasons'],
    )
      ? (electionPackage.systemSettings['precinctScanAdjudicationReasons'] as string[])
      : [];

    if (scanExpectations.disallowCastingOvervotes && !scanExpectations.overvoteRequiresReview) {
      logger.warn(
        `'disallowCastingOvervotes' is set but 'Overvote' is not a precinct-scan adjudication ` +
          `reason, so VxScan will count overvoted ballots without review`,
      );
    }

    logger.info(`Election: ${election.title}`);
    logger.info(`Ballot styles: ${election.ballotStyles.length}`);
    logger.info(`Contests: ${election.contests.length}`);
    logger.info(`Ballot PDFs loaded: ${electionPackage.ballots.length}`);
    logger.info(
      `Precinct-scan adjudication reasons: ${
        precinctScanAdjudicationReasons.join(', ') || '(none)'
      }`,
    );
    logger.info(
      `Casting overvotes: ${scanExpectations.disallowCastingOvervotes ? 'disallowed' : 'allowed'}`,
    );

    // tallyMode controls whether VxAdmin tallies every precinct's CVRs
    // together ('consolidated') or cycles through each precinct separately
    // ('per-precinct', for NH "city" elections). Auto-detected from the
    // loaded election when not set explicitly in config.
    const tallyMode = config.tallyMode ?? determineTallyMode(election);
    logger.info(`Tally mode: ${tallyMode}${config.tallyMode ? '' : ' (auto-detected)'}`);

    // Phase 4: Prepare ballots for scanning
    printDivider();
    logger.step('Phase 4: Preparing Ballots');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Preparing ballots for scanning');
    }

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

      const proofPdfName = `${PROOF_PREFIX}${pdfName}`;
      const proofPdfPath = join(ballotsPath, proofPdfName);
      const proofPdfBytes = await generateProofBallot(
        election,
        ballot.ballotStyleId,
        ballot.pdfData,
      );
      await writeFile(proofPdfPath, proofPdfBytes);

      collector.addBallot({
        ballotStyleId: ballot.ballotStyleId,
        precinctId: ballot.precinctId,
        ballotType: ballot.ballotType,
        ballotMode: ballot.ballotMode,
        pdfPath,
      });

      ballotsToScan.push(...planBallotsToScan(ballot, pdfPath, scanExpectations));
    }

    // Apply ballot limit if specified
    if (options.limitBallots && options.limitBallots > 0) {
      const originalCount = ballotsToScan.length;
      ballotsToScan.splice(options.limitBallots);
      logger.info(`Limited ballots from ${originalCount} to ${ballotsToScan.length} for testing`);
    }

    logger.success(`Prepared ${ballotsToScan.length} ballots for scanning`);

    // Phase 5-7: Run VxAdmin + VxScan workflows, either as one consolidated
    // tally (default) or as a separate cycle per precinct (NH "city" elections).
    const browserSession = await createBrowserSession({
      headless: options.headless ?? true,
    });
    browser = browserSession.browser;
    const { page } = browserSession;

    // FIXME: It'd be nice to not need to hardcode this as the mock USB drive data location.
    // Perhaps the dev dock API could offer a way to add files, or we'd use a mocking approach
    // that happens more at the Linux system level.
    // VxSuite stores mock USB data under <repo>/.mock-state/<NODE_ENV>/ (see
    // getMockStateRootDir + file_usb_drive.ts). The subdirectory is version-specific:
    // v4.1 nests the drive under a disk name (usb-drive/sdb/...), v4.0 does not.
    const dataPath = join(
      repoPath,
      '.mock-state',
      MOCK_NODE_ENV,
      getVersionSpec(config.vxsuite.version).mockUsbDataDir,
    );

    try {
      if (tallyMode === 'consolidated') {
        // Phase 5: VxAdmin Configuration
        printDivider();
        logger.step('Phase 5: VxAdmin Configuration');
        if (options.webhook) {
          await sendWebhookUpdate(
            options.webhook,
            'in_progress',
            'Configuring VxAdmin with election package',
          );
        }

        const adminStep = await collector.startStep(
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

        orchestrator = createAppOrchestrator(repoPath, config.output.directory);
        await orchestrator.startApp('admin');

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
        if (options.webhook) {
          await sendWebhookUpdate(options.webhook, 'in_progress', 'Scanning ballots with VxScan');
        }

        await orchestrator.startApp('scan');

        const ballotsToScanByPrecinct = new Map(
          election.precincts.map((precinct) => [
            precinct,
            ballotsToScan.filter((ballot) => ballot.precinctId === precinct.id),
          ]),
        );

        try {
          for (const [precinct, precinctBallotsToScan] of ballotsToScanByPrecinct) {
            // Create step for opening polls
            const openingPollsStep = await collector.startStep(
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

            const wrongPrecinctBallot = wrongPrecinctBallotFor(
              config.vxsuite.version,
              election,
              precinct,
              ballotsToScanByPrecinct,
            );
            if (wrongPrecinctBallot) {
              precinctBallotsToScan.push(wrongPrecinctBallot);
            }

            await runScanWorkflow(
              repoPath,
              config.vxsuite.version,
              page,
              electionPackage,
              adminExportedPackage.path,
              electionPackagePath, // Use the extracted election package ZIP
              precinct.id,
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
        if (options.webhook) {
          await sendWebhookUpdate(
            options.webhook,
            'in_progress',
            'Importing CVRs and validating tallies',
          );
        }

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
        }
      } else {
        // Phase 5-7: Per-Precinct VxAdmin/VxScan Cycles. Each precinct gets its
        // own configure -> scan -> import -> tally -> report -> unconfigure
        // cycle, run sequentially, for elections where each precinct (e.g. an
        // NH city's ward) is its own reporting unit.
        printDivider();
        logger.step('Phase 5-7: Per-Precinct VxAdmin/VxScan Cycles');
        if (options.webhook) {
          await sendWebhookUpdate(
            options.webhook,
            'in_progress',
            'Running per-precinct VxAdmin/VxScan cycles',
          );
        }

        orchestrator = createAppOrchestrator(repoPath, config.output.directory);

        const ballotsToScanByPrecinct = new Map(
          election.precincts.map((precinct) => [
            precinct,
            ballotsToScan.filter((ballot) => ballot.precinctId === precinct.id),
          ]),
        );

        for (const [precinct, precinctBallotsToScan] of ballotsToScanByPrecinct) {
          logger.step(`Precinct: ${precinct.name}`);

          // Configure VxAdmin
          const adminStep = await collector.startStep(
            page,
            `programming-vxadmin-${precinct.id}`,
            `Programming VxAdmin (${precinct.name})`,
            'Configure VxAdmin with the election package and export election package for VxScan',
          );

          adminStep.addInput({
            type: 'election-package',
            label: 'Election Package',
            description: `${election.title}`,
            path: electionPackagePath,
          });

          await orchestrator.startApp('admin');
          try {
            await runAdminConfigureWorkflow(
              page,
              electionPackagePath,
              config.output.directory,
              dataPath,
              adminStep,
            );
            adminStep.complete();
          } finally {
            await orchestrator.stopApp();
          }

          // Scan this precinct's ballots
          const openingPollsStep = await collector.startStep(
            page,
            `opening-polls-${precinct.id}`,
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

          const wrongPrecinctBallot = wrongPrecinctBallotFor(
            config.vxsuite.version,
            election,
            precinct,
            ballotsToScanByPrecinct,
          );
          if (wrongPrecinctBallot) {
            precinctBallotsToScan.push(wrongPrecinctBallot);
          }

          await orchestrator.startApp('scan');
          try {
            await runScanWorkflow(
              repoPath,
              config.vxsuite.version,
              page,
              electionPackage,
              adminExportedPackage.path,
              electionPackagePath,
              precinct.id,
              precinctBallotsToScan,
              config.output.directory,
              dataPath,
              openingPollsStep,
              collector,
            );
          } finally {
            await orchestrator.stopApp();
          }

          // Import this precinct's CVRs, tally, generate its own report, then
          // unconfigure VxAdmin so the next precinct starts from a clean slate
          // (restarting the process alone does not reset VxAdmin's state).
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
              precinct.id,
            );

            const unconfiguringStep = await collector.startStep(
              page,
              `unconfiguring-vxadmin-${precinct.id}`,
              'Unconfiguring VxAdmin',
              `Unconfigure VxAdmin to prepare for the next precinct after "${precinct.name}"`,
            );
            await runAdminUnconfigureWorkflow(
              page,
              electionPackagePath,
              config.output.directory,
              unconfiguringStep,
            );
            unconfiguringStep.complete();

            // Clear the shared mock USB so the next precinct's VxAdmin
            // doesn't see this precinct's already-imported CVR export. Done
            // here, before stopApp: the mock USB is served by the currently
            // running app's dev-dock, so this call has nothing to reach once
            // the admin app has been stopped.
            await createMockUsbController({ dataPath }).clear();
          } finally {
            await orchestrator.stopApp();
          }
        }
      }
    } finally {
      await browser.close();
    }

    // Phase 8: Copy Workspaces
    printDivider();
    logger.step('Phase 8: Copy Workspaces');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Copying app workspaces');
    }
    await state.copyWorkspacesTo(join(collector.getOutputDir(), 'workspaces'));

    // Phase 9: Generate report
    printDivider();
    logger.step('Phase 9: Generating Report');
    if (options.webhook) {
      await sendWebhookUpdate(options.webhook, 'in_progress', 'Generating QA report');
    }

    collector.complete();
    const { reportPath, pass } = await generateHtmlReport(
      collector.getCollection(),
      config.output.directory,
    );

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

    if (options.webhook && reportPath) {
      const resultsUrl = buildResultsUrl(reportPath);
      await sendWebhookUpdate(
        options.webhook,
        pass ? 'success' : 'failure',
        `QA ${pass ? 'passed' : 'failed'}: ${accepted} accepted, ${rejected} rejected`,
        resultsUrl,
      );
    }

    // Open the report in the default browser
    if (reportPath) {
      // Spawn detached process so it doesn't block
      spawn('open', [reportPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }

    // Exit with non-zero code if QA failed
    if (!pass) {
      logger.error('QA validation failed');
      process.exitCode = 1;
    }
  } catch (error) {
    if (options.webhook) {
      await sendWebhookUpdate(
        options.webhook,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
    }

    if (error instanceof Error) {
      collector.logError(error, 'workflow');
    }

    // Generate partial report on error
    collector.complete();
    try {
      await generateHtmlReport(collector.getCollection(), config.output.directory);
    } catch (reportError) {
      logger.error(
        `Failed to generate partial report: ${
          reportError instanceof Error ? (reportError.stack ?? reportError.message) : reportError
        }`,
      );
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

  // Check the pnpm running vx-qa; it switches to VxSuite's pinned pnpm itself.
  const pnpmVersion = await checkPnpmVersion();
  if (!pnpmVersion) {
    throw new Error('pnpm is not available. Please install pnpm: npm install -g pnpm');
  }
  if (!pnpmVersion.compatible) {
    throw new Error(
      `pnpm ${pnpmVersion.required}+ required to run vx-qa, found ${pnpmVersion.current}`,
    );
  }
  logger.debug(`vx-qa running on pnpm ${pnpmVersion.current}`);

  // Check the Node.js running vx-qa; VxSuite's own Node.js is resolved from
  // its checkout during bootstrap.
  const nodeVersion = checkNodeVersion();
  if (!nodeVersion.compatible) {
    throw new Error(
      `Node.js ${nodeVersion.required}+ required to run vx-qa, found ${nodeVersion.current}`,
    );
  }
  logger.debug(`vx-qa running on Node.js ${nodeVersion.current}`);

  logger.success('Pre-flight checks passed');
}
