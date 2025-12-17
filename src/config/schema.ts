/**
 * Zod validation schemas for configuration
 */

import { z } from 'zod';

export const BallotPatternSchema = z.enum([
  'blank',
  'fully_filled',
  'partial',
  'overvote',
]);

export const VxSuiteConfigSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
  tag: z.string().min(1, 'Tag or branch is required'),
  forceClone: z.boolean().optional().default(false),
});

export const ElectionConfigSchema = z.object({
  source: z.string().min(1, 'Election source path is required'),
});

export const BallotConfigSchema = z.object({
  patterns: z
    .array(BallotPatternSchema)
    .min(1, 'At least one ballot pattern is required'),
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

export type QARunConfigInput = z.input<typeof QARunConfigSchema>;
export type QARunConfigOutput = z.output<typeof QARunConfigSchema>;

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): QARunConfigOutput {
  return QARunConfigSchema.parse(config);
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
