#!/usr/bin/env node

/**
 * VxSuite QA Automation Tool
 *
 * CLI entry point for automating QA testing of VxSuite elections
 */

import { Command, InvalidArgumentError } from 'commander';
import { logger, printHeader } from './utils/logger.ts';
import { validateConfig, safeValidateConfig, parseRawConfig } from './config/schema.ts';
import { resolvePath, generateTimestampedDir, ensureDir } from './utils/paths.ts';
import { runQAWorkflow } from './cli/config-runner.ts';
import { TALLY_MODES } from './config/types.ts';
import type { QARunConfig, WebhookConfig } from './config/types.ts';
import { SUPPORTED_VERSIONS } from './config/versions.ts';
import { dirname, join } from 'node:path';
import { regenerateHtmlReportFromRawData } from './report/html-generator.ts';
import { revalidateTallyResults } from './automation/admin-tally-workflow.ts';
import { downloadFile } from './ballots/election-loader.ts';
import { startServe } from './cli/serve.ts';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Commander option coercion for integer arguments. Passing `parseInt` directly
 * is a bug: Commander calls it as `parseInt(value, previous)`, so the previous
 * option value is used as the radix (e.g. `parseInt('9100', 9000)` -> NaN).
 */
function parseIntOption(value: string): number {
  const parsed = value.trim() === '' ? Number.NaN : Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError('Must be an integer.');
  }
  return parsed;
}

interface RunOptions {
  config?: string;
  output?: string;
  vxsuiteVersion?: string;
  tallyMode?: string;
  election?: string;
  headless?: boolean;
  limitBallots?: number;
  limitManualTallies?: number;
  webhookUrl?: string;
  webhookSecret?: string;
}

interface InitOptions {
  output: string;
}

interface ServeOptions {
  config: string;
  port: number;
  webhookSecret: string;
  headless?: boolean;
  limitBallots?: number;
  limitManualTallies?: number;
}

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
  .option('--vxsuite-version <version>', 'Override VxSuite version (e.g. v4.0, v4.1)')
  .option(
    '--tally-mode <mode>',
    'Override tally mode (consolidated or per-precinct); auto-detected from the election when omitted',
  )
  .option('-e, --election <path>', 'Override election source path')
  .option('--headless', 'Run browser in headless mode (default)')
  .option('--no-headless', 'Run browser in headed mode for debugging')
  .option(
    '--limit-ballots <number>',
    'Limit the number of ballots to scan (for testing)',
    parseIntOption,
  )
  .option(
    '--limit-manual-tallies <number>',
    'Limit the number of ballot styles with manual tallies (for testing)',
    parseIntOption,
  )
  .option('--webhook-url <url>', 'URL for status callbacks')
  .option(
    '--webhook-secret <secret>',
    'Secret for webhook auth (default: $CIRCLECI_WEBHOOK_SECRET env var)',
  )
  .action(async (options: RunOptions) => {
    printHeader('VxSuite QA Automation');

    let config: QARunConfig;

    try {
      // Load config from file
      if (options.config === undefined || options.config === '') {
        logger.error(
          'No configuration file specified. Use --config <path> to specify a config file.',
        );
        process.exit(1);
      }
      const configPath = resolvePath(options.config);
      const parsedConfig = parseRawConfig(await readFile(configPath, 'utf-8'));

      // Applied before validation so version-dependent checks (e.g. which
      // adjudication reasons the version accepts) see the effective version.
      if (options.vxsuiteVersion !== undefined) {
        const version = SUPPORTED_VERSIONS.find(
          (supported) => supported === options.vxsuiteVersion,
        );
        if (version === undefined) {
          logger.error(
            `Invalid --vxsuite-version "${options.vxsuiteVersion}". Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
          );
          process.exit(1);
        }
        const vxsuite = parsedConfig.vxsuite ?? {};
        parsedConfig.vxsuite = { ...vxsuite, version };
      }

      config = validateConfig(parsedConfig, configPath);
      config.basePath = dirname(configPath);
      logger.info(`Loaded configuration from ${configPath}`);

      // Apply command-line overrides
      if (options.output !== undefined) {
        config.output.directory = options.output;
      }
      if (options.tallyMode !== undefined) {
        const tallyMode = TALLY_MODES.find((mode) => mode === options.tallyMode);
        if (tallyMode === undefined) {
          logger.error(
            `Invalid --tally-mode "${options.tallyMode}". Supported: ${TALLY_MODES.join(', ')}`,
          );
          process.exit(1);
        }
        config.tallyMode = tallyMode;
      }
      if (options.election !== undefined) {
        config.election.source = options.election;
      }

      // Generate timestamped output directory
      const outputDir = generateTimestampedDir(config.output.directory);
      await ensureDir(outputDir);
      config.output.directory = outputDir;

      // Build webhook config if URL is provided
      let webhook: WebhookConfig | undefined;
      if (options.webhookUrl !== undefined) {
        const secret = options.webhookSecret ?? process.env.CIRCLECI_WEBHOOK_SECRET;
        if (secret === undefined || secret === '') {
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
        if (process.env.DEBUG !== undefined && process.env.DEBUG !== '') {
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
  .action(async (configPath: string) => {
    try {
      const resolved = resolvePath(configPath);
      const result = safeValidateConfig(parseRawConfig(await readFile(resolved, 'utf-8')));

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
  .action(async (outputDir: string) => {
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
  .action(async (outputDir: string) => {
    await regenerateHtmlReportFromRawData(outputDir);
  });

program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <path>', 'Output path for config file', './vx-qa-config.json')
  .action(async (options: InitOptions) => {
    const sampleConfig: QARunConfig = {
      vxsuite: {
        repoPath: '~/.vx-qa/vxsuite',
        version: 'v4.0',
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
  .option('-p, --port <port>', 'Port to listen on', parseIntOption, 9000)
  .option('--webhook-secret <secret>', 'Secret for webhook callbacks', 'test-secret')
  .option('--headless', 'Run browser in headless mode (default)')
  .option('--no-headless', 'Run browser in headed mode for debugging')
  .option(
    '--limit-ballots <number>',
    'Limit the number of ballots to scan (for testing)',
    parseIntOption,
  )
  .option(
    '--limit-manual-tallies <number>',
    'Limit the number of ballot styles with manual tallies (for testing)',
    parseIntOption,
  )
  .action((options: ServeOptions) => {
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
