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
    timeout?: number
  ): Promise<SheetStatus>;
}

/**
 * Create a mock scanner controller
 */
export function createMockScannerController(port = 3004): MockScannerController {
  const client: DevDockClient = createDevDockClient(port);

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
      timeout = 10000
    ): Promise<SheetStatus> {
      const expected = Array.isArray(expectedStatus)
        ? expectedStatus
        : [expectedStatus];

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
        `Timeout waiting for sheet status ${expected.join(' or ')}, current: ${currentStatus}`
      );
    },
  };
}

/**
 * Mock printer control via dev-dock API
 */
export interface MockPrinterController {
  /**
   * Get the printer status
   */
  getStatus(): Promise<{ connected: boolean }>;

  /**
   * Connect the mock printer
   */
  connect(): Promise<void>;

  /**
   * Disconnect the mock printer
   */
  disconnect(): Promise<void>;

  /**
   * Get the path to the last printed file
   */
  getLastPrintPath(): Promise<string | null>;
}

/**
 * Create a mock printer controller
 */
export function createMockPrinterController(port = 3004): MockPrinterController {
  const client: DevDockClient = createDevDockClient(port);

  return {
    async getStatus(): Promise<{ connected: boolean }> {
      const status = await client.call<{ connected: boolean }>('getPrinterStatus', {});
      return status;
    },

    async connect(): Promise<void> {
      logger.debug('Connecting printer');
      await client.call('connectPrinter', {});
    },

    async disconnect(): Promise<void> {
      logger.debug('Disconnecting printer');
      await client.call('disconnectPrinter', {});
    },

    async getLastPrintPath(): Promise<string | null> {
      // The mock printer saves prints to /tmp/mock-printer/prints/
      const { readdirSync, statSync } = await import('fs');
      const { join } = await import('path');

      const printsDir = '/tmp/mock-printer/prints';
      try {
        const files = readdirSync(printsDir);
        if (files.length === 0) {
          return null;
        }

        // Get the most recent file
        const sortedFiles = files
          .map((f) => ({
            name: f,
            time: statSync(join(printsDir, f)).mtime.getTime(),
          }))
          .sort((a, b) => b.time - a.time);

        return join(printsDir, sortedFiles[0].name);
      } catch {
        return null;
      }
    },
  };
}
