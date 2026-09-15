import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildVxSuiteEnvironment,
  getVxSuiteEnvironment,
  readVxSuiteNodeVersion,
} from './vxsuite-env.ts';

describe('readVxSuiteNodeVersion', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'vxsuite-env-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  test('reads and normalizes .node-version', () => {
    writeFileSync(join(repoPath, '.node-version'), 'v20.19.0\n');
    expect(readVxSuiteNodeVersion(repoPath)).toBe('20.19.0');
  });

  test('throws when .node-version is missing', () => {
    expect(() => readVxSuiteNodeVersion(repoPath)).toThrow(/no \.node-version/);
  });

  test('throws when .node-version is not an exact version', () => {
    writeFileSync(join(repoPath, '.node-version'), 'lts/iron\n');
    expect(() => readVxSuiteNodeVersion(repoPath)).toThrow(/Unexpected Node\.js version/);
  });

  test('getVxSuiteEnvironment applies the pinned version and extra vars', () => {
    writeFileSync(join(repoPath, '.node-version'), '20.16.0\n');
    const env = getVxSuiteEnvironment(repoPath, { NODE_ENV: 'development' });
    expect(env.npm_config_use_node_version).toBe('20.16.0');
    expect(env.NODE_ENV).toBe('development');
  });
});

describe('buildVxSuiteEnvironment', () => {
  test('sets use-node-version and drops the running Node from PATH', () => {
    const env = buildVxSuiteEnvironment({
      base: { PATH: '/managers/node/24.19.0/bin:/usr/local/bin:/usr/bin', HOME: '/home/vx' },
      nodeVersion: '20.19.0',
      execPath: '/managers/node/24.19.0/bin/node',
    });

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.npm_config_use_node_version).toBe('20.19.0');
    expect(env.npm_config_manage_package_manager_versions).toBe('true');
    expect(env.HOME).toBe('/home/vx');
  });

  test('leaves PATH alone when the running Node is not on it', () => {
    const env = buildVxSuiteEnvironment({
      base: { PATH: '/usr/local/bin:/usr/bin' },
      nodeVersion: '20.19.0',
      execPath: '/nix/store/abc/bin/node',
    });

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  test('tolerates a missing PATH', () => {
    const env = buildVxSuiteEnvironment({
      base: {},
      nodeVersion: '20.19.0',
      execPath: '/usr/bin/node',
    });

    expect(env.PATH).toBe('');
  });
});
