/**
 * Authentication helpers for VxSuite apps
 *
 * Based on patterns from apps/admin/integration-testing/e2e/support/auth.ts
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import {
  createMockCardController,
  DEFAULT_PIN,
  MockCardController,
} from '../mock-hardware/cards.js';
import { clickTextInApp, waitForTextWithDebug, waitForTextInApp } from './browser.js';

/**
 * Enter the PIN on the PIN pad screen
 */
export async function enterPin(page: Page, pin = DEFAULT_PIN, outputDir?: string): Promise<void> {
  logger.debug('Entering PIN');

  await waitForTextWithDebug(page, 'Enter Card PIN', {
    timeout: 10000,
    outputDir,
    label: 'Waiting for PIN entry screen',
  });

  for (const digit of pin) {
    await page.getByRole('button', { name: digit }).click();
  }
}

/**
 * Log in as a system administrator
 */
export async function dipSystemAdministratorCardAndLogin(
  page: Page,
  electionPath?: string,
  outputDir?: string,
): Promise<void> {
  logger.step('Logging in as System Administrator');

  const cardController = createMockCardController();

  // Set election if provided
  if (electionPath) {
    await cardController.setElection(electionPath);
  }

  // Insert system administrator card
  await cardController.insertCard('system_administrator');

  // Enter PIN
  await enterPin(page, DEFAULT_PIN, outputDir);

  // Remove card
  await cardController.removeCard();

  // Wait for the logged-in state in the main app
  await waitForTextInApp(page, 'Lock Machine', { timeout: 10000 });

  logger.debug('Logged in as System Administrator');
}

/**
 * Log in as an election manager by dipping and removing the Election Manager
 * card.
 */
export async function dipElectionManagerCardAndLogin(
  page: Page,
  electionPath?: string,
  outputDir?: string,
): Promise<void> {
  logger.step('Logging in as Election Manager');

  const cardController = createMockCardController();

  // Set election if provided
  if (electionPath) {
    await cardController.setElection(electionPath);
  }

  // Insert election manager card
  await cardController.insertCard('election_manager');

  // Enter PIN
  await enterPin(page, DEFAULT_PIN, outputDir);

  // Remove card
  await cardController.removeCard();

  logger.debug('Logged in as Election Manager');
}

/**
 * Log in as an election manager by inserting and leaving the election manager
 * card in place.
 */
export async function insertElectionManagerCardAndLogin(
  page: Page,
  electionPath?: string,
  outputDir?: string,
): Promise<MockCardController> {
  logger.step('Logging in as Election Manager');

  const cardController = createMockCardController();

  // Set election if provided
  if (electionPath) {
    await cardController.setElection(electionPath);
  }

  // Insert election manager card
  await cardController.insertCard('election_manager');

  // Enter PIN
  await enterPin(page, DEFAULT_PIN, outputDir);

  logger.debug('Logged in as Election Manager');
  return cardController;
}

/**
 * Log in as a poll worker by inserting and leaving the poll worker card in
 * place.
 */
export async function insertPollWorkerCardAndLogin(
  _page: Page,
  electionPath?: string,
): Promise<MockCardController> {
  logger.step('Logging in as Poll Worker');

  const cardController = createMockCardController();

  // Set election if provided
  if (electionPath) {
    await cardController.setElection(electionPath);
  }

  // Insert poll worker card
  await cardController.insertCard('poll_worker');

  logger.debug('Logged in as Poll Worker');

  return cardController;
}

/**
 * Log out by clicking Lock Machine (used with dipped login methods).
 */
export async function logOut(page: Page): Promise<void> {
  logger.debug('Logging out');

  await clickTextInApp(page, 'Lock Machine');

  // Wait for the locked state in the main app
  await waitForTextInApp(page, 'Locked', { timeout: 5000 });
}
