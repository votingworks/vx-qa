/**
 * Artifact collection and management
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { logger } from '../utils/logger.js';
import type {
  ArtifactCollection,
  BallotArtifact,
  ScreenshotArtifact,
  ScanResult,
  ErrorArtifact,
  QARunConfig,
  WorkflowStep,
  StepInput,
  StepOutput,
} from '../config/types.js';

export interface StepCollector {
  /**
   * Add an input to the current step
   */
  addInput(input: StepInput): void;

  /**
   * Add an output to the current step
   */
  addOutput(output: StepOutput): void;

  /**
   * Add a screenshot to the current step
   */
  addScreenshot(artifact: ScreenshotArtifact): void;

  /**
   * Log an error in the current step
   */
  logError(error: Error): void;

  /**
   * Complete the current step
   */
  complete(): void;
}

export interface ArtifactCollector {
  /**
   * Add a ballot artifact
   */
  addBallot(artifact: BallotArtifact): void;

  /**
   * Add a screenshot artifact
   */
  addScreenshot(artifact: ScreenshotArtifact): void;

  /**
   * Add scan results
   */
  addScanResults(results: ScanResult[]): void;

  /**
   * Log an error
   */
  logError(error: Error, step: string): void;

  /**
   * Start a new workflow step
   */
  startStep(id: string, name: string, description: string): StepCollector;

  /**
   * Mark the run as complete
   */
  complete(): void;

  /**
   * Get the collected artifacts
   */
  getCollection(): ArtifactCollection;

  /**
   * Get the output directory
   */
  getOutputDir(): string;

  /**
   * Get subdirectory paths
   */
  getBallotsDir(): string;
  getScreenshotsDir(): string;
}

/**
 * Create an artifact collector
 */
export function createArtifactCollector(
  outputDir: string,
  config: QARunConfig
): ArtifactCollector {
  const runId = basename(outputDir);
  const startTime = new Date();

  const collection: ArtifactCollection = {
    runId,
    startTime,
    config,
    ballots: [],
    screenshots: [],
    scanResults: [],
    errors: [],
    steps: [],
  };

  // Create directory structure
  const dirs = {
    ballots: join(outputDir, 'ballots'),
    screenshots: join(outputDir, 'screenshots'),
  };

  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return {
    addBallot(artifact: BallotArtifact): void {
      collection.ballots.push(artifact);
      logger.debug(`Added ballot artifact: ${artifact.ballotStyleId}`);
    },

    addScreenshot(artifact: ScreenshotArtifact): void {
      collection.screenshots.push(artifact);
    },

    addScanResults(results: ScanResult[]): void {
      collection.scanResults.push(...results);
    },

    logError(error: Error, step: string): void {
      const artifact: ErrorArtifact = {
        message: error.message,
        step,
        timestamp: new Date(),
        stack: error.stack,
      };
      collection.errors.push(artifact);
      logger.error(`Error in ${step}: ${error.message}`);
    },

    startStep(id: string, name: string, description: string): StepCollector {
      const step: WorkflowStep = {
        id,
        name,
        description,
        startTime: new Date(),
        inputs: [],
        outputs: [],
        screenshots: [],
        errors: [],
      };

      collection.steps.push(step);
      logger.debug(`Started step: ${name}`);

      return {
        addInput(input: StepInput): void {
          step.inputs.push(input);
        },

        addOutput(output: StepOutput): void {
          step.outputs.push(output);
        },

        addScreenshot(artifact: ScreenshotArtifact): void {
          step.screenshots.push(artifact);
          collection.screenshots.push(artifact);
        },

        logError(error: Error): void {
          const artifact: ErrorArtifact = {
            message: error.message,
            step: step.name,
            timestamp: new Date(),
            stack: error.stack,
          };
          step.errors.push(artifact);
          collection.errors.push(artifact);
          logger.error(`Error in ${step.name}: ${error.message}`);
        },

        complete(): void {
          step.endTime = new Date();
          logger.debug(`Completed step: ${name}`);
        },
      };
    },

    complete(): void {
      collection.endTime = new Date();
    },

    getCollection(): ArtifactCollection {
      return collection;
    },

    getOutputDir(): string {
      return outputDir;
    },

    getBallotsDir(): string {
      return dirs.ballots;
    },

    getScreenshotsDir(): string {
      return dirs.screenshots;
    },
  };
}

/**
 * Collect all files in a directory
 */
export function collectFilesInDir(
  dir: string,
  extensions?: string[]
): { name: string; path: string; size: number; mtime?: Date }[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir);
  const results: { name: string; path: string; size: number; mtime?: Date }[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isFile()) {
      if (!extensions || extensions.includes(extname(file).toLowerCase())) {
        results.push({
          name: file,
          path: filePath,
          size: stat.size,
          mtime: stat.mtime,
        });
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a file as base64
 */
export function readFileAsBase64(filePath: string): string {
  const buffer = readFileSync(filePath);
  return buffer.toString('base64');
}

/**
 * Get file extension from path
 */
export function getFileExtension(filePath: string): string {
  return extname(filePath).toLowerCase().slice(1);
}

/**
 * Get MIME type for common file types
 */
export function getMimeType(filePath: string): string {
  const ext = getFileExtension(filePath);

  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    pdf: 'application/pdf',
    json: 'application/json',
    html: 'text/html',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
