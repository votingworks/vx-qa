/**
 * Configuration types for VxSuite QA automation tool
 */

import { BallotToScan } from '../automation/scan-workflow.js';
import { BallotMode, BallotType, VotesDict } from '../ballots/election-loader.js';

export type BallotPattern = 'blank' | 'valid' | 'overvote';

export interface VxSuiteConfig {
  /** Path where VxSuite repo should be cloned */
  repoPath: string;
  /** Git tag/branch/rev to checkout (e.g., "v4.0.4") */
  ref: string;
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

export interface ValidationResult {
  isValid: boolean;
  message: string;
}

/** Output from a workflow step */
export type StepOutput =
  | {
    type: 'ballot';
    label: string;
    description?: string;
    path: string;
    validationResult?: ValidationResult;
  }
  | {
    type: 'election-package';
    label: string;
    description?: string;
    path: string;
    validationResult?: ValidationResult;
  }
  | {
    type: 'scan-result';
    label: string;
    description?: string;
    accepted: boolean;
    expected: boolean;
    rejectedReason?: string;
    screenshotPath: string;
    ballotStyleId: string;
    ballotMode: BallotMode;
    markPattern: BallotPattern;
    votes: VotesDict;
    validationResult?: ValidationResult;
  }
  | {
    type: 'print';
    label: string;
    description?: string;
    path: string;
    validationResult?: ValidationResult;
  }
  | {
    type: 'report';
    label: string;
    description?: string;
    path: string;
    validationResult?: ValidationResult;
  };

/** Collected artifacts from a QA run */
export interface ArtifactCollection {
  runId: string;
  startTime: Date;
  endTime?: Date;
  config: QARunConfig;
  ballots: BallotArtifact[];
  screenshots: ScreenshotArtifact[];
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
  label: string;
  path: string;
  timestamp: Date;
}

export interface ErrorArtifact {
  message: string;
  step: string;
  timestamp: Date;
  stack?: string;
}

export type PrecinctSelectionKind = 'SinglePrecinct' | 'AllPrecincts';

export interface SinglePrecinctSelection {
  kind: 'SinglePrecinct';
  precinctId: string;
}
export interface AllPrecinctsSelection {
  kind: 'AllPrecincts';
}

export type PrecinctSelection = SinglePrecinctSelection | AllPrecinctsSelection;
