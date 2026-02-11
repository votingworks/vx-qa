/**
 * PDF snapshot testing utility.
 *
 * Renders each page of a PDF to a PNG image and compares it against a stored
 * snapshot using jest-image-snapshot. Similar to vxsuite's toMatchPdfSnapshot.
 */

import { expect } from 'vitest';
import { pdf } from 'pdf-to-img';

export interface PdfSnapshotOptions {
  readonly customSnapshotIdentifier?: string;
  readonly failureThreshold?: number;
}

export async function expectToMatchPdfSnapshot(
  pdfBytes: Uint8Array,
  options: PdfSnapshotOptions = {},
): Promise<void> {
  const pages = await pdf(Buffer.from(pdfBytes), { scale: 2 });
  let pageNumber = 0;

  for await (const pageImage of pages) {
    pageNumber += 1;
    const identifier = options.customSnapshotIdentifier
      ? `${options.customSnapshotIdentifier}-page-${pageNumber}`
      : undefined;

    expect(pageImage).toMatchImageSnapshot({
      failureThreshold: options.failureThreshold ?? 0,
      failureThresholdType: 'percent',
      customSnapshotIdentifier: identifier,
    });
  }
}
