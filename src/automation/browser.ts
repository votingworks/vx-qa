/**
 * Playwright browser setup and management
 */

import { chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { logger } from '../utils/logger.js';
import { APP_PORTS } from '../apps/env-config.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface BrowserOptions {
  headless?: boolean;
  slowMo?: number;
  viewport?: { width: number; height: number };
}

const DEFAULT_OPTIONS: BrowserOptions = {
  headless: true,
  slowMo: 0,
  viewport: { width: 1920, height: 1200 },
};

/**
 * Create a browser session for automation
 */
export async function createBrowserSession(
  options: BrowserOptions = {}
): Promise<BrowserSession> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  logger.debug(`Launching browser (headless: ${opts.headless})`);

  const browser = await chromium.launch({
    headless: opts.headless,
    slowMo: opts.slowMo,
  });

  const context = await browser.newContext({
    viewport: opts.viewport,
    ignoreHTTPSErrors: true,
    recordVideo: undefined, // Could enable video recording here
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Navigate to the app's main page
 */
export async function navigateToApp(page: Page): Promise<void> {
  const url = `http://localhost:${APP_PORTS.frontend}/`;
  logger.debug(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
}

/**
 * Wait for the page to be fully loaded
 */
export async function waitForPageLoad(page: Page, timeout = 10000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Take a screenshot and save it
 */
export async function takeScreenshot(
  page: Page,
  path: string,
  options: { fullPage?: boolean } = {}
): Promise<void> {
  await page.screenshot({
    path,
    fullPage: options.fullPage ?? false,
    animations: 'disabled',
  });
  logger.debug(`Screenshot saved: ${path}`);
}

/**
 * Wait for text to appear on the page
 */
export async function waitForText(
  page: Page,
  text: string,
  options: { timeout?: number; exact?: boolean } = {}
): Promise<void> {
  const { timeout = 10000, exact = false } = options;

  if (exact) {
    await page.getByText(text, { exact: true }).waitFor({ timeout });
  } else {
    await page.getByText(text).waitFor({ timeout });
  }
}

/**
 * Click a button by its name/label
 */
export async function clickButton(
  page: Page,
  name: string,
  options: { exact?: boolean } = {}
): Promise<void> {
  const { exact = false } = options;
  await page.getByRole('button', { name, exact }).click();
}

/**
 * Check if text is visible on the page
 */
export async function isTextVisible(page: Page, text: string): Promise<boolean> {
  try {
    await page.getByText(text).waitFor({ timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current URL
 */
export function getCurrentUrl(page: Page): string {
  return page.url();
}
