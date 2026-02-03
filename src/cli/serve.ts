/**
 * Local serve mode — acts as a CircleCI stand-in for VxDesign.
 *
 * Listens for POST /api/v2/project/.../pipeline requests, responds immediately
 * with a mock pipeline ID, then runs the real QA workflow in the background
 * and sends webhook callbacks through the existing webhook client.
 */

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { logger, printHeader } from '../utils/logger.js';
import { validateConfig } from '../config/schema.js';
import { resolvePath, generateTimestampedDir, ensureDir } from '../utils/paths.js';
import { runQAWorkflow } from './config-runner.js';
import { downloadFile } from '../ballots/election-loader.js';
import type { QARunConfig } from '../config/types.js';

export interface ServeOptions {
  port: number;
  configPath: string;
  webhookSecret: string;
  headless: boolean;
  limitBallots?: number;
  limitManualTallies?: number;
}

/**
 * Start the local serve mode HTTP server.
 */
export function startServe(options: ServeOptions): void {
  let running = false;
  let pipelineCounter = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.match(/\/api\/v2\/project\/.*\/pipeline/)) {
      let body = '';
      req.setEncoding('utf8');

      req.on('data', (chunk: string) => {
        body += chunk;
      });

      req.on('end', () => {
        if (running) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A QA run is already in progress' }));
          return;
        }

        let data: {
          parameters?: {
            export_package_url?: string;
            webhook_url?: string;
            qa_run_id?: string;
            election_id?: string;
          };
        };
        try {
          data = JSON.parse(body) as typeof data;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
          return;
        }

        const params = data.parameters ?? {};
        const exportPackageUrl = params.export_package_url;
        const webhookUrl = params.webhook_url;

        if (!exportPackageUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Missing required parameter: export_package_url',
            }),
          );
          return;
        }

        pipelineCounter += 1;
        const pipelineId = `local-pipeline-${Date.now()}-${pipelineCounter}`;

        logger.info(`Pipeline triggered: ${pipelineId}`);
        logger.info(`  export_package_url: ${exportPackageUrl}`);
        logger.info(`  webhook_url: ${webhookUrl ?? '(none)'}`);
        logger.info(`  qa_run_id: ${params.qa_run_id ?? '(none)'}`);
        logger.info(`  election_id: ${params.election_id ?? '(none)'}`);

        // Respond immediately with a mock pipeline response
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: pipelineId,
            number: pipelineCounter,
            state: 'pending',
            created_at: new Date().toISOString(),
          }),
        );

        // Run the QA workflow in the background
        running = true;
        void runPipeline(options, exportPackageUrl, webhookUrl).finally(() => {
          running = false;
        });
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(options.port, () => {
    printHeader('vx-qa serve');
    logger.info(`Listening on port ${options.port}`);
    logger.info(`Config: ${options.configPath}`);
    logger.info(`Headless: ${options.headless}`);
    logger.info('');
    logger.info('Start VxDesign with:');
    logger.info('');
    logger.info('  CIRCLECI_API_TOKEN=test-token \\');
    logger.info('  CIRCLECI_PROJECT_SLUG=gh/test/repo \\');
    logger.info(`  CIRCLECI_WEBHOOK_SECRET=${options.webhookSecret} \\`);
    logger.info(`  CIRCLECI_BASE_URL=http://localhost:${options.port} \\`);
    logger.info('  FRONTEND_PORT=4000 \\');
    logger.info('  BASE_URL=http://localhost:4000 \\');
    logger.info('  pnpm -C apps/design start');
    logger.info('');
    logger.info('Then export an election in VxDesign.');
  });
}

/**
 * Load config, download the election package, and run the QA workflow.
 */
async function runPipeline(
  options: ServeOptions,
  exportPackageUrl: string,
  webhookUrl: string | undefined,
): Promise<void> {
  try {
    // Load the config
    const configPath = resolvePath(options.configPath);
    const configData = await readFile(configPath, 'utf-8');
    const parsedConfig = JSON.parse(configData);
    const config: QARunConfig = validateConfig(parsedConfig, configPath);
    config.basePath = dirname(configPath);

    // Override election source with the URL from the request
    config.election.source = exportPackageUrl;

    // Generate a timestamped output directory
    const outputDir = generateTimestampedDir(config.output.directory);
    await ensureDir(outputDir);
    config.output.directory = outputDir;

    // Download the election package
    const downloadPath = join(outputDir, 'election-package-download.zip');
    logger.info(`Downloading election package from ${exportPackageUrl}`);
    await downloadFile(exportPackageUrl, downloadPath);
    logger.info('Download complete');
    config.election.source = downloadPath;

    // Run the QA workflow
    await runQAWorkflow(config, {
      headless: options.headless,
      limitBallots: options.limitBallots,
      limitManualTallies: options.limitManualTallies,
      webhook: webhookUrl ? { url: webhookUrl, secret: options.webhookSecret } : undefined,
    });

    logger.success('QA run complete');
  } catch (error) {
    logger.error(`QA run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
