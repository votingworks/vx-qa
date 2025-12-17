/**
 * Configuration types for VxSuite QA automation tool
 */

export type BallotPattern = 'blank' | 'fully_filled' | 'partial' | 'overvote';

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
}

/** Result of scanning a single ballot */
export interface ScanResult {
  ballotStyleId: string;
  pattern: BallotPattern;
  accepted: boolean;
  reason?: string;
  screenshotPath?: string;
}

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
}

export interface BallotArtifact {
  ballotStyleId: string;
  pattern: BallotPattern;
  pdfPath: string;
  pngPaths: string[];
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
    patterns: ['blank', 'fully_filled', 'partial', 'overvote'],
  },
  output: {
    directory: './qa-output',
  },
};
