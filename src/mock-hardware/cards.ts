/**
 * Mock smart card control via dev-dock API
 */

import { createDevDockClient, type DevDockClient } from './client.js';
import { logger } from '../utils/logger.js';

export type CardRole = 'system_administrator' | 'election_manager' | 'poll_worker';

export interface CardStatus {
  status: 'no_card' | 'ready' | 'error';
  cardDetails?: {
    user: {
      role: string;
      jurisdiction: string;
    };
  };
}

export interface MockCardController {
  /**
   * Set the election definition for card operations
   */
  setElection(electionPath: string): Promise<void>;

  /**
   * Insert a mock smart card with the specified role
   */
  insertCard(role: CardRole): Promise<void>;

  /**
   * Remove the currently inserted card
   */
  removeCard(): Promise<void>;

  /**
   * Get the current card status
   */
  getCardStatus(): Promise<CardStatus>;
}

/**
 * Create a mock card controller
 */
export function createMockCardController(): MockCardController {
  const client: DevDockClient = createDevDockClient();

  return {
    async setElection(electionPath: string): Promise<void> {
      logger.debug(`Setting election: ${electionPath}`);
      await client.call('setElection', { inputPath: electionPath });
    },

    async insertCard(role: CardRole): Promise<void> {
      logger.debug(`Inserting card: ${role}`);
      await client.call('insertCard', { role });
    },

    async removeCard(): Promise<void> {
      logger.debug('Removing card');
      await client.call('removeCard', {});
    },

    async getCardStatus(): Promise<CardStatus> {
      return await client.call<CardStatus>('getCardStatus', {});
    },
  };
}

/**
 * Default PIN for test cards
 */
export const DEFAULT_PIN = '000000';

/**
 * Enter PIN digits as an array for UI automation
 */
export function getPinDigits(): string[] {
  return DEFAULT_PIN.split('');
}
