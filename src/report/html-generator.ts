/**
 * HTML report generation
 */

import Handlebars from 'handlebars';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { ArtifactCollection } from '../config/types.js';
import {
  collectFilesInDir,
  readFileAsBase64,
  getMimeType,
} from './artifacts.js';

/**
 * Generate an HTML report from the artifact collection
 */
export async function generateHtmlReport(
  collection: ArtifactCollection,
  outputDir: string
): Promise<string> {
  logger.step('Generating HTML report');

  const reportPath = join(outputDir, 'report.html');

  // Prepare data for the template
  const data = prepareReportData(collection, outputDir);

  // Generate HTML
  const html = renderTemplate(data);

  // Write report
  writeFileSync(reportPath, html, 'utf-8');

  logger.success(`Report saved: ${reportPath}`);

  return reportPath;
}

/**
 * Prepare data for the HTML template
 */
function prepareReportData(
  collection: ArtifactCollection,
  outputDir: string
): ReportData {
  // Collect screenshots with base64 data
  const screenshotsDir = join(outputDir, 'screenshots');
  const screenshotFiles = collectFilesInDir(screenshotsDir, ['.png', '.jpg', '.jpeg']);
  const screenshots = screenshotFiles.map((file) => ({
    name: file.name,
    data: `data:${getMimeType(file.path)};base64,${readFileAsBase64(file.path)}`,
  }));

  // Collect ballot images
  const ballotsDir = join(outputDir, 'ballots');
  const ballotFiles = collectFilesInDir(ballotsDir, ['.png', '.pdf']);
  const ballots = ballotFiles.map((file) => ({
    name: file.name,
    isPdf: file.name.endsWith('.pdf'),
    data: file.name.endsWith('.png')
      ? `data:image/png;base64,${readFileAsBase64(file.path)}`
      : undefined,
  }));

  // Calculate statistics
  const totalScanned = collection.scanResults.length;
  const accepted = collection.scanResults.filter((r) => r.accepted).length;
  const rejected = collection.scanResults.filter((r) => !r.accepted).length;

  // Calculate duration
  const duration =
    collection.endTime && collection.startTime
      ? Math.round(
          (collection.endTime.getTime() - collection.startTime.getTime()) / 1000
        )
      : null;

  return {
    title: 'VxSuite QA Report',
    runId: collection.runId,
    startTime: collection.startTime.toISOString(),
    endTime: collection.endTime?.toISOString() || 'In Progress',
    duration: duration ? formatDuration(duration) : 'N/A',
    config: {
      tag: collection.config.vxsuite.tag,
      election: collection.config.election.source,
      patterns: collection.config.ballots.patterns.join(', '),
    },
    statistics: {
      totalBallotStyles: collection.ballots.length / collection.config.ballots.patterns.length || 0,
      totalBallots: collection.ballots.length,
      totalScanned,
      accepted,
      rejected,
    },
    screenshots,
    ballots,
    scanResults: collection.scanResults.map((r) => ({
      ballotStyleId: r.ballotStyleId,
      pattern: r.pattern,
      status: r.accepted ? 'Accepted' : 'Rejected',
      reason: r.reason || '-',
      statusClass: r.accepted ? 'success' : 'error',
    })),
    errors: collection.errors.map((e) => ({
      step: e.step,
      message: e.message,
      timestamp: e.timestamp.toISOString(),
    })),
    hasErrors: collection.errors.length > 0,
  };
}

interface ReportData {
  title: string;
  runId: string;
  startTime: string;
  endTime: string;
  duration: string;
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
  };
  screenshots: { name: string; data: string }[];
  ballots: { name: string; isPdf: boolean; data?: string }[];
  scanResults: {
    ballotStyleId: string;
    pattern: string;
    status: string;
    reason: string;
    statusClass: string;
  }[];
  errors: { step: string; message: string; timestamp: string }[];
  hasErrors: boolean;
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
    h2 { margin: 2rem 0 1rem; border-bottom: 2px solid var(--gray-200); padding-bottom: 0.5rem; }
    h3 { margin: 1.5rem 0 0.75rem; color: var(--gray-700); }

    .header {
      background: white;
      padding: 2rem;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 2rem;
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

    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
    .gallery-item { background: var(--gray-100); border-radius: 0.25rem; overflow: hidden; }
    .gallery-item img { width: 100%; height: auto; display: block; }
    .gallery-item .caption { padding: 0.5rem; font-size: 0.875rem; color: var(--gray-700); }

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
          <div class="stat-label">Ballots Scanned</div>
        </div>
        <div class="stat success">
          <div class="stat-value">{{statistics.accepted}}</div>
          <div class="stat-label">Accepted</div>
        </div>
        <div class="stat error">
          <div class="stat-value">{{statistics.rejected}}</div>
          <div class="stat-label">Rejected</div>
        </div>
      </div>
    </div>

    {{#if scanResults.length}}
    <div class="card">
      <h2>Scan Results</h2>
      <table>
        <thead>
          <tr>
            <th>Ballot Style</th>
            <th>Pattern</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {{#each scanResults}}
          <tr>
            <td>{{ballotStyleId}}</td>
            <td>{{pattern}}</td>
            <td class="status-{{statusClass}}">{{status}}</td>
            <td>{{reason}}</td>
          </tr>
          {{/each}}
        </tbody>
      </table>
    </div>
    {{/if}}

    {{#if screenshots.length}}
    <div class="card">
      <h2>Screenshots</h2>
      <div class="gallery">
        {{#each screenshots}}
        <div class="gallery-item">
          <img src="{{data}}" alt="{{name}}" loading="lazy">
          <div class="caption">{{name}}</div>
        </div>
        {{/each}}
      </div>
    </div>
    {{/if}}

    {{#if ballots.length}}
    <div class="card">
      <h2>Ballot Images</h2>
      <div class="gallery">
        {{#each ballots}}
        {{#if data}}
        <div class="gallery-item">
          <img src="{{data}}" alt="{{name}}" loading="lazy">
          <div class="caption">{{name}}</div>
        </div>
        {{else}}
        <div class="gallery-item">
          <div class="caption">{{name}} (PDF)</div>
        </div>
        {{/if}}
        {{/each}}
      </div>
    </div>
    {{/if}}
  </div>
</body>
</html>`;

  const compiled = Handlebars.compile(template);
  return compiled(data);
}
