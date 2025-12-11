/**
 * Interactive TUI for configuring QA runs
 *
 * Uses readline for a simple terminal-based wizard
 */

import * as readline from 'readline';
import { existsSync, readdirSync } from 'fs';
import { printHeader, printDivider } from '../utils/logger.js';
import { resolvePath, getDefaultRepoPath } from '../utils/paths.js';
import type { QARunConfig, BallotPattern } from '../config/types.js';
import chalk from 'chalk';

const AVAILABLE_PATTERNS: { label: string; value: BallotPattern }[] = [
  { label: 'Blank (no votes)', value: 'blank' },
  { label: 'Valid', value: 'valid' },
  { label: 'Overvote (too many votes)', value: 'overvote' },
];

const COMMON_TAGS = ['v4.0.4', 'v4.0.3', 'main'];

/**
 * Create readline interface
 */
function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a question and get user input
 */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(chalk.cyan('? ') + question + ' ', (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Display a menu and get selection
 */
async function selectFromMenu(
  rl: readline.Interface,
  prompt: string,
  options: { label: string; value: string }[]
): Promise<string> {
  console.log(chalk.cyan('? ') + prompt);

  options.forEach((opt, i) => {
    console.log(chalk.dim(`  ${i + 1}) `) + opt.label);
  });

  while (true) {
    const answer = await ask(rl, `Enter number (1-${options.length}):`);
    const num = parseInt(answer, 10);

    if (num >= 1 && num <= options.length) {
      return options[num - 1].value;
    }

    console.log(chalk.yellow('Invalid selection. Please try again.'));
  }
}

/**
 * Display multi-select menu
 */
async function multiSelectFromMenu(
  rl: readline.Interface,
  prompt: string,
  options: { label: string; value: string }[],
  defaults: string[] = []
): Promise<string[]> {
  const selected = new Set<string>(defaults);

  console.log(chalk.cyan('? ') + prompt);
  console.log(chalk.dim('  Enter numbers to toggle (comma-separated), or "done" to continue:'));

  const printOptions = () => {
    options.forEach((opt, i) => {
      const isSelected = selected.has(opt.value);
      const marker = isSelected ? chalk.green('[x]') : chalk.dim('[ ]');
      console.log(`  ${i + 1}) ${marker} ${opt.label}`);
    });
  };

  printOptions();

  while (true) {
    const answer = await ask(rl, 'Toggle (numbers) or "done":');

    if (answer.toLowerCase() === 'done') {
      if (selected.size === 0) {
        console.log(chalk.yellow('Please select at least one option.'));
        continue;
      }
      break;
    }

    const nums = answer.split(',').map((s) => parseInt(s.trim(), 10));

    for (const num of nums) {
      if (num >= 1 && num <= options.length) {
        const value = options[num - 1].value;
        if (selected.has(value)) {
          selected.delete(value);
        } else {
          selected.add(value);
        }
      }
    }

    // Clear and reprint options
    printOptions();
  }

  return Array.from(selected);
}

/**
 * Find election package files in a directory
 * Only looks for ZIP files since raw election.json is not sufficient
 */
function findElectionFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(resolvePath(dir));

    for (const entry of entries) {
      // Only include ZIP files - raw JSON is not supported
      if (entry.endsWith('.zip')) {
        files.push(entry);
      }
    }
  } catch {
    // Directory might not exist
  }

  return files;
}

/**
 * Run the interactive TUI wizard
 */
export async function runInteractiveTUI(): Promise<QARunConfig> {
  printHeader('VxSuite QA Configuration');

  const rl = createInterface();

  try {
    // Step 1: Select tag/version
    printDivider();
    console.log(chalk.bold('\nStep 1: VxSuite Version\n'));

    const tagOptions = [
      ...COMMON_TAGS.map((t) => ({ label: t, value: t })),
      { label: 'Custom (enter manually)', value: '__custom__' },
    ];

    let tag = await selectFromMenu(rl, 'Select VxSuite version:', tagOptions);

    if (tag === '__custom__') {
      tag = await ask(rl, 'Enter tag or branch name:');
    }

    console.log(chalk.green(`  Selected: ${tag}\n`));

    // Step 2: Select election source
    printDivider();
    console.log(chalk.bold('\nStep 2: Election Source\n'));

    const foundFiles = findElectionFiles('.');
    const electionOptions = [
      ...foundFiles.map((f) => ({ label: f, value: f })),
      { label: 'Enter path manually', value: '__custom__' },
    ];

    let electionSource: string;

    if (foundFiles.length > 0) {
      electionSource = await selectFromMenu(rl, 'Select election package (ZIP from VxDesign):', electionOptions);
    } else {
      console.log(chalk.yellow('No election package (ZIP) files found in current directory.\n'));
      electionSource = '__custom__';
    }

    if (electionSource === '__custom__') {
      electionSource = await ask(rl, 'Enter path to election package (ZIP from VxDesign):');
    }

    // Validate election file exists
    if (!existsSync(resolvePath(electionSource))) {
      console.log(chalk.yellow(`Warning: File not found: ${electionSource}`));
    }

    console.log(chalk.green(`  Selected: ${electionSource}\n`));

    // Step 3: Select ballot patterns
    printDivider();
    console.log(chalk.bold('\nStep 3: Ballot Patterns\n'));

    const patternOptions = AVAILABLE_PATTERNS.map((p) => ({
      label: p.label,
      value: p.value,
    }));

    const patterns = await multiSelectFromMenu(
      rl,
      'Select ballot patterns to generate:',
      patternOptions,
      ['blank', 'fully_filled', 'partial', 'overvote']
    );

    console.log(chalk.green(`  Selected: ${patterns.join(', ')}\n`));

    // Step 4: Output directory
    printDivider();
    console.log(chalk.bold('\nStep 4: Output Directory\n'));

    let outputDir = await ask(rl, 'Enter output directory (default: ./qa-output):');

    if (!outputDir) {
      outputDir = './qa-output';
    }

    console.log(chalk.green(`  Selected: ${outputDir}\n`));

    // Confirm
    printDivider();
    console.log(chalk.bold('\nConfiguration Summary:\n'));
    console.log(`  VxSuite version: ${chalk.cyan(tag)}`);
    console.log(`  Election source: ${chalk.cyan(electionSource)}`);
    console.log(`  Ballot patterns: ${chalk.cyan(patterns.join(', '))}`);
    console.log(`  Output directory: ${chalk.cyan(outputDir)}`);
    console.log();

    const confirm = await ask(rl, 'Proceed with this configuration? (y/n):');

    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      throw new Error('Configuration cancelled by user');
    }

    rl.close();

    return {
      vxsuite: {
        repoPath: getDefaultRepoPath(),
        tag,
      },
      election: {
        source: electionSource,
      },
      ballots: {
        patterns: patterns as BallotPattern[],
      },
      output: {
        directory: outputDir,
      },
    };
  } catch (error) {
    rl.close();
    throw error;
  }
}
