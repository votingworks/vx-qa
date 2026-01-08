/**
 * Zod validation schemas for configuration
 */

import { z } from 'zod/v4';
import { resolvePath } from '../utils/paths.js';
import { dirname } from 'node:path';

export const BallotPatternSchema = z.enum([
  'blank',
  'valid',
  'overvote',
  'marked-write-in',
  'unmarked-write-in',
]);

export const VxSuiteConfigSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
  ref: z.string().min(1, 'Tag/branch/rev is required'),
  forceClone: z.boolean().optional().default(false),
});

export const ElectionConfigSchema = z.object({
  source: z.string().min(1, 'Election source path is required'),
});

export const BallotConfigSchema = z.object({
  patterns: z.array(BallotPatternSchema).min(1, 'At least one ballot pattern is required'),
});

export const OutputConfigSchema = z.object({
  directory: z.string().min(1, 'Output directory is required'),
});

export const QARunConfigSchema = z.object({
  vxsuite: VxSuiteConfigSchema,
  election: ElectionConfigSchema,
  ballots: BallotConfigSchema,
  output: OutputConfigSchema,
});

export type QARunConfigOutput = z.output<typeof QARunConfigSchema>;

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown, configPath: string): QARunConfigOutput {
  const parsedConfig = QARunConfigSchema.parse(config);
  const configDir = dirname(configPath);
  parsedConfig.vxsuite.repoPath = resolvePath(parsedConfig.vxsuite.repoPath, configDir);
  parsedConfig.election.source = resolvePath(parsedConfig.election.source, configDir);
  return parsedConfig;
}

/**
 * Safely validate a configuration object, returning result or error
 */
export function safeValidateConfig(config: unknown): {
  success: boolean;
  data?: QARunConfigOutput;
  error?: z.ZodError;
} {
  const result = QARunConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
