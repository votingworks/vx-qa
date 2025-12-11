/**
 * Logging utilities with colored output and spinners
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  step(message: string): void;
  spinner(message: string): Ora;
}

const isDebug = process.env.DEBUG !== 'false' && process.env.DEBUG !== '0';

export const logger: Logger = {
  info(message: string): void {
    console.log(chalk.blue('info'), message);
  },

  success(message: string): void {
    console.log(chalk.green('success'), message);
  },

  warn(message: string): void {
    console.log(chalk.yellow('warn'), message);
  },

  error(message: string): void {
    console.log(chalk.red('error'), message);
  },

  debug(message: string): void {
    if (isDebug) {
      console.log(chalk.gray('debug'), message);
    }
  },

  step(message: string): void {
    console.log(chalk.cyan('>>>'), message);
  },

  spinner(message: string): Ora {
    return ora({
      text: message,
      color: 'cyan',
    }).start();
  },
};

/**
 * Create a child logger with a prefix
 */
export function createPrefixedLogger(prefix: string): Logger {
  const prefixStr = chalk.dim(`[${prefix}]`);
  return {
    info: (msg) => logger.info(`${prefixStr} ${msg}`),
    success: (msg) => logger.success(`${prefixStr} ${msg}`),
    warn: (msg) => logger.warn(`${prefixStr} ${msg}`),
    error: (msg) => logger.error(`${prefixStr} ${msg}`),
    debug: (msg) => logger.debug(`${prefixStr} ${msg}`),
    step: (msg) => logger.step(`${prefixStr} ${msg}`),
    spinner: (msg) => logger.spinner(`${prefixStr} ${msg}`),
  };
}

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
