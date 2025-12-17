/**
 * Election definition loading from JSON files and ZIP packages
 */

import { readFileSync, existsSync } from 'fs';
import { extname, basename } from 'path';
import JSZip from 'jszip';
import { logger } from '../utils/logger.js';
import { resolvePath } from '../utils/paths.js';

/**
 * Basic election types (simplified from VxSuite types)
 * These match the core structure from libs/types/src/election.ts
 */
export interface Candidate {
  id: string;
  name: string;
  partyIds?: string[];
  isWriteIn?: boolean;
}

export interface CandidateContest {
  type: 'candidate';
  id: string;
  title: string;
  seats: number;
  candidates: Candidate[];
  allowWriteIns: boolean;
}

export interface YesNoContest {
  type: 'yesno';
  id: string;
  title: string;
  yesOption: { id: string; label: string };
  noOption: { id: string; label: string };
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
  gridLayouts?: unknown[];
}

export interface ElectionDefinition {
  election: Election;
  electionData: string;
  ballotHash: string;
}

export interface ElectionPackage {
  electionDefinition: ElectionDefinition;
  ballots?: Map<string, Uint8Array>; // ballotStyleId -> PDF bytes
  metadata?: {
    version: string;
    createdAt: string;
  };
}

/**
 * Load an election from a JSON file or ZIP package
 */
export async function loadElection(source: string): Promise<ElectionPackage> {
  const sourcePath = resolvePath(source);

  if (!existsSync(sourcePath)) {
    throw new Error(`Election source not found: ${sourcePath}`);
  }

  const ext = extname(sourcePath).toLowerCase();

  if (ext === '.zip') {
    return await loadElectionFromZip(sourcePath);
  } else if (ext === '.json') {
    return await loadElectionFromJson(sourcePath);
  } else {
    throw new Error(`Unsupported election source format: ${ext}`);
  }
}

/**
 * Load an election from a JSON file
 */
async function loadElectionFromJson(jsonPath: string): Promise<ElectionPackage> {
  logger.debug(`Loading election from JSON: ${jsonPath}`);

  const electionData = readFileSync(jsonPath, 'utf-8');
  const election = JSON.parse(electionData) as Election;

  // Calculate a simple hash
  const ballotHash = await calculateHash(electionData);

  return {
    electionDefinition: {
      election,
      electionData,
      ballotHash,
    },
  };
}

/**
 * Load an election from a ZIP package
 */
async function loadElectionFromZip(zipPath: string): Promise<ElectionPackage> {
  logger.debug(`Loading election from ZIP: ${zipPath}`);

  const zipData = readFileSync(zipPath);
  const zip = await JSZip.loadAsync(zipData);

  // Find and load election.json
  const electionFile = zip.file('election.json');
  if (!electionFile) {
    throw new Error('election.json not found in ZIP package');
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
  const ballots = new Map<string, Uint8Array>();
  const ballotsFile = zip.file('ballots.jsonl');
  if (ballotsFile) {
    const ballotsData = await ballotsFile.async('string');
    const lines = ballotsData.trim().split('\n');

    for (const line of lines) {
      const entry = JSON.parse(line);
      const ballotStyleId = entry.ballotStyleId as string;
      const pdfBase64 = entry.pdf as string;
      const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
      ballots.set(ballotStyleId, pdfBytes);
    }
  }

  return {
    electionDefinition: {
      election,
      electionData,
      ballotHash,
    },
    ballots: ballots.size > 0 ? ballots : undefined,
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
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Get contests for a specific ballot style
 */
export function getContestsForBallotStyle(
  election: Election,
  ballotStyleId: string
): Contest[] {
  const ballotStyle = election.ballotStyles.find((bs) => bs.id === ballotStyleId);
  if (!ballotStyle) {
    throw new Error(`Ballot style not found: ${ballotStyleId}`);
  }

  // In a real implementation, we'd filter by districts
  // For now, return all contests
  return election.contests;
}

/**
 * Get precinct name by ID
 */
export function getPrecinctName(election: Election, precinctId: string): string {
  const precinct = election.precincts.find((p) => p.id === precinctId);
  return precinct?.name || precinctId;
}
