/**
 * HTML report generation
 */

import Handlebars from 'handlebars';
import { join, relative } from 'path';
import { logger } from '../utils/logger.js';
import type { ArtifactCollection } from '../config/types.js';
import { collectFilesInDir, loadCollection, readFileAsBase64 } from './artifacts.js';
import { generatePdfThumbnail } from './pdf-thumbnail.js';
import { writeFile } from 'fs/promises';
import { pathsEqual } from '../utils/paths.js';
import { validateTallyResults } from '../automation/admin-tally-workflow.js';

/**
 * Generate an HTML report from the artifact collection
 */
export async function generateHtmlReport(
  collection: ArtifactCollection,
  outputDir: string,
): Promise<string> {
  logger.step('Generating HTML report');

  const collectionPath = join(outputDir, 'collection.json');
  await writeFile(collectionPath, JSON.stringify(collection, null, 2), 'utf-8');

  // Prepare data for the template
  const data = await prepareReportData(collection, outputDir);
  const reportDataPath = join(outputDir, 'report-data.json');
  await writeFile(reportDataPath, JSON.stringify(data, null, 2), 'utf-8');

  // Generate HTML
  const html = renderTemplate(data);
  const reportPath = join(outputDir, 'report.html');
  await writeFile(reportPath, html, 'utf-8');

  logger.success(`Report saved: ${reportPath}`);

  return reportPath;
}

export async function regenerateHtmlReportFromRawData(outputDir: string): Promise<string> {
  logger.step('Regenerating HTML report from prior run using collection.json');

  const reportPath = join(outputDir, 'report.html');
  const collectionPath = join(outputDir, 'collection.json');
  const reportDataPath = join(outputDir, 'report-data.json');

  // Prepare data for the template
  const data = await prepareReportData(await loadCollection(collectionPath), outputDir);

  // Generate HTML
  const html = renderTemplate(data);

  // Write files
  await Promise.all([
    writeFile(reportPath, html, 'utf-8'),
    writeFile(reportDataPath, JSON.stringify(data, null, 2), 'utf-8'),
  ]);

  logger.success(`Report saved: ${reportPath}`);

  return reportPath;
}

/**
 * Prepare data for the HTML template
 */
async function prepareReportData(
  collection: ArtifactCollection,
  outputDir: string,
): Promise<ReportData> {
  const screenshotsDir = join(outputDir, 'screenshots');
  const screenshotFiles = collectFilesInDir(screenshotsDir, ['.png', '.jpg', '.jpeg']);

  // Collect ballot images
  const ballotsDir = join(outputDir, 'ballots');
  const ballotFiles = collectFilesInDir(ballotsDir, ['.png', '.pdf']);
  const ballots = await Promise.all(
    ballotFiles.map(async (file) => ({
      name: file.name,
      path: `ballots/${file.name}`,
      thumbnail: file.name.endsWith('.pdf')
        ? await generatePdfThumbnail(file.path)
        : `data:image/png;base64,${readFileAsBase64(file.path)}`,
    })),
  );

  // Collect Fujitsu thermal printer PDFs
  const printsDir = join(outputDir, 'workspaces', 'fujitsu-thermal-printer', 'prints');
  const printFiles = collectFilesInDir(printsDir, ['.pdf']);
  const prints = await Promise.all(
    printFiles.map(async (file) => ({
      name: file.name,
      path: file.path,
      thumbnail: await generatePdfThumbnail(file.path),
    })),
  );

  const validationResult = await validateTallyResults(collection);
  logger.info(`Tally validation: ${validationResult.message}`);

  for (const step of collection.steps) {
    for (const output of step.outputs) {
      output.validationResult ??=
        output.type === 'scan-result'
          ? {
              isValid: output.accepted === output.expected,
              message:
                output.accepted !== output.expected
                  ? output.expected
                    ? `Ballot sheet was expected to be accepted but was rejected.`
                    : `Ballot sheet was expected to be rejected but was accepted.`
                  : '',
            }
          : undefined;
    }
  }

  // Prepare steps for template with base64 screenshots and thumbnails
  const steps = await Promise.all(
    collection.steps.map(async (step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
      duration: step.endTime
        ? formatDuration(Math.round((step.endTime.getTime() - step.startTime.getTime()) / 1000))
        : 'N/A',
      inputs: await Promise.all(
        step.inputs.map(async (input) => ({
          type: input.type,
          label: input.label,
          description: input.description,
          path: input.path,
          data: input.data,
          thumbnail:
            input.type === 'ballot' && input.path ? await generatePdfThumbnail(input.path) : null,
        })),
      ),
      outputs: await Promise.all(
        step.outputs.map(async (output) => ({
          type: output.type,
          label: output.label,
          description: output.description,
          accepted: output.type === 'scan-result' ? output.accepted : undefined,
          expected: output.type === 'scan-result' ? output.expected : undefined,
          statusClass:
            output.type !== 'scan-result'
              ? 'neutral'
              : output.accepted === output.expected
                ? 'success'
                : 'error',
          thumbnail:
            output.type === 'print' && output.path
              ? await generatePdfThumbnail(join(outputDir, output.path))
              : null,
        })),
      ),
      screenshots: step.screenshots
        .map((screenshot) => {
          const file = screenshotFiles.find((f) => pathsEqual(f.path, screenshot.path));
          return file
            ? {
                name: screenshot.name,
                data: relative(outputDir, file.path),
                caption: screenshot.step,
              }
            : null;
        })
        .filter((s) => s !== null),
      hasErrors: step.errors.length > 0,
      errors: step.errors,
    })),
  );

  // Calculate statistics
  const totalScanned = collection.scanResults.length;
  const accepted = collection.scanResults.filter((r) => r.accepted).length;
  const rejected = collection.scanResults.filter((r) => !r.accepted).length;
  const handledAsExpected = collection.scanResults.filter(
    (r) => r.input.expectedAccepted === r.accepted,
  ).length;
  const handledUnexpectedly = collection.scanResults.filter(
    (r) => r.input.expectedAccepted !== r.accepted,
  ).length;

  // Check for validation failures
  const validationFailures: Array<{ step: string; message: string; stepId: string }> = [];

  for (const step of collection.steps) {
    for (const output of step.outputs) {
      if (output.validationResult?.isValid === false) {
        validationFailures.push({
          step: step.name,
          stepId: step.id,
          message: output.validationResult.message,
        });
      }
    }
  }

  // Calculate duration
  const duration =
    collection.endTime && collection.startTime
      ? Math.round((collection.endTime.getTime() - collection.startTime.getTime()) / 1000)
      : null;
  const hasErrors = collection.errors.length > 0;
  const hasValidationFailures = validationFailures.length > 0;
  const pass = !hasErrors && !hasValidationFailures;

  return {
    title: `VxSuite QA Report ${pass ? 'PASS' : 'FAIL'}`,
    runId: collection.runId,
    startTime: collection.startTime.toISOString(),
    endTime: collection.endTime?.toISOString() || 'In Progress',
    duration: duration ? formatDuration(duration) : 'N/A',
    pass,
    config: {
      tag: collection.config.vxsuite.ref,
      election: collection.config.election.source,
      patterns: collection.config.ballots.patterns.join(', '),
    },
    statistics: {
      totalBallotStyles: collection.ballots.length / collection.config.ballots.patterns.length || 0,
      totalBallots: collection.ballots.length,
      totalScanned,
      accepted,
      rejected,
      handledAsExpected,
      handledUnexpectedly,
    },
    steps,
    prints,
    ballots,
    scanResults: collection.scanResults.map((r) => {
      const expected = r.input.expectedAccepted;
      const actual = r.accepted;
      const isExpected = expected === actual;

      return {
        ballotStyleId: r.input.ballotStyleId,
        ballotMode: r.input.ballotMode,
        pattern: r.input.pattern,
        status: r.accepted ? 'Accepted' : 'Rejected',
        reason: r.reason || '-',
        statusClass: isExpected ? 'success' : 'error',
        isExpected,
        expectedStatus: expected ? 'Accepted' : 'Rejected',
      };
    }),
    errors: collection.errors.map((e) => ({
      step: e.step,
      message: e.message,
      timestamp: e.timestamp.toISOString(),
    })),
    hasErrors: collection.errors.length > 0,
    validationFailures,
    hasValidationFailures: validationFailures.length > 0,
  };
}

interface ReportData {
  title: string;
  runId: string;
  startTime: string;
  endTime: string;
  duration: string;
  pass: boolean;
  config: {
    tag: string;
    election: string;
    patterns: string;
  };
  statistics: {
    totalBallotStyles: number;
    totalBallots: number;
    totalScanned: number;
    accepted: number;
    rejected: number;
    handledAsExpected: number;
    handledUnexpectedly: number;
  };
  steps: {
    id: string;
    name: string;
    description: string;
    duration: string;
    inputs: {
      type: string;
      label: string;
      description?: string;
      path?: string;
      data?: Record<string, unknown>;
      thumbnail?: string | null;
    }[];
    outputs: {
      type: string;
      label: string;
      description?: string;
      path?: string;
      data?: Record<string, unknown>;
      statusClass?: string;
      thumbnail?: string | null;
    }[];
    screenshots: { name: string; data: string; caption: string }[];
    hasErrors: boolean;
    errors: { step: string; message: string; timestamp: Date }[];
  }[];
  prints: { name: string; path: string; thumbnail: string | null }[];
  ballots: { name: string; path: string; thumbnail: string | null }[];
  scanResults: {
    ballotStyleId: string;
    ballotMode: string;
    pattern: string;
    status: string;
    reason: string;
    statusClass: string;
    isExpected: boolean;
    expectedStatus: string;
  }[];
  errors: { step: string; message: string; timestamp: string }[];
  hasErrors: boolean;
  validationFailures: { step: string; message: string; stepId: string }[];
  hasValidationFailures: boolean;
}

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

/**
 * Render the HTML template
 */
function renderTemplate(data: ReportData): string {
  // Register Handlebars helpers
  Handlebars.registerHelper('eq', function (this: any, a: any, b: any, options: any) {
    if (a === b) {
      return options.fn(this);
    } else {
      return options.inverse(this);
    }
  });

  const template = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}} - {{runId}}</title>
  <style>
    :root {
      --primary: #2563eb;
      --success: #16a34a;
      --error: #dc2626;
      --gray-100: #f3f4f6;
      --gray-200: #e5e7eb;
      --gray-700: #374151;
      --gray-900: #111827;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: var(--gray-900);
      background: var(--gray-100);
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: var(--primary); margin-bottom: 0.5rem; }
    h2 { margin: 0 0 1rem; border-bottom: 2px solid var(--gray-200); padding-bottom: 0.5rem; }

    .header {
      background: white;
      padding: 2rem;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 2rem;
      border-left: 4px solid {{#if pass}}var(--success){{else}}var(--error){{/if}};
    }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .meta-item { background: var(--gray-100); padding: 0.75rem; border-radius: 0.25rem; }
    .meta-label { font-size: 0.75rem; color: var(--gray-700); text-transform: uppercase; }
    .meta-value { font-weight: 600; }

    .card {
      background: white;
      padding: 1.5rem;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 1.5rem;
    }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
    .stat { text-align: center; padding: 1rem; background: var(--gray-100); border-radius: 0.25rem; }
    .stat-value { font-size: 2rem; font-weight: 700; color: var(--primary); }
    .stat-label { font-size: 0.875rem; color: var(--gray-700); }
    .stat.success .stat-value { color: var(--success); }
    .stat.error .stat-value { color: var(--error); }

    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--gray-200); }
    th { background: var(--gray-100); font-weight: 600; }
    .status-success { color: var(--success); font-weight: 600; }
    .status-error { color: var(--error); font-weight: 600; }
    .expected-marker { font-size: 0.75rem; color: var(--gray-700); }

    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
    .gallery-item { background: var(--gray-100); border-radius: 0.25rem; overflow: hidden; }
    .gallery-item a { display: block; cursor: pointer; }
    .gallery-item img { width: 100%; height: auto; display: block; transition: opacity 0.2s; }
    .gallery-item a:hover img { opacity: 0.8; }
    .gallery-item .caption { padding: 0.5rem; font-size: 0.875rem; color: var(--gray-700); }

    .step { background: white; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .step-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; border-bottom: 2px solid var(--gray-200); padding-bottom: 0.75rem; }
    .step-title { font-size: 1.25rem; font-weight: 600; color: var(--primary); }
    .step-duration { font-size: 0.875rem; color: var(--gray-700); }
    .step-description { color: var(--gray-700); margin-bottom: 1.5rem; }
    .step-section { margin-bottom: 1.5rem; }
    .step-section:last-child { margin-bottom: 0; }
    .step-section-title { font-weight: 600; margin-bottom: 0.75rem; color: var(--gray-900); }
    .io-item { background: var(--gray-100); padding: 1rem; border-radius: 0.25rem; margin-bottom: 0.75rem; }
    .io-item:last-child { margin-bottom: 0; }
    .io-label { font-weight: 600; margin-bottom: 0.25rem; }
    .io-description { font-size: 0.875rem; color: var(--gray-700); }
    .io-meta { font-size: 0.75rem; color: var(--gray-700); margin-top: 0.5rem; }
    .output-success { border-left: 4px solid var(--success); }
    .output-error { border-left: 4px solid var(--error); }
    .output-neutral { border-left: 4px solid var(--gray-400); }
    .step-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
    .thumbnail-wrapper { margin-top: 0.5rem; }
    .thumbnail-wrapper img { max-width: 200px; border-radius: 0.25rem; }
    details { cursor: pointer; }
    summary { font-weight: 600; padding: 0.5rem 0; user-select: none; }
    summary:hover { color: var(--primary); }

    .errors { background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.5rem; padding: 1rem; }
    .error-item { padding: 0.5rem 0; border-bottom: 1px solid #fecaca; }
    .error-item:last-child { border-bottom: none; }
    .error-step { font-weight: 600; color: var(--error); }
    .error-message { color: var(--gray-700); }

    @media print {
      body { padding: 0; background: white; }
      .gallery-item img { max-height: 200px; object-fit: contain; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>{{title}}</h1>
      <p>Run ID: {{runId}}</p>
      <div class="meta">
        <div class="meta-item">
          <div class="meta-label">Start Time</div>
          <div class="meta-value">{{startTime}}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Duration</div>
          <div class="meta-value">{{duration}}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">VxSuite Tag</div>
          <div class="meta-value">{{config.tag}}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Election</div>
          <div class="meta-value">{{config.election}}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Ballot Patterns</div>
          <div class="meta-value">{{config.patterns}}</div>
        </div>
      </div>
    </div>

    {{#if hasErrors}}
    <div class="card errors">
      <h3>Errors</h3>
      {{#each errors}}
      <div class="error-item">
        <div class="error-step">{{step}}</div>
        <div class="error-message">{{message}}</div>
      </div>
      {{/each}}
    </div>
    {{/if}}

    {{#if hasValidationFailures}}
    <div class="card errors">
      <h3>⚠️ Validation Failures</h3>
      {{#each validationFailures}}
      <div class="error-item">
        <div class="error-step"><a href="#{{stepId}}">{{step}}</a></div>
        <div class="error-message">{{message}}</div>
      </div>
      {{/each}}
    </div>
    {{/if}}

    <div class="card">
      <h2>Statistics</h2>
      <div class="stats">
        <div class="stat">
          <div class="stat-value">{{statistics.totalBallotStyles}}</div>
          <div class="stat-label">Ballot Styles</div>
        </div>
        <div class="stat">
          <div class="stat-value">{{statistics.totalBallots}}</div>
          <div class="stat-label">Ballots Generated</div>
        </div>
        <div class="stat">
          <div class="stat-value">{{statistics.totalScanned}}</div>
          <div class="stat-label">Sheets Scanned</div>
        </div>
        <div class="stat success">
          <div class="stat-value">{{statistics.handledAsExpected}}</div>
          <div class="stat-label">Handled Correctly</div>
        </div>
        <div class="stat error">
          <div class="stat-value">{{statistics.handledUnexpectedly}}</div>
          <div class="stat-label">Handled Incorrectly</div>
        </div>
      </div>
    </div>

    <h2>Workflow Steps</h2>

    {{#each steps}}
    <div class="step">
      <a name="{{id}}"></a>
      <div class="step-header">
        <div class="step-title">{{name}}</div>
        <div class="step-duration">Duration: {{duration}}</div>
      </div>
      <div class="step-description">{{description}}</div>

      {{#if inputs.length}}
      <div class="step-section">
        <div class="step-section-title">Inputs</div>
        <div class="step-grid">
          {{#each inputs}}
          <div class="io-item">
            {{#eq type "election-package"}}
            {{#if path}}
            <div class="io-label"><a href="{{path}}" target="_blank">{{label}}</a></div>
            {{else}}
            <div class="io-label">{{label}}</div>
            {{/if}}
            {{else}}
            <div class="io-label">{{label}}</div>
            {{/eq}}
            {{#if description}}
            <div class="io-description">{{description}}</div>
            {{/if}}
            {{#if data}}
            <div class="io-meta">
              {{#if data.ballotStyleId}}Ballot Style: {{data.ballotStyleId}}{{/if}}
              {{#if data.ballotMode}} • Mode: {{data.ballotMode}}{{/if}}
              {{#if data.pattern}} • Pattern: {{data.pattern}}{{/if}}
              {{#if data.precinctId}} • Precinct: {{data.precinctId}}{{/if}}
              {{#if data.ballotType}} • Type: {{data.ballotType}}{{/if}}
            </div>
            {{/if}}
            {{#if thumbnail}}
            <div class="thumbnail-wrapper">
              <a href="{{path}}" target="_blank">
                <img src="{{thumbnail}}" alt="{{label}}">
              </a>
            </div>
            {{/if}}
          </div>
          {{/each}}
        </div>
      </div>
      {{/if}}

      {{#if outputs.length}}
      <div class="step-section">
        <div class="step-section-title">Outputs</div>
        <div class="step-grid">
          {{#each outputs}}
          <div class="io-item output-{{statusClass}}">
            {{#eq type "election-package"}}
            {{#if path}}
            <div class="io-label"><a href="{{path}}" target="_blank">{{label}}</a></div>
            {{else}}
            <div class="io-label">{{label}}</div>
            {{/if}}
            {{else}}
            <div class="io-label">{{label}}</div>
            {{/eq}}
            {{#if description}}
            <div class="io-description">{{description}}</div>
            {{/if}}
            {{#if data}}
            {{#eq type "scan-result"}}
            <div class="io-meta">
              {{#if data.accepted}}Status: Accepted{{/if}}
              {{#unless data.accepted}}Status: Rejected{{/unless}}
              {{#if data.expected}} • Expected: {{#if data.expected}}Accepted{{else}}Rejected{{/if}}{{/if}}
              {{#unless data.isExpected}} • ⚠️ Unexpected result{{/unless}}
            </div>
            {{/eq}}
            {{#eq type "pdf"}}
            {{#if data.validationMessage}}
            <div class="io-meta">
              {{#if data.isExpected}}✓{{else}}✗{{/if}} {{data.validationMessage}}
            </div>
            {{/if}}
            {{/eq}}
            {{/if}}
            {{#if thumbnail}}
            <div class="thumbnail-wrapper">
              <a href="{{path}}" target="_blank">
                <img src="{{thumbnail}}" alt="{{label}}">
              </a>
            </div>
            {{/if}}
          </div>
          {{/each}}
        </div>
      </div>
      {{/if}}

      {{#if screenshots.length}}
      <div class="step-section">
        <details open>
          <summary>Screenshots ({{screenshots.length}})</summary>
          <div class="gallery">
            {{#each screenshots}}
            <div class="gallery-item">
              <a href="{{data}}" target="_blank">
                <img src="{{data}}" alt="{{name}}" loading="lazy">
              </a>
              <div class="caption">{{caption}}</div>
            </div>
            {{/each}}
          </div>
        </details>
      </div>
      {{/if}}

      {{#if hasErrors}}
      <div class="step-section">
        <div class="errors">
          <div class="step-section-title">Errors</div>
          {{#each errors}}
          <div class="error-item">
            <div class="error-message">{{message}}</div>
          </div>
          {{/each}}
        </div>
      </div>
      {{/if}}
    </div>
    {{/each}}
  </div>
</body>
</html>`;

  const compiled = Handlebars.compile(template);
  return compiled(data);
}
