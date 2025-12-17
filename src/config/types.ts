/**
 * Configuration types for VxSuite QA automation tool
 */

import { BallotToScan } from '../automation/scan-workflow.js';
import { BallotMode, BallotType } from '../ballots/election-loader.js';
import { VotesDict } from '../ballots/vote-generator.js';

export type BallotPattern = 'blank' | 'valid' | 'overvote';

export interface VxSuiteConfig {
  /** Path where VxSuite repo should be cloned */
  repoPath: string;
  /** Git tag or branch to checkout (e.g., "v4.0.4") */
  tag: string;
  /** Force a fresh clone even if repo exists */
  forceClone?: boolean;
}

export interface ElectionConfig {
  /** Path to election.json or election package ZIP */
  source: string;
}

export interface BallotConfig {
  /** Vote patterns to generate for each ballot style */
  patterns: BallotPattern[];
}

export interface OutputConfig {
  /** Base directory for output artifacts */
  directory: string;
}

export interface QARunConfig {
  vxsuite: VxSuiteConfig;
  election: ElectionConfig;
  ballots: BallotConfig;
  output: OutputConfig;
  basePath?: string;
}

/** Result of scanning a single ballot */
export interface ScanResult {
  input: BallotToScan;
  accepted: boolean;
  reason?: string;
  screenshotPath?: string;
}

/** Workflow step in the QA run */
export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  startTime: Date;
  endTime?: Date;
  inputs: StepInput[];
  outputs: StepOutput[];
  screenshots: ScreenshotArtifact[];
  errors: ErrorArtifact[];
}

/** Input to a workflow step */
export interface StepInput {
  type: 'ballot' | 'election-package' | 'card' | 'config';
  label: string;
  description?: string;
  path?: string;
  data?: Record<string, unknown>;
}

/** Output from a workflow step */
export type StepOutput =
  | {
      type: 'ballot';
      label: string;
      description?: string;
      path: string;
    }
  | {
      type: 'election-package';
      label: string;
      description?: string;
      path: string;
    }
  | {
      type: 'scan-result';
      label: string;
      description?: string;
      accepted: boolean;
      expected: boolean;
      screenshotPath: string;
      ballotStyleId: string;
      markPattern: BallotPattern;
      votes: VotesDict;
    }
  | {
      type: 'print';
      label: string;
      description?: string;
      path: string;
    }
  | {
      type: 'report';
      label: string;
      description?: string;
      path: string;
    };

/** Collected artifacts from a QA run */
export interface ArtifactCollection {
  runId: string;
  startTime: Date;
  endTime?: Date;
  config: QARunConfig;
  ballots: BallotArtifact[];
  screenshots: ScreenshotArtifact[];
  scanResults: ScanResult[];
  errors: ErrorArtifact[];
  steps: WorkflowStep[];
}

export interface BallotArtifact {
  ballotStyleId: string;
  precinctId: string;
  ballotType: BallotType;
  ballotMode: BallotMode;
  pdfPath: string;
}

export interface ScreenshotArtifact {
  name: string;
  step: string;
  path: string;
  timestamp: Date;
}

export interface ErrorArtifact {
  message: string;
  step: string;
  timestamp: Date;
  stack?: string;
}

/** Default configuration values */
export const DEFAULT_CONFIG: Partial<QARunConfig> = {
  vxsuite: {
    repoPath: '~/.vx-qa/vxsuite',
    tag: 'v4.0.4',
  },
  ballots: {
    patterns: ['blank', 'valid', 'overvote'],
  },
  output: {
    directory: './qa-output',
  },
};
