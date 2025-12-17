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
export async function createBrowserSession(options: BrowserOptions = {}): Promise<BrowserSession> {
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
  await page.goto(url);
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
  options: { fullPage?: boolean } = {},
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
 * Uses first() to avoid strict mode violations when multiple elements match
 */
export async function waitForText(
  page: Page,
  text: string,
  options: { timeout?: number; exact?: boolean } = {},
): Promise<void> {
  const { timeout = 10000, exact = false } = options;

  if (exact) {
    await page.getByText(text, { exact: true }).first().waitFor({ timeout });
  } else {
    await page.getByText(text).first().waitFor({ timeout });
  }
}

/**
 * Click a button by its name/label
 */
export async function clickButton(
  page: Page,
  name: string,
  options: { exact?: boolean } = {},
): Promise<void> {
  const { exact = false } = options;
  await page.getByRole('button', { name, exact }).click();
}

/**
 * Check if text is visible on the page
 * Uses first() to avoid strict mode violations when multiple elements match
 */
export async function isTextVisible(page: Page, text: string): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ timeout: 1000 });
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

/**
 * Debug helper - dump current page state to console and take a screenshot
 */
export async function debugPageState(page: Page, label: string, outputDir?: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`DEBUG: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  // Get visible text content (first 2000 chars)
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => 'Could not get body text');
  console.log(`\nVisible text (truncated):\n${bodyText.slice(0, 2000)}`);

  // List all buttons
  const buttons = await page.getByRole('button').all();
  const buttonTexts = await Promise.all(
    buttons.slice(0, 20).map(async (btn) => {
      const text = await btn.innerText().catch(() => '(no text)');
      const isVisible = await btn.isVisible().catch(() => false);
      return `  - "${text}" (visible: ${isVisible})`;
    }),
  );
  console.log(`\nButtons (first 20):\n${buttonTexts.join('\n')}`);

  // List all links
  const links = await page.getByRole('link').all();
  const linkTexts = await Promise.all(
    links.slice(0, 20).map(async (link) => {
      const text = await link.innerText().catch(() => '(no text)');
      const href = await link.getAttribute('href').catch(() => '(no href)');
      const isVisible = await link.isVisible().catch(() => false);
      return `  - "${text}" -> ${href} (visible: ${isVisible})`;
    }),
  );
  console.log(`\nLinks (first 20):\n${linkTexts.join('\n')}`);

  // List all headings
  const headings = await page.locator('h1, h2, h3').all();
  const headingTexts = await Promise.all(
    headings.slice(0, 10).map(async (h) => {
      const text = await h.innerText().catch(() => '(no text)');
      return `  - ${text}`;
    }),
  );
  console.log(`\nHeadings:\n${headingTexts.join('\n')}`);

  // Take debug screenshot
  if (outputDir) {
    const screenshotPath = `${outputDir}/debug-${timestamp}-${label.replace(/\s+/g, '-')}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`\nScreenshot saved: ${screenshotPath}`);
  }

  console.log(`${'='.repeat(60)}\n`);
}

/**
 * Wait for text with debug on timeout
 */
export async function waitForTextWithDebug(
  page: Page,
  text: string,
  options: { timeout?: number; outputDir?: string; label?: string } = {},
): Promise<void> {
  const { timeout = 10000, outputDir, label } = options;

  try {
    await page.getByText(text).first().waitFor({ timeout });
  } catch (error) {
    await debugPageState(page, label || `Timeout waiting for text: "${text}"`, outputDir);
    throw error;
  }
}

/**
 * Click button with debug on failure
 */
export async function clickButtonWithDebug(
  page: Page,
  name: string,
  options: { timeout?: number; outputDir?: string; label?: string } = {},
): Promise<void> {
  const { timeout = 10000, outputDir, label } = options;

  try {
    await page.getByRole('button', { name }).click({ timeout });
  } catch (error) {
    await debugPageState(page, label || `Failed to click button: "${name}"`, outputDir);
    throw error;
  }
}

/**
 * Click link with debug on failure
 */
export async function clickLinkWithDebug(
  page: Page,
  name: string,
  options: { timeout?: number; outputDir?: string; label?: string } = {},
): Promise<void> {
  const { timeout = 10000, outputDir, label } = options;

  try {
    await page.getByRole('link', { name }).click({ timeout });
  } catch (error) {
    await debugPageState(page, label || `Failed to click link: "${name}"`, outputDir);
    throw error;
  }
}

/**
 * Get a locator for the main app content (excluding dev-dock)
 * The dev-dock is typically in an element with id="dev-dock" or similar
 */
export function getMainContent(page: Page) {
  // Try to find main content, excluding dev-dock area
  // Use :not() to exclude the dev-dock panel
  return page.locator('main, [data-testid="app-root"], #root').first();
}

/**
 * Wait for text in the main app content (excluding dev-dock)
 */
export async function waitForTextInApp(
  page: Page,
  text: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const { timeout = 10000 } = options;
  const mainContent = getMainContent(page);
  await mainContent.getByText(text).first().waitFor({ timeout });
}

/**
 * Click text in the main app content (excluding dev-dock)
 */
export async function clickTextInApp(page: Page, text: string): Promise<void> {
  const mainContent = getMainContent(page);
  await mainContent.getByText(text).first().click();
}

/**
 * Toggles the dev dock UI to either expand or contract.
 */
export async function toggleDevDock(page: Page): Promise<void> {
  return page.locator('#handle').click();
}
