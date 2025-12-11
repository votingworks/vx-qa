/**
 * Mock USB drive control via dev-dock API
 */

import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { cp, writeFile } from 'fs/promises';
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

  /**
   * List files on the USB drive
   */
  listFiles(): string[];
}

/**
 * Create a mock USB controller
 */
export function createMockUsbController({ dataPath }: { port?: number; dataPath: string }): MockUsbController {
  const client: DevDockClient = createDevDockClient();

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
      const fileName = destName || basename(sourcePath);
      const destPath = join(dataPath, fileName);
      await cp(sourcePath, destPath);
      logger.debug(`Copied ${sourcePath} to USB as ${fileName}`);
      return destPath;
    },

    async copyDirectory(sourcePath: string, destName?: string): Promise<string> {
      const dirName = destName || basename(sourcePath);
      const destPath = join(dataPath, dirName);
      await cp(sourcePath, destPath, { recursive: true });
      logger.debug(`Copied directory ${sourcePath} to USB as ${dirName}`);
      return destPath;
    },

    async writeFile(fileName: string, content: Buffer | string): Promise<string> {
      const filePath = join(dataPath, fileName);
      await writeFile(filePath, content);
      logger.debug(`Wrote ${fileName} to USB`);
      return filePath;
    },

    listFiles(): string[] {
      if (!existsSync(dataPath)) {
        return [];
      }
      return readdirSync(dataPath);
    },
  };
}
