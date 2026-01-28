/**
 * Election definition loading from JSON files and ZIP packages
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import JSZip from 'jszip';
import { logger } from '../utils/logger.js';
import assert from 'node:assert';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod/v4';

/**
 * VotesDict maps contest ID to array of votes
 * For candidate contests: array of Candidate objects
 * For yes/no contests: array of option IDs ('yes' or 'no')
 */
export type Vote = Candidate | string;
export type VotesDict = Record<string, Vote[]>;

/**
 * Basic election types (simplified from VxSuite types)
 * These match the core structure from libs/types/src/election.ts
 */
export interface Candidate {
  id: string;
  name: string;
  partyIds?: string[];
  isWriteIn?: boolean;
  writeInIndex?: number;
}

export interface CandidateContest {
  type: 'candidate';
  id: string;
  title: string;
  seats: number;
  candidates: Candidate[];
  allowWriteIns: boolean;
  districtId: string;
}

export interface YesNoContest {
  type: 'yesno';
  id: string;
  title: string;
  yesOption: { id: string; label: string };
  noOption: { id: string; label: string };
  districtId: string;
}

export type Contest = CandidateContest | YesNoContest;

export interface BallotStyle {
  id: string;
  precincts: string[];
  districts: string[];
}

export interface Precinct {
  id: string;
  name: string;
}

export interface Party {
  id: string;
  name: string;
  abbrev: string;
}

export interface Election {
  title: string;
  state: string;
  county: { id: string; name: string };
  date: string;
  type: 'general' | 'primary';
  ballotStyles: BallotStyle[];
  precincts: Precinct[];
  contests: Contest[];
  parties?: Party[];
  ballotLayout: {
    paperSize: string;
    metadataEncoding: string;
  };
  gridLayouts?: GridLayout[];
}

export interface GridLayout {
  ballotStyleId: string;
  optionBoundsFromTargetMark: Rect;
  gridPositions: GridPosition[];
}

export type BallotSide = 'front' | 'back';

export type GridPosition = GridPositionOption | GridPositionWriteIn;

export interface GridPositionWriteIn {
  type: 'write-in';
  sheetNumber: number;
  side: BallotSide;
  column: number;
  row: number;
  contestId: string;
  writeInIndex: number;
  writeInArea: Rect;
}

export interface GridPositionOption {
  type: 'option';
  sheetNumber: number;
  side: BallotSide;
  column: number;
  row: number;
  contestId: string;
  optionId: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectionDefinition {
  election: Election;
  electionData: string;
  ballotHash: string;
}

export interface ElectionPackage {
  electionDefinition: ElectionDefinition;
  systemSettings: Record<string, unknown>;
  ballots: BallotPdfInfo[];
  metadata?: {
    version: string;
    createdAt: string;
  };
}

/**
 * Parse the contents of an election package ZIP
 */
async function parseElectionPackageZip(zip: JSZip, sourcePath: string): Promise<ElectionPackage> {
  const fileNames = Object.keys(zip.files);

  // Find and load election.json
  const electionFile = zip.file('election.json');
  if (!electionFile) {
    throw new Error(
      `Invalid election package: election.json not found.\n` +
        `This doesn't appear to be a valid VxDesign election package.\n` +
        `Files found: ${fileNames.slice(0, 5).join(', ')}${fileNames.length > 5 ? '...' : ''}\n` +
        `Source: ${sourcePath}`,
    );
  }

  const electionData = await electionFile.async('string');
  const election = JSON.parse(electionData) as Election;
  const ballotHash = await calculateHash(electionData);

  // Load metadata if present
  let metadata: ElectionPackage['metadata'];
  const metadataFile = zip.file('metadata.json');
  if (metadataFile) {
    const metadataData = await metadataFile.async('string');
    metadata = JSON.parse(metadataData);
  }

  // Load ballots if present (from ballots.jsonl)
  logger.debug('Loading ballots from ballots.jsonl');

  const ballots: BallotPdfInfo[] = [];
  const ballotsFile = zip.file('ballots.jsonl');
  assert(ballotsFile, `ballots.jsonl missing in ${sourcePath}`);

  const ballotsStream = ballotsFile.nodeStream('nodebuffer');
  const ballotsJsonLines = createInterface({
    input: ballotsStream,
    crlfDelay: Infinity,
  });

  for await (const line of ballotsJsonLines) {
    try {
      const { encodedBallot, ...props } = RawBallotPdfInfo.parse(JSON.parse(line));
      const pdfData = Buffer.from(encodedBallot, 'base64');
      ballots.push({ ...props, pdfData });
    } catch (e) {
      logger.warn(`Failed to parse ballot entry: ${(e as Error).message}`);
    }
  }
  logger.debug(`Loaded ${ballots.length} ballot PDFs`);

  // Validate we have what we need
  assert(ballots.length > 0, 'Election package contains no ballot PDFs.');

  const systemSettingsFile = zip.file('systemSettings.json');
  if (!systemSettingsFile) {
    throw new Error(
      `Invalid election package: election.json not found.\n` +
        `This doesn't appear to be a valid VxDesign election package.\n` +
        `Files found: ${fileNames.slice(0, 5).join(', ')}${fileNames.length > 5 ? '...' : ''}\n` +
        `Source: ${sourcePath}`,
    );
  }

  const systemSettingsJson = await systemSettingsFile.async('string');
  const systemSettings = JSON.parse(systemSettingsJson);

  return {
    electionDefinition: {
      election,
      electionData,
      ballotHash,
    },
    systemSettings,
    ballots,
    metadata,
  };
}

/**
 * Calculate a simple hash for the election data
 */
async function calculateHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Get contests for a specific ballot style
 */
export function getContestsForBallotStyle(election: Election, ballotStyleId: string): Contest[] {
  const ballotStyle = election.ballotStyles.find((bs) => bs.id === ballotStyleId);
  if (!ballotStyle) {
    throw new Error(`Ballot style not found: ${ballotStyleId}`);
  }

  const districts = ballotStyle.districts;
  return election.contests.filter((c) => districts.includes(c.districtId));
}

export const RawBallotPdfInfo = z.strictObject({
  ballotStyleId: z.string(),
  precinctId: z.string(),
  ballotType: z.union([z.literal('precinct'), z.literal('absentee')]),
  ballotMode: z.union([z.literal('official'), z.literal('test')]),
  compact: z.boolean(),
  encodedBallot: z.string(),
});

export type BallotType = 'precinct' | 'absentee';
export type BallotMode = 'official' | 'test';

/**
 * Ballot PDF info extracted from the package
 */
export interface BallotPdfInfo {
  ballotStyleId: string;
  precinctId: string;
  ballotType: BallotType;
  ballotMode: BallotMode;
  compact: boolean;
  pdfData: Uint8Array;
}

/**
 * Result of loading election package with ballots
 */
export interface UnpackedElectionPackage {
  electionPackage: ElectionPackage;
  electionPackagePath: string; // Path to the extracted election-package-*.zip
}

/**
 * Load election package and extract ballot PDFs
 *
 * This handles the VxDesign "election-package-and-ballots" format which contains:
 * - election-package-*.zip (the election package for VxAdmin)
 * - ballots-*.zip (individual ballot PDFs)
 */
export async function loadElectionPackage(
  sourcePath: string,
  outputDir: string,
): Promise<UnpackedElectionPackage> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Election source not found: ${sourcePath}`);
  }

  const ext = extname(sourcePath).toLowerCase();
  if (ext !== '.zip') {
    throw new Error(
      `Expected a .zip election package, got: ${ext}\n` +
        `Please provide a VxDesign election package (election-package-and-ballots-*.zip)`,
    );
  }

  logger.debug(`Loading election package with ballots from: ${sourcePath}`);

  const zipData = readFileSync(sourcePath);
  const zip = await JSZip.loadAsync(zipData);
  const fileNames = Object.keys(zip.files);

  logger.debug(`ZIP contains: ${fileNames.join(', ')}`);

  // Find the election-package-*.zip and ballots-*.zip
  const electionPackageFile = fileNames.find(
    (f) => f.startsWith('election-package-') && f.endsWith('.zip'),
  );

  if (!electionPackageFile) {
    throw new Error(
      `No election-package-*.zip found in the archive.\n` +
        `Files found: ${fileNames.join(', ')}\n` +
        `Please provide a complete VxDesign export (election-package-and-ballots-*.zip)`,
    );
  }

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Extract the election package ZIP
  const electionPackageData = await zip.file(electionPackageFile)!.async('uint8array');
  const electionPackagePath = join(outputDir, electionPackageFile);
  writeFileSync(electionPackagePath, electionPackageData);
  logger.info(`Extracted election package: ${electionPackageFile}`);

  // Parse the election package
  const electionPackageZip = await JSZip.loadAsync(electionPackageData);
  const electionPackage = await parseElectionPackageZip(electionPackageZip, sourcePath);

  return {
    electionPackage,
    electionPackagePath,
  };
}
