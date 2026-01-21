/**
 * Artifact collection and management
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename, extname, isAbsolute } from 'node:path';
import { logger } from '../utils/logger.js';
import type {
  ArtifactCollection,
  BallotArtifact,
  ErrorArtifact,
  QARunConfig,
  WorkflowStep,
  StepInput,
  StepOutput,
  ScreenshotArtifact,
} from '../config/types.js';
import { copyFile, readFile } from 'node:fs/promises';
import assert from 'node:assert';
import { Page } from '@playwright/test';
import { createScreenshotManager } from '../automation/screenshot.js';

export interface StepCollector {
  /**
   * Add an input to the current step
   */
  addInput(input: StepInput): void;

  /**
   * Add an output to the current step
   */
  addOutput(output: StepOutput): Promise<void>;

  /**
   * Gets all added outputs
   */
  getOutputs(): StepOutput[];

  /**
   * Capture a screenshot for the current step
   */
  captureScreenshot(name: string, label: string): Promise<ScreenshotArtifact>;

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
   * Log an error
   */
  logError(error: Error, step: string): void;

  /**
   * Start a new workflow step
   */
  startStep(page: Page, id: string, name: string, description: string): StepCollector;

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
}

/**
 * Create an artifact collector
 */
export function createArtifactCollector(outputDir: string, config: QARunConfig): ArtifactCollector {
  assert(isAbsolute(outputDir), 'outputDir must be absolute');
  const runId = basename(outputDir);
  const startTime = new Date();

  const collection: ArtifactCollection = {
    runId,
    startTime,
    config,
    ballots: [],
    screenshots: [],
    errors: [],
    steps: [],
  };

  // Create directory structure
  const dirs = {
    ballots: join(outputDir, 'ballots'),
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

    logError(error: Error, step: string): void {
      const artifact: ErrorArtifact = {
        message: error.message,
        step,
        timestamp: new Date(),
        stack: error.stack,
      };
      collection.errors.push(artifact);
      logger.error(`Error in ${step}: ${error.message} ${error.stack}`);
    },

    startStep(page: Page, id: string, name: string, description: string): StepCollector {
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

      const stepIndex = collection.steps.length - 1;
      const stepIndexStr = stepIndex.toString().padStart(2, '0');
      const stepDir = join(outputDir, 'steps', `${stepIndexStr}-${id.replace(/[^a-z0-9]+/g, '-')}`);
      mkdirSync(stepDir, { recursive: true });

      const screenshots = createScreenshotManager(page, stepDir);

      return {
        addInput(input: StepInput): void {
          step.inputs.push(input);
        },

        async addOutput(output: StepOutput): Promise<void> {
          if (
            output.type !== 'scan-result' &&
            output.type !== 'manual-tally' &&
            'path' in output &&
            output.path
          ) {
            const fileName = basename(output.path);
            const stepCopyPath = join(stepDir, fileName);
            await copyFile(output.path, stepCopyPath);
            output.path = stepCopyPath;
          }

          step.outputs.push(output);
        },

        getOutputs() {
          return step.outputs;
        },

        async captureScreenshot(name, label): Promise<ScreenshotArtifact> {
          const screenshot = await screenshots.capture(name, label);
          step.screenshots.push(screenshot);
          return screenshot;
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
  };
}

/**
 * Loads a serialized collection as a
 */
export async function loadCollection(path: string): Promise<ArtifactCollection> {
  return JSON.parse(await readFile(path, 'utf8'), (key, value) => {
    switch (key) {
      case 'startTime':
      case 'endTime':
      case 'timestamp':
      case 'mtime':
        return typeof value === 'string' ? new Date(value) : value;

      default:
        return value;
    }
  });
}

/**
 * Collect all files in a directory
 */
export function collectFilesInDir(
  dir: string,
  extensions?: string[],
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
