/**
 * Tests for configuration schema validation
 */

import { describe, test, expect } from 'vitest';
import { validateConfig, safeValidateConfig } from './schema.js';

describe('validateConfig', () => {
  test('resolve vxsuite.repoPath relative to config directory', () => {
    const config = {
      vxsuite: {
        repoPath: './vxsuite',
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
    }).toThrow();
  });
});

describe('safeValidateConfig', () => {
  test('return success for valid config', () => {
    const config = {
      vxsuite: {
        repoPath: './vxsuite',
        ref: 'v4.0.4',
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
        ref: 'v4.0.4',
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
