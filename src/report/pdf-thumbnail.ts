/**
 * PDF thumbnail generation using pdf-to-img
 */

import { pdf } from 'pdf-to-img';
import { logger } from '../utils/logger.js';

/**
 * Generate a thumbnail of the first page of a PDF
 * Returns a data URL containing a base64-encoded PNG, or null if generation fails
 */
export async function generatePdfThumbnail(
  pdfPath: string,
  { scale = 0.5 }: { scale?: number } = {},
): Promise<string | null> {
  try {
    const document = await pdf(pdfPath, { scale });

    // Get the first page
    for await (const image of document) {
      // Convert buffer to base64 data URL
      const base64 = image.toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;

      logger.debug(`Generated thumbnail for ${pdfPath}`);
      return dataUrl;
    }

    return null;
  } catch (error) {
    logger.warn(`Failed to generate thumbnail for PDF ${pdfPath}: ${(error as Error).message}`);
    return null;
  }
}
