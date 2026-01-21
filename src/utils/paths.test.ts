/**
 * Tests for path utilities
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { expandHome, resolvePath, ensureDir, generateTimestampedDir, pathsEqual } from './paths.js';

describe('expandHome', () => {
  test('expands ~/ to home directory', () => {
    const result = expandHome('~/test/path');
    expect(result).toBe(join(homedir(), 'test/path'));
  });

  test('expands ~ to home directory', () => {
    const result = expandHome('~');
    expect(result).toBe(homedir());
  });

  test('leaves absolute paths unchanged', () => {
    const result = expandHome('/absolute/path');
    expect(result).toBe('/absolute/path');
  });

  test('leaves relative paths unchanged', () => {
    const result = expandHome('relative/path');
    expect(result).toBe('relative/path');
  });

  test('leaves paths with ~ in the middle unchanged', () => {
    const result = expandHome('/path/~test/file');
    expect(result).toBe('/path/~test/file');
  });
});

describe('resolvePath', () => {
  test('resolves relative paths to absolute', () => {
    const result = resolvePath('test/path');
    expect(result).toMatch(/^\/.*test\/path$/);
  });

  test('expands ~ before resolving', () => {
    const result = resolvePath('~/test/path');
    expect(result).toBe(join(homedir(), 'test/path'));
  });

  test('resolves relative to basePath when provided', () => {
    const basePath = '/base/directory';
    const result = resolvePath('relative/path', basePath);
    expect(result).toBe('/base/directory/relative/path');
  });

  test('handles absolute paths with basePath', () => {
    const basePath = '/base/directory';
    const result = resolvePath('/absolute/path', basePath);
    expect(result).toBe('/absolute/path');
  });

  test('handles ~ with basePath', () => {
    const basePath = '/base/directory';
    const result = resolvePath('~/test', basePath);
    expect(result).toBe(join(homedir(), 'test'));
  });
});

describe('ensureDir', () => {
  const testBaseDir = join(tmpdir(), 'vx-qa-test-ensure-dir');

  beforeEach(() => {
    // Clean up test directory if it exists
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  test('creates directory if it does not exist', () => {
    const testDir = join(testBaseDir, 'new-dir');
    expect(existsSync(testDir)).toBe(false);

    const result = ensureDir(testDir);

    expect(existsSync(testDir)).toBe(true);
    expect(result).toBe(testDir);
  });

  test('does not fail if directory already exists', () => {
    const testDir = join(testBaseDir, 'existing-dir');
    mkdirSync(testDir, { recursive: true });
    expect(existsSync(testDir)).toBe(true);

    const result = ensureDir(testDir);

    expect(existsSync(testDir)).toBe(true);
    expect(result).toBe(testDir);
  });

  test('creates nested directories', () => {
    const testDir = join(testBaseDir, 'nested/deep/directory');
    expect(existsSync(testDir)).toBe(false);

    const result = ensureDir(testDir);

    expect(existsSync(testDir)).toBe(true);
    expect(result).toBe(testDir);
  });

  test('expands ~ in path', () => {
    const testDir = '~/vx-qa-test-home-dir';
    const expectedDir = join(homedir(), 'vx-qa-test-home-dir');

    // Clean up if exists
    if (existsSync(expectedDir)) {
      rmSync(expectedDir, { recursive: true, force: true });
    }

    try {
      const result = ensureDir(testDir);
      expect(existsSync(expectedDir)).toBe(true);
      expect(result).toBe(expectedDir);
    } finally {
      // Clean up
      if (existsSync(expectedDir)) {
        rmSync(expectedDir, { recursive: true, force: true });
      }
    }
  });
});

describe('generateTimestampedDir', () => {
  test('generates directory with default prefix', () => {
    const baseDir = '/test/output';
    const result = generateTimestampedDir(baseDir);

    expect(result).toMatch(/^\/test\/output\/run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  test('generates directory with custom prefix', () => {
    const baseDir = '/test/output';
    const result = generateTimestampedDir(baseDir, 'custom');

    expect(result).toMatch(/^\/test\/output\/custom-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  test('expands ~ in base directory', () => {
    const baseDir = '~/output';
    const result = generateTimestampedDir(baseDir);

    const expectedPrefix = join(homedir(), 'output', 'run-');
    expect(result).toContain(expectedPrefix);
  });

  test('generates valid timestamps for subsequent calls', () => {
    const baseDir = '/test/output';
    const result1 = generateTimestampedDir(baseDir);

    // Small delay to ensure different timestamp
    const result2 = generateTimestampedDir(baseDir);

    // Timestamps should be very close but directory structure should be valid
    expect(result1).toMatch(/^\/test\/output\/run-/);
    expect(result2).toMatch(/^\/test\/output\/run-/);
  });
});

describe('pathsEqual', () => {
  test('returns true for identical absolute paths', () => {
    const result = pathsEqual('/absolute/path', '/absolute/path');
    expect(result).toBe(true);
  });

  test('returns false for different absolute paths', () => {
    const result = pathsEqual('/absolute/path1', '/absolute/path2');
    expect(result).toBe(false);
  });

  test('returns true for identical relative paths with default baseDir', () => {
    const result = pathsEqual('relative/path', 'relative/path');
    expect(result).toBe(true);
  });

  test('returns true for identical relative paths with custom baseDir', () => {
    const result = pathsEqual('relative/path', 'relative/path', '/base');
    expect(result).toBe(true);
  });

  test('returns true for equivalent paths (one absolute, one relative)', () => {
    const baseDir = '/base/dir';
    const result = pathsEqual('/base/dir/file.txt', 'file.txt', baseDir);
    expect(result).toBe(true);
  });

  test('returns false for different paths (one absolute, one relative)', () => {
    const baseDir = '/base/dir';
    const result = pathsEqual('/other/dir/file.txt', 'file.txt', baseDir);
    expect(result).toBe(false);
  });

  test('throws error if baseDir is not absolute', () => {
    expect(() => {
      pathsEqual('path1', 'path2', 'relative/base');
    }).toThrow('baseDir must be absolute');
  });

  test('handles both relative paths with baseDir', () => {
    const baseDir = '/base/dir';
    const result = pathsEqual('subdir/file.txt', 'subdir/file.txt', baseDir);
    expect(result).toBe(true);
  });

  test('handles different relative paths with baseDir', () => {
    const baseDir = '/base/dir';
    const result = pathsEqual('subdir1/file.txt', 'subdir2/file.txt', baseDir);
    expect(result).toBe(false);
  });
});
