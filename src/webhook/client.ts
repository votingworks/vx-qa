/**
 * Webhook client for sending status updates back to VxDesign.
 */

import { logger } from '../utils/logger.ts';
import type { WebhookConfig } from '../config/types.ts';
import { errorMessage } from '../utils/errors.ts';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001B\[[0-9;]*[a-zA-Z]/gu;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

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
        statusMessage:
          statusMessage !== undefined && statusMessage !== ''
            ? stripAnsi(statusMessage)
            : statusMessage,
        resultsUrl,
        jobUrl: process.env.CIRCLE_BUILD_URL,
      }),
    });

    if (!response.ok) {
      logger.warn(`Webhook request failed: ${response.status} ${response.statusText}`);
    } else {
      logger.debug(`Webhook update sent: status=${status}`);
    }
  } catch (error) {
    logger.warn(`Webhook request error: ${errorMessage(error)}`);
  }
}
