/**
 * PDF to PNG rendering for ballot visualization
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

/**
 * Render a PDF to PNG images (one per page)
 *
 * This is a placeholder implementation. For full functionality,
 * we would use pdfjs-dist with canvas, or execute VxSuite's
 * image-utils library in the cloned repo.
 */
export async function renderPdfToPng(
  pdfBytes: Uint8Array,
  outputDir: string,
  baseName: string
): Promise<string[]> {
  logger.debug(`Rendering PDF to PNG: ${baseName}`);

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // For now, save the PDF directly and create a placeholder PNG
  // In a full implementation, we'd use pdfjs-dist + canvas

  const pdfPath = join(outputDir, `${baseName}.pdf`);
  writeFileSync(pdfPath, pdfBytes);

  // Try to use pdftoppm if available (from poppler-utils)
  try {
    const pngPaths = await renderWithPdftoppm(pdfPath, outputDir, baseName);
    if (pngPaths.length > 0) {
      return pngPaths;
    }
  } catch {
    logger.debug('pdftoppm not available, using fallback');
  }

  // Fallback: just return the PDF path
  logger.debug('PDF saved, PNG rendering not available');
  return [pdfPath];
}

/**
 * Render PDF using pdftoppm (from poppler-utils)
 */
async function renderWithPdftoppm(
  pdfPath: string,
  outputDir: string,
  baseName: string
): Promise<string[]> {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const outputPrefix = join(outputDir, baseName);

    const proc = spawn('pdftoppm', [
      '-png',
      '-r', '150', // 150 DPI
      pdfPath,
      outputPrefix,
    ]);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pdftoppm failed with code ${code}`));
        return;
      }

      // Find generated PNG files
      const files = readdirSync(outputDir)
        .filter((f: string) => f.startsWith(baseName) && f.endsWith('.png'))
        .map((f: string) => join(outputDir, f))
        .sort();

      resolve(files);
    });

    proc.on('error', reject);
  });
}

/**
 * Create a simple placeholder PNG image
 */
export async function createPlaceholderPng(
  text: string,
  outputPath: string
): Promise<void> {
  // This would use canvas to create a simple image
  // For now, we'll just note that the file should be created

  logger.debug(`Would create placeholder PNG at ${outputPath}: ${text}`);
}

/**
 * Save ballot artifacts to disk
 */
export async function saveBallotArtifacts(
  pdfBytes: Uint8Array,
  outputDir: string,
  ballotStyleId: string,
  pattern: string
): Promise<{
  pdfPath: string;
  pngPaths: string[];
}> {
  const baseName = `ballot-${ballotStyleId}-${pattern}`;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Save PDF
  const pdfPath = join(outputDir, `${baseName}.pdf`);
  writeFileSync(pdfPath, pdfBytes);

  // Render to PNG
  const pngPaths = await renderPdfToPng(pdfBytes, outputDir, baseName);

  logger.debug(`Saved ballot artifacts: ${pdfPath}`);

  return { pdfPath, pngPaths };
}
