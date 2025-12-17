/**
 * Authentication helpers for VxSuite apps
 *
 * Based on patterns from apps/admin/integration-testing/e2e/support/auth.ts
 */

import { Page } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { createMockCardController, DEFAULT_PIN } from '../mock-hardware/cards.js';
import { waitForText, clickButton } from './browser.js';

/**
 * Enter the PIN on the PIN pad screen
 */
export async function enterPin(page: Page, pin = DEFAULT_PIN): Promise<void> {
  logger.debug('Entering PIN');

  await waitForText(page, 'Enter Card PIN');

  for (const digit of pin) {
    await page.getByRole('button', { name: digit }).click();
  }

  // Wait for the "remove card" prompt
  await waitForText(page, 'Remove card', { timeout: 5000 });
}

/**
 * Log in as a system administrator
 */
export async function logInAsSystemAdministrator(
  page: Page,
  electionPath?: string
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
  await enterPin(page);

  // Remove card
  await cardController.removeCard();

  // Wait for the logged-in state
  await waitForText(page, 'Lock Machine', { timeout: 10000 });

  logger.debug('Logged in as System Administrator');
}

/**
 * Log in as an election manager
 */
export async function logInAsElectionManager(
  page: Page,
  electionPath?: string
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
  await enterPin(page);

  // Remove card
  await cardController.removeCard();

  // Wait for the logged-in state
  await waitForText(page, 'Lock Machine', { timeout: 10000 });

  logger.debug('Logged in as Election Manager');
}

/**
 * Log in as a poll worker
 */
export async function logInAsPollWorker(
  page: Page,
  electionPath?: string
): Promise<void> {
  logger.step('Logging in as Poll Worker');

  const cardController = createMockCardController();

  // Set election if provided
  if (electionPath) {
    await cardController.setElection(electionPath);
  }

  // Insert poll worker card
  await cardController.insertCard('poll_worker');

  // Enter PIN
  await enterPin(page);

  // Remove card
  await cardController.removeCard();

  logger.debug('Logged in as Poll Worker');
}

/**
 * Log out by clicking Lock Machine
 */
export async function logOut(page: Page): Promise<void> {
  logger.debug('Logging out');

  await clickButton(page, 'Lock Machine');

  // Wait for the locked state
  await waitForText(page, 'Locked', { timeout: 5000 });
}

/**
 * Force log out via API (bypassing UI)
 */
export async function forceLogOut(page: Page): Promise<void> {
  logger.debug('Force logging out via API');

  await page.request.post('http://localhost:3000/api/logOut', {
    data: '{}',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Check if currently logged in
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.getByText('Lock Machine').waitFor({ timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the machine locked screen
 */
export async function waitForLockedScreen(page: Page): Promise<void> {
  await waitForText(page, 'Locked', { timeout: 10000 });
}
