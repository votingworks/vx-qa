/**
 * Tests for repository bootstrap state detection
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNodeVersion, needsBootstrap } from './bootstrap.ts';

const BUILD_DIRS = [
  'apps/admin/frontend/build',
  'apps/admin/backend/build',
  'apps/scan/frontend/build',
  'apps/scan/backend/build',
];

async function makeFullyBootstrappedRepo(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, 'node_modules'), { recursive: true });
  for (const dir of BUILD_DIRS) {
    await mkdir(join(repoPath, dir), { recursive: true });
  }
}

describe('needsBootstrap', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = join(tmpdir(), `vx-qa-bootstrap-test-${Date.now()}-${Math.random()}`);
    await mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  test('true when node_modules is missing', () => {
    expect(needsBootstrap(repoPath, 'abc123')).toBe(true);
  });

  test('true when an app build directory is missing', async () => {
    await mkdir(join(repoPath, 'node_modules'), { recursive: true });
    expect(needsBootstrap(repoPath, 'abc123')).toBe(true);
  });

  test('true when fully built but no commit marker exists yet', async () => {
    await makeFullyBootstrappedRepo(repoPath);
    expect(needsBootstrap(repoPath, 'abc123')).toBe(true);
  });

  test('true when the commit marker does not match the checked-out commit', async () => {
    await makeFullyBootstrappedRepo(repoPath);
    await writeFile(join(repoPath, '.vx-qa-bootstrap-commit'), 'old-commit');
    expect(needsBootstrap(repoPath, 'new-commit')).toBe(true);
  });

  test('false when fully built and the commit marker matches', async () => {
    await makeFullyBootstrappedRepo(repoPath);
    await writeFile(join(repoPath, '.vx-qa-bootstrap-commit'), 'abc123');
    expect(needsBootstrap(repoPath, 'abc123')).toBe(false);
  });
});

describe('checkNodeVersion', () => {
  test('accepts the minimum version and newer', () => {
    expect(checkNodeVersion('22.18.0').compatible).toBe(true);
    expect(checkNodeVersion('24.19.0').compatible).toBe(true);
  });

  test('rejects older versions, including a lower minor of the same major', () => {
    expect(checkNodeVersion('22.17.9').compatible).toBe(false);
    expect(checkNodeVersion('20.19.0').compatible).toBe(false);
  });
});
