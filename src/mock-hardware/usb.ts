/**
 * Mock USB drive control via dev-dock API and file system
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { rm, cp } from 'fs/promises';
import { createDevDockClient, type DevDockClient } from './client.js';
import { logger } from '../utils/logger.js';
import { MOCK_STATE_DIRS, ensureDir } from '../utils/paths.js';

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
export function createMockUsbController(port = 3004): MockUsbController {
  const client: DevDockClient = createDevDockClient(port);
  const dataPath = join(MOCK_STATE_DIRS.usb, 'mock-usb-data');

  return {
    async insert(): Promise<void> {
      // Ensure data directory exists
      ensureDir(dataPath);

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

      // Also clear the data directory
      if (existsSync(dataPath)) {
        await rm(dataPath, { recursive: true, force: true });
      }
      ensureDir(dataPath);
    },

    async getStatus(): Promise<UsbDriveStatus> {
      return await client.call<UsbDriveStatus>('getUsbDriveStatus', {});
    },

    getDataPath(): string {
      return dataPath;
    },

    async copyFile(sourcePath: string, destName?: string): Promise<string> {
      ensureDir(dataPath);
      const fileName = destName || sourcePath.split('/').pop() || 'file';
      const destPath = join(dataPath, fileName);
      await cp(sourcePath, destPath);
      logger.debug(`Copied ${sourcePath} to USB as ${fileName}`);
      return destPath;
    },

    async copyDirectory(sourcePath: string, destName?: string): Promise<string> {
      ensureDir(dataPath);
      const dirName = destName || sourcePath.split('/').pop() || 'dir';
      const destPath = join(dataPath, dirName);
      await cp(sourcePath, destPath, { recursive: true });
      logger.debug(`Copied directory ${sourcePath} to USB as ${dirName}`);
      return destPath;
    },

    writeFile(fileName: string, content: Buffer | string): Promise<string> {
      ensureDir(dataPath);
      const filePath = join(dataPath, fileName);
      writeFileSync(filePath, content);
      logger.debug(`Wrote ${fileName} to USB`);
      return Promise.resolve(filePath);
    },

    listFiles(): string[] {
      if (!existsSync(dataPath)) {
        return [];
      }
      return readdirSync(dataPath);
    },
  };
}

/**
 * Get the mock USB data path
 */
export function getMockUsbDataPath(): string {
  return join(MOCK_STATE_DIRS.usb, 'mock-usb-data');
}
