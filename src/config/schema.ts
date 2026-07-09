/**
 * Zod validation schemas for configuration
 */

import { z } from 'zod/v4';
import { resolvePath } from '../utils/paths.js';
import { dirname } from 'node:path';
import { SUPPORTED_VERSIONS } from './versions.js';

export const BallotPatternSchema = z.enum([
  'blank',
  'valid',
  'overvote',
  'marked-write-in',
  'unmarked-write-in',
]);

export const VxSuiteConfigSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required'),
  version: z.enum(SUPPORTED_VERSIONS, {
    message: `VxSuite version must be one of: ${SUPPORTED_VERSIONS.join(', ')}`,
  }),
  forceClone: z.boolean().optional().default(false),
});

/**
 * Overrides applied to the election package's systemSettings.json before it is
 * loaded into VxAdmin (and re-exported to VxScan). Lets a single election
 * package exercise different behaviors — e.g. flipping `disallowCastingOvervotes`
 * to test the cast-overvote path — without maintaining a separate package.
 */
export const SystemSettingsOverridesSchema = z.object({
  disallowCastingOvervotes: z.boolean().optional(),
});

export const ElectionConfigSchema = z.object({
  source: z.string().min(1, 'Election source path is required'),
  systemSettingsOverrides: SystemSettingsOverridesSchema.optional(),
});

export const OutputConfigSchema = z.object({
  directory: z.string().min(1, 'Output directory is required'),
});

export const QARunConfigSchema = z.object({
  vxsuite: VxSuiteConfigSchema,
  election: ElectionConfigSchema,
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
  parsedConfig.output.directory = resolvePath(parsedConfig.output.directory, configDir);
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
