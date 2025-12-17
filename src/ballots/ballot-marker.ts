/**
 * Ballot marking - generate marked ballot PDFs
 *
 * This module provides functionality to mark ballots with votes.
 * For full functionality, it integrates with VxSuite's libs/hmpb/src/marking.ts
 * via child process execution in the cloned repo.
 */

import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger.js';
import type { ElectionDefinition } from './election-loader.js';
import type { VotesDict } from './vote-generator.js';
import type { BallotPattern } from '../config/types.js';

export interface MarkedBallot {
  ballotStyleId: string;
  pattern: BallotPattern;
  pdfBytes: Uint8Array;
}

/**
 * Generate a marked ballot PDF using VxSuite's marking library
 *
 * This function executes a script in the cloned VxSuite repo to use
 * the generateMarkOverlay function from libs/hmpb/src/marking.ts
 */
export async function generateMarkedBallot(
  repoPath: string,
  electionDefinition: ElectionDefinition,
  ballotStyleId: string,
  votes: VotesDict,
  baseBallotPdf?: Uint8Array
): Promise<Uint8Array> {
  logger.debug(`Generating marked ballot for style ${ballotStyleId}`);

  // Create a temporary script to run in the VxSuite context
  const tempDir = join(repoPath, '.vx-qa-temp');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const inputPath = join(tempDir, 'mark-input.json');
  const outputPath = join(tempDir, 'mark-output.pdf');
  const basePdfPath = baseBallotPdf
    ? join(tempDir, 'base-ballot.pdf')
    : undefined;

  // Write input data
  const inputData = {
    election: electionDefinition.election,
    ballotStyleId,
    votes,
    basePdfPath,
  };
  writeFileSync(inputPath, JSON.stringify(inputData));

  if (baseBallotPdf && basePdfPath) {
    writeFileSync(basePdfPath, baseBallotPdf);
  }

  // Create the marking script
  const scriptPath = join(tempDir, 'mark-ballot.ts');
  const scriptContent = `
import { readFileSync, writeFileSync } from 'fs';
import { generateMarkOverlay } from '../libs/hmpb/src/marking';

async function main() {
  const input = JSON.parse(readFileSync('${inputPath}', 'utf-8'));
  const basePdf = input.basePdfPath
    ? readFileSync(input.basePdfPath)
    : undefined;

  const calibration = { offsetMmX: 0, offsetMmY: 0 };

  const pdfBytes = await generateMarkOverlay(
    input.election,
    input.ballotStyleId,
    input.votes,
    calibration,
    basePdf
  );

  writeFileSync('${outputPath}', pdfBytes);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
  writeFileSync(scriptPath, scriptContent);

  // Execute the script using tsx in the VxSuite repo context
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Ballot marking failed: ${stderr}`));
        return;
      }

      if (!existsSync(outputPath)) {
        reject(new Error('Ballot marking did not produce output'));
        return;
      }

      const pdfBytes = readFileSync(outputPath);
      resolve(new Uint8Array(pdfBytes));
    });

    proc.on('error', reject);
  });
}

/**
 * Generate marked ballots for all patterns for a ballot style
 */
export async function generateMarkedBallotsForStyle(
  repoPath: string,
  electionDefinition: ElectionDefinition,
  ballotStyleId: string,
  votesMap: Map<BallotPattern, VotesDict>,
  baseBallotPdf?: Uint8Array
): Promise<MarkedBallot[]> {
  const results: MarkedBallot[] = [];

  for (const [pattern, votes] of votesMap) {
    try {
      // For blank ballots, just use the base PDF if available
      if (pattern === 'blank' && baseBallotPdf) {
        results.push({
          ballotStyleId,
          pattern,
          pdfBytes: baseBallotPdf,
        });
        continue;
      }

      const pdfBytes = await generateMarkedBallot(
        repoPath,
        electionDefinition,
        ballotStyleId,
        votes,
        baseBallotPdf
      );

      results.push({
        ballotStyleId,
        pattern,
        pdfBytes,
      });
    } catch (error) {
      logger.warn(`Failed to generate ${pattern} ballot for ${ballotStyleId}: ${error}`);
    }
  }

  return results;
}

/**
 * Create a simple standalone marked ballot (fallback when VxSuite libs unavailable)
 *
 * This creates a placeholder PDF with vote information for testing purposes.
 */
export async function createPlaceholderBallot(
  ballotStyleId: string,
  pattern: BallotPattern,
  votes: VotesDict
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // Letter size
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const { height } = page.getSize();
  let y = height - 50;

  // Title
  page.drawText('VxSuite QA Test Ballot', {
    x: 50,
    y,
    size: 18,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
  y -= 30;

  // Ballot info
  page.drawText(`Ballot Style: ${ballotStyleId}`, {
    x: 50,
    y,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  y -= 20;

  page.drawText(`Pattern: ${pattern}`, {
    x: 50,
    y,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  y -= 30;

  // Votes
  page.drawText('Votes:', {
    x: 50,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
  y -= 20;

  for (const [contestId, contestVotes] of Object.entries(votes)) {
    const voteStr =
      contestVotes.length === 0
        ? '(none)'
        : contestVotes
            .map((v) => (typeof v === 'object' ? v.name : v))
            .join(', ');

    page.drawText(`${contestId}: ${voteStr}`, {
      x: 60,
      y,
      size: 10,
      font,
      color: rgb(0, 0, 0),
    });
    y -= 15;

    if (y < 50) break;
  }

  return await doc.save();
}
