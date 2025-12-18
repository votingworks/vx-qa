/**
 * Mock PDI scanner control via dev-dock API
 */

import { createDevDockClient, type DevDockClient } from './client.js';
import { logger } from '../utils/logger.js';

export type SheetStatus = 'noSheet' | 'sheetInserted' | 'sheetHeldInFront' | 'sheetHeldInBack';

export interface MockScannerController {
  /**
   * Insert a ballot sheet (PDF) into the scanner
   */
  insertSheet(pdfPath: string): Promise<void>;

  /**
   * Remove the current sheet from the scanner
   */
  removeSheet(): Promise<void>;

  /**
   * Get the current sheet status
   */
  getSheetStatus(): Promise<SheetStatus>;

  /**
   * Wait for a specific sheet status
   */
  waitForStatus(
    expectedStatus: SheetStatus | SheetStatus[],
    timeout?: number,
  ): Promise<SheetStatus>;
}

/**
 * Create a mock scanner controller
 */
export function createMockScannerController(): MockScannerController {
  const client: DevDockClient = createDevDockClient();

  return {
    async insertSheet(pdfPath: string): Promise<void> {
      logger.debug(`Inserting sheet: ${pdfPath}`);
      await client.call('pdiScannerInsertSheet', { path: pdfPath });
    },

    async removeSheet(): Promise<void> {
      logger.debug('Removing sheet');
      await client.call('pdiScannerRemoveSheet', {});
    },

    async getSheetStatus(): Promise<SheetStatus> {
      return await client.call<SheetStatus>('pdiScannerGetSheetStatus', {});
    },

    async waitForStatus(
      expectedStatus: SheetStatus | SheetStatus[],
      timeout = 10000,
    ): Promise<SheetStatus> {
      const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const status = await this.getSheetStatus();
        if (expected.includes(status)) {
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const currentStatus = await this.getSheetStatus();
      throw new Error(
        `Timeout waiting for sheet status ${expected.join(' or ')}, current: ${currentStatus}`,
      );
    },
  };
}
