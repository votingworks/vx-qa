#!/usr/bin/env node

/**
 * VxSuite QA Automation Tool
 *
 * CLI entry point for automating QA testing of VxSuite elections
 */

import { Command } from 'commander';
import { logger, printHeader } from './utils/logger.js';
import { validateConfig, safeValidateConfig } from './config/schema.js';
import { resolvePath, generateTimestampedDir, ensureDir } from './utils/paths.js';
import { runQAWorkflow } from './cli/config-runner.js';
import type { QARunConfig, WebhookConfig } from './config/types.js';
import { dirname, join } from 'node:path';
import { regenerateHtmlReportFromRawData } from './report/html-generator.js';
import { revalidateTallyResults } from './automation/admin-tally-workflow.js';
import { downloadFile } from './ballots/election-loader.js';
import { startServe } from './cli/serve.js';
import { readFile, writeFile } from 'node:fs/promises';

const program = new Command();

program
  .name('vx-qa')
  .description('VxSuite QA Automation Tool - Automates election QA testing')
  .version('1.0.0');

program
  .command('run')
  .description('Run QA automation workflow')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-o, --output <dir>', 'Override output directory')
  .option('-r, --ref <ref>', 'Override VxSuite tag/branch/ref')
  .option('-e, --election <path>', 'Override election source path')
  .option('--headless', 'Run browser in headless mode (default)')
  .option('--no-headless', 'Run browser in headed mode for debugging')
  .option('--limit-ballots <number>', 'Limit the number of ballots to scan (for testing)', parseInt)
  .option(
    '--limit-manual-tallies <number>',
    'Limit the number of ballot styles with manual tallies (for testing)',
    parseInt,
  )
  .option('--webhook-url <url>', 'URL for status callbacks')
  .option(
    '--webhook-secret <secret>',
    'Secret for webhook auth (default: $CIRCLECI_WEBHOOK_SECRET env var)',
  )
  .action(async (options) => {
    printHeader('VxSuite QA Automation');

    let config: QARunConfig;

    try {
      // Load config from file
      if (!options.config) {
        logger.error(
          'No configuration file specified. Use --config <path> to specify a config file.',
        );
        process.exit(1);
      }
      const configPath = resolvePath(options.config);
      const configData = await readFile(configPath, 'utf-8');
      const parsedConfig = JSON.parse(configData);
      config = validateConfig(parsedConfig, configPath);
      config.basePath = dirname(configPath);
      logger.info(`Loaded configuration from ${configPath}`);

      // Apply command-line overrides
      if (options.output) {
        config.output.directory = options.output;
      }
      if (options.tag) {
        config.vxsuite.ref = options.tag;
      }
      if (options.election) {
        config.election.source = options.election;
      }

      // Generate timestamped output directory
      const outputDir = generateTimestampedDir(config.output.directory);
      await ensureDir(outputDir);
      config.output.directory = outputDir;

      // Build webhook config if URL is provided
      let webhook: WebhookConfig | undefined;
      if (options.webhookUrl) {
        const secret = options.webhookSecret || process.env.CIRCLECI_WEBHOOK_SECRET;
        if (!secret) {
          logger.error(
            'Webhook secret is required. Use --webhook-secret or set CIRCLECI_WEBHOOK_SECRET.',
          );
          process.exit(1);
        }
        webhook = { url: options.webhookUrl, secret };
      }

      // If election source is a URL, download it first
      if (
        config.election.source.startsWith('http://') ||
        config.election.source.startsWith('https://')
      ) {
        const downloadPath = join(outputDir, 'election-package-download.zip');
        logger.info(`Downloading election package from ${config.election.source}`);
        await downloadFile(config.election.source, downloadPath);
        logger.info('Download complete');
        config.election.source = downloadPath;
      }

      // Run the workflow
      await runQAWorkflow(config, {
        headless: options.headless !== false,
        limitBallots: options.limitBallots,
        limitManualTallies: options.limitManualTallies,
        webhook,
      });
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
        if (process.env.DEBUG) {
          console.error(error.stack);
        }
      }
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate a configuration file')
  .argument('<config>', 'Path to configuration file')
  .action(async (configPath) => {
    try {
      const resolved = resolvePath(configPath);
      const configData = await readFile(resolved, 'utf-8');
      const parsedConfig = JSON.parse(configData);
      const result = safeValidateConfig(parsedConfig);

      if (result.success) {
        logger.success('Configuration is valid');
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        logger.error('Configuration is invalid:');
        console.error(result.error?.message ?? 'unknown error');
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Failed to parse config: ${error.message}`);
      }
      process.exit(1);
    }
  });

program
  .command('validate-tally')
  .description('Validates the vote tally from a prior run')
  .argument('<outputDir>', 'Path to output from prior run')
  .action(async (outputDir) => {
    const result = await revalidateTallyResults(outputDir);
    if (result.isValid) {
      logger.info(result.message);
      process.exitCode = 0;
    } else {
      logger.error(result.message);
      process.exitCode = 1;
    }
  });

program
  .command('rebuild-report')
  .description('Rebuild the report from a prior run')
  .argument('<outputDir>', 'Path to output from prior run')
  .action(async (outputDir) => {
    await regenerateHtmlReportFromRawData(outputDir);
  });

program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <path>', 'Output path for config file', './vx-qa-config.json')
  .action(async (options) => {
    const sampleConfig: QARunConfig = {
      vxsuite: {
        repoPath: '~/.vx-qa/vxsuite',
        ref: 'v4.0.4',
      },
      election: {
        source: './election-package-and-ballots.zip',
      },
      output: {
        directory: './qa-output',
      },
    };

    const outputPath = resolvePath(options.output);
    await writeFile(outputPath, JSON.stringify(sampleConfig, null, 2));
    logger.success(`Sample configuration created at ${outputPath}`);
    logger.info('Edit the file to configure your QA run, then use: vx-qa run --config <path>');
  });

program
  .command('serve')
  .description('Start a local CircleCI stand-in server for VxDesign')
  .requiredOption('-c, --config <path>', 'Path to configuration file')
  .option('-p, --port <port>', 'Port to listen on', parseInt, 9000)
  .option('--webhook-secret <secret>', 'Secret for webhook callbacks', 'test-secret')
  .option('--headless', 'Run browser in headless mode (default)')
  .option('--no-headless', 'Run browser in headed mode for debugging')
  .option('--limit-ballots <number>', 'Limit the number of ballots to scan (for testing)', parseInt)
  .option(
    '--limit-manual-tallies <number>',
    'Limit the number of ballot styles with manual tallies (for testing)',
    parseInt,
  )
  .action((options) => {
    startServe({
      port: options.port,
      configPath: options.config,
      webhookSecret: options.webhookSecret,
      headless: options.headless !== false,
      limitBallots: options.limitBallots,
      limitManualTallies: options.limitManualTallies,
    });
  });

program.parse();
