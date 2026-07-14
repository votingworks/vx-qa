/**
 * Mock USB drive control via dev-dock API
 */

import { basename, dirname, join } from 'node:path';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createDevDockClient, type DevDockClient } from './client.js';
import { logger } from '../utils/logger.js';

export type UsbDriveStatus = 'inserted' | 'removed';

export interface MockUsbController {
  /**
   * Insert the mock USB drive
   */
  insert(): Promise<void>;

  /**
   * Remove the mock USB drive
   */
  remove(): Promise<void>;

  /**
   * Clear all data from the mock USB drive
   */
  clear(): Promise<void>;

  /**
   * Get the current USB drive status
   */
  getStatus(): Promise<UsbDriveStatus>;

  /**
   * Get the path to the mock USB data directory
   */
  getDataPath(): string;

  /**
   * Copy a file to the mock USB drive
   */
  copyFile(sourcePath: string, destName?: string): Promise<string>;

  /**
   * Copy a directory to the mock USB drive
   */
  copyDirectory(sourcePath: string, destName?: string): Promise<string>;

  /**
   * Write content directly to a file on the USB drive
   */
  writeFile(fileName: string, content: Buffer | string): Promise<string>;
}

/**
 * Create a mock USB controller
 */
export function createMockUsbController({ dataPath }: { dataPath: string }): MockUsbController {
  const client: DevDockClient = createDevDockClient();

  // v4.1's simulated USB platform tracks drives in a manifest and only
  // allocates a disk's backing storage directory the first time it's
  // inserted (dev-dock's insertUsbDrive -> createDrive -> reinitStorage,
  // which wipes-and-recreates the directory). Since files are written here
  // directly to `dataPath` on disk rather than through the dev-dock API, a
  // write that happens before that disk has ever been inserted gets erased
  // the moment insert() is next called. Priming with an insert+remove pair
  // (idempotent if the drive already exists) guarantees the drive -- and its
  // storage directory -- exists before anything is written to it.
  let drivePrimed = false;
  async function ensureDriveExists(): Promise<void> {
    if (drivePrimed) {
      return;
    }
    await client.call('insertUsbDrive', {});
    await client.call('removeUsbDrive', {});
    drivePrimed = true;
  }

  return {
    async insert(): Promise<void> {
      logger.debug('Inserting USB drive');
      await client.call('insertUsbDrive', {});
    },

    async remove(): Promise<void> {
      logger.debug('Removing USB drive');
      await client.call('removeUsbDrive', {});
    },

    async clear(): Promise<void> {
      logger.debug('Clearing USB drive');
      await client.call('clearUsbDrive', {});
    },

    async getStatus(): Promise<UsbDriveStatus> {
      return await client.call<UsbDriveStatus>('getUsbDriveStatus', {});
    },

    getDataPath(): string {
      return dataPath;
    },

    async copyFile(sourcePath: string, destName?: string): Promise<string> {
      await ensureDriveExists();
      const fileName = destName || basename(sourcePath);
      const destPath = join(dataPath, fileName);
      await mkdir(dirname(destPath), { recursive: true });
      await cp(sourcePath, destPath);
      logger.debug(`Copied ${sourcePath} to USB as ${fileName}`);
      return destPath;
    },

    async copyDirectory(sourcePath: string, destName?: string): Promise<string> {
      await ensureDriveExists();
      const dirName = destName || basename(sourcePath);
      const destPath = join(dataPath, dirName);
      await mkdir(dirname(destPath), { recursive: true });
      await cp(sourcePath, destPath, { recursive: true });
      logger.debug(`Copied directory ${sourcePath} to USB as ${dirName}`);
      return destPath;
    },

    async writeFile(fileName: string, content: Buffer | string): Promise<string> {
      await ensureDriveExists();
      const filePath = join(dataPath, fileName);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      logger.debug(`Wrote ${fileName} to USB`);
      return filePath;
    },
  };
}
