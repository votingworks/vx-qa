/**
 * Webhook client for sending status updates back to VxDesign.
 */

import { logger } from '../utils/logger.js';
import type { WebhookConfig } from '../config/types.js';

export async function sendWebhookUpdate(
  config: WebhookConfig,
  status: 'in_progress' | 'success' | 'failure',
  statusMessage?: string,
  resultsUrl?: string,
): Promise<void> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': config.secret,
      },
      body: JSON.stringify({
        status,
        statusMessage,
        resultsUrl,
      }),
    });

    if (!response.ok) {
      logger.warn(`Webhook request failed: ${response.status} ${response.statusText}`);
    } else {
      logger.debug(`Webhook update sent: status=${status}`);
    }
  } catch (error) {
    logger.warn(`Webhook request error: ${(error as Error).message}`);
  }
}
