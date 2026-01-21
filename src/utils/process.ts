/**
 * Process management utilities for spawning and killing child processes
 */

import { spawn, ChildProcess, SpawnOptions } from 'node:child_process';
import treeKill from 'tree-kill';
import { logger } from './logger.js';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute a command and wait for it to complete
 */
export function execCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      reject(error);
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Execute a command with output streamed to console
 */
export function execCommandWithOutput(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });

    proc.on('error', (error) => {
      reject(error);
    });

    proc.on('close', (code) => {
      resolve(code);
    });
  });
}

/**
 * Spawn a background process
 */
export function spawnBackground(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const proc = spawn(command, args, {
    ...options,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return proc;
}

/**
 * Kill a process and all its children
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, 'SIGTERM', (err) => {
      if (err) {
        // Try SIGKILL if SIGTERM fails
        treeKill(pid, 'SIGKILL', (killErr) => {
          if (killErr) {
            logger.warn(`Failed to kill process ${pid}: ${killErr.message}`);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Wait for a port to become available
 */
export async function waitForPort(
  port: number,
  host = 'localhost',
  timeout = 60000,
  interval = 500,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(`http://${host}:${port}/`);
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Port not ready yet
    }
    await sleep(interval);
  }

  return false;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
