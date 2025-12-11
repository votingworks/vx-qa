/**
 * HTTP client for communicating with the dev-dock API
 *
 * The dev-dock API runs at http://localhost:3004/dock when an app is started
 * with mock hardware enabled.
 */

import { logger } from '../utils/logger.js';

export interface DevDockClient {
  baseUrl: string;
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Create a dev-dock API client
 */
export function createDevDockClient(port = 3000): DevDockClient {
  const baseUrl = `http://localhost:${port}/dock`;

  return {
    baseUrl,
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      const url = `${baseUrl}/${method}`;
      logger.debug(`Calling dev-dock: ${method}`);

      try {
        console.log('POST', url, 'BODY', JSON.stringify(params || {}));
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(params || {}),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Dev-dock call failed: ${response.status} ${text}`);
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
          throw new Error(
            `Cannot connect to dev-dock at ${baseUrl}. Is the app running with mock hardware enabled?`
          );
        }
        throw error;
      }
    },
  };
}

/**
 * Wait for dev-dock to become available
 */
export async function waitForDevDock(
  port = 3004,
  timeout = 30000
): Promise<boolean> {
  const startTime = Date.now();
  const url = `http://localhost:${port}/dock/getMockSpec`;

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (response.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}
