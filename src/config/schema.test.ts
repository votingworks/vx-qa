/**
 * Tests for configuration schema validation
 */

import { describe, test, expect } from 'vitest';
import { ZodError } from 'zod/v4';
import { validateConfig, safeValidateConfig } from './schema.ts';

describe('validateConfig', () => {
  test('resolve vxsuite.repoPath relative to config directory', () => {
    const config = {
      vxsuite: {
        repoPath: './vxsuite',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const configPath = '/home/user/projects/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.vxsuite.repoPath).toBe('/home/user/projects/vxsuite');
  });

  test('resolve election.source relative to config directory', () => {
    const config = {
      vxsuite: {
        repoPath: '~/.vx-qa/vxsuite',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const configPath = '/home/user/projects/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.election.source).toBe('/home/user/projects/election.json');
  });

  test('resolve output.directory relative to config directory', () => {
    const config = {
      vxsuite: {
        repoPath: '~/.vx-qa/vxsuite',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './qa-output',
      },
    };

    const configPath = '/home/user/projects/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.output.directory).toBe('/home/user/projects/qa-output');
  });

  test('handle absolute paths correctly', () => {
    const config = {
      vxsuite: {
        repoPath: '/absolute/path/vxsuite',
        version: 'v4.0',
      },
      election: {
        source: '/absolute/path/election.json',
      },
      output: {
        directory: '/absolute/path/output',
      },
    };

    const configPath = '/home/user/projects/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.vxsuite.repoPath).toBe('/absolute/path/vxsuite');
    expect(result.election.source).toBe('/absolute/path/election.json');
    expect(result.output.directory).toBe('/absolute/path/output');
  });

  test('handle nested relative paths', () => {
    const config = {
      vxsuite: {
        repoPath: '../shared/vxsuite',
        version: 'v4.0',
      },
      election: {
        source: '../elections/election.json',
      },
      output: {
        directory: '../results/output',
      },
    };

    const configPath = '/home/user/projects/configs/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.vxsuite.repoPath).toBe('/home/user/projects/shared/vxsuite');
    expect(result.election.source).toBe('/home/user/projects/elections/election.json');
    expect(result.output.directory).toBe('/home/user/projects/results/output');
  });

  test('apply default values for optional fields', () => {
    const config = {
      vxsuite: {
        repoPath: './vxsuite',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const configPath = '/home/user/my-config.json';
    const result = validateConfig(config, configPath);

    expect(result.vxsuite.forceClone).toBe(false);
  });

  test('throw error for invalid config', () => {
    const config = {
      vxsuite: {
        repoPath: '',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const configPath = '/home/user/my-config.json';

    expect(() => {
      validateConfig(config, configPath);
    }).toThrow(ZodError);
  });
});

function configWith(version: string, reasons: string[]) {
  return {
    vxsuite: { repoPath: './vxsuite', version },
    election: {
      source: './election.zip',
      systemSettingsOverrides: { precinctScanAdjudicationReasons: reasons },
    },
    output: { directory: './output' },
  };
}

describe('precinctScanAdjudicationReasons per version', () => {
  test('accepts the reasons every version shares', () => {
    for (const version of ['v4.0', 'v4.1']) {
      const result = safeValidateConfig(
        configWith(version, [
          'MarginalMark',
          'Overvote',
          'Undervote',
          'BlankBallot',
          'UnmarkedWriteIn',
        ]),
      );
      expect(result.success).toBe(true);
    }
  });

  test('accepts UninterpretableBallot only on v4.0', () => {
    expect(safeValidateConfig(configWith('v4.0', ['UninterpretableBallot'])).success).toBe(true);

    const result = safeValidateConfig(configWith('v4.1', ['Overvote', 'UninterpretableBallot']));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['election', 'systemSettingsOverrides', 'precinctScanAdjudicationReasons', 1],
        message: expect.stringContaining(
          '"UninterpretableBallot" is not supported by VxSuite v4.1',
        ),
      }),
    ]);
  });

  test('accepts CrossoverVoting only on v4.1', () => {
    expect(safeValidateConfig(configWith('v4.1', ['CrossoverVoting'])).success).toBe(true);
    expect(safeValidateConfig(configWith('v4.0', ['CrossoverVoting'])).success).toBe(false);
  });

  test('rejects an unknown reason on every version', () => {
    expect(safeValidateConfig(configWith('v4.0', ['Nope'])).success).toBe(false);
    expect(safeValidateConfig(configWith('v4.1', ['Nope'])).success).toBe(false);
  });
});

describe('safeValidateConfig', () => {
  test('return success for valid config', () => {
    const config = {
      vxsuite: {
        repoPath: './vxsuite',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const result = safeValidateConfig(config);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test('return error for invalid config', () => {
    const config = {
      vxsuite: {
        repoPath: '',
        version: 'v4.0',
      },
      election: {
        source: './election.json',
      },
      output: {
        directory: './output',
      },
    };

    const result = safeValidateConfig(config);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});
