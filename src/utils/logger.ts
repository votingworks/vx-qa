/**
 * Logging utilities with colored output and spinners
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { appendFileSync } from 'node:fs';

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  step(message: string): void;
  spinner(message: string): Ora;
  setLogFile(path: string | null): void;
}

const isDebug = process.env.DEBUG && process.env.DEBUG !== 'false' && process.env.DEBUG !== '0';

let logFilePath: string | null = null;

function writeToLog(level: string, message: string): void {
  if (logFilePath) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${level.padEnd(7)} ${message}\n`;
    try {
      appendFileSync(logFilePath, logLine, 'utf-8');
    } catch (error) {
      // If we can't write to the log file, just continue
      console.error('Failed to write to log file:', error);
    }
  }
}

export const logger: Logger = {
  info(message: string): void {
    console.log(chalk.blue('info'), message);
    writeToLog('info', message);
  },

  success(message: string): void {
    console.log(chalk.green('success'), message);
    writeToLog('success', message);
  },

  warn(message: string): void {
    console.log(chalk.yellow('warn'), message);
    writeToLog('warn', message);
  },

  error(message: string): void {
    console.log(chalk.red('error'), message);
    writeToLog('error', message);
  },

  debug(message: string): void {
    if (isDebug) {
      console.log(chalk.gray('debug'), message);
      writeToLog('debug', message);
    } else if (logFilePath) {
      // Always write debug messages to log file even if not shown on console
      writeToLog('debug', message);
    }
  },

  step(message: string): void {
    console.log(chalk.cyan('>>>'), message);
    writeToLog('step', message);
  },

  spinner(message: string): Ora {
    writeToLog('spinner', message);
    return ora({
      text: message,
      color: 'cyan',
    }).start();
  },

  setLogFile(path: string | null): void {
    logFilePath = path;
    if (path) {
      writeToLog('info', `Logging to file: ${path}`);
    }
  },
};

/**
 * Format a duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Print a header with a box around it
 */
export function printHeader(title: string): void {
  const line = '═'.repeat(title.length + 4);
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan(`║  ${title}  ║`));
  console.log(chalk.cyan(`╚${line}╝`));
  console.log();
}

/**
 * Print a section divider
 */
export function printDivider(): void {
  console.log(chalk.dim('─'.repeat(60)));
}
