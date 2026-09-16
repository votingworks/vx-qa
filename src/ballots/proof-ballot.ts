/**
 * Proof ballot generation - overlay contest/candidate labels on ballot PDFs
 * for visual verification of bubble-to-contest mapping.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type {
  Election,
  GridPosition,
  GridPositionWriteIn,
  OptionBoundsFromTargetMark,
  Rect,
} from './election-loader.ts';

const IN = 72; // PDF points per inch

const PAGE_MARGINS = { left: 0.19685 * IN, top: 0.16667 * IN } as const;
const TIMING_MARK = { width: 0.1875 * IN, height: 0.0625 * IN } as const;

export interface PageGeometry {
  readonly originX: number;
  readonly originY: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly markCountX: number;
  readonly markCountY: number;
  readonly pageHeight: number;
}

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  custom17: { width: 8.5, height: 17 },
  custom18: { width: 8.5, height: 18 },
  custom22: { width: 8.5, height: 22 },
};

export function getPageGeometry(paperSize: string): PageGeometry {
  const size = PAPER_SIZES[paperSize];
  if (!size) {
    throw new Error(`Unsupported paper size: ${paperSize}`);
  }

  const pageWidthPt = size.width * IN;
  const pageHeightPt = size.height * IN;

  const markCountX = size.width * 4;
  const markCountY = size.height * 4 - 3;

  const originX = PAGE_MARGINS.left + TIMING_MARK.width / 2;
  const originY = PAGE_MARGINS.top + TIMING_MARK.height / 2;

  const gridWidth = pageWidthPt - 2 * PAGE_MARGINS.left - TIMING_MARK.width;
  const gridHeight = pageHeightPt - 2 * PAGE_MARGINS.top - TIMING_MARK.height;

  return {
    originX,
    originY,
    gridWidth,
    gridHeight,
    markCountX,
    markCountY,
    pageHeight: pageHeightPt,
  };
}

export function gridToPdf(
  column: number,
  row: number,
  geometry: PageGeometry,
): { x: number; y: number } {
  const x = geometry.originX + (column / (geometry.markCountX - 1)) * geometry.gridWidth;
  // PDF y-axis is bottom-up, grid row 0 is at top
  const topDownY = geometry.originY + (row / (geometry.markCountY - 1)) * geometry.gridHeight;
  const y = geometry.pageHeight - topDownY;
  return { x, y };
}

export function gridRectToPdfRect(
  rect: Rect,
  geometry: PageGeometry,
): { x: number; y: number; width: number; height: number } {
  const topLeft = gridToPdf(rect.x, rect.y, geometry);
  const bottomRight = gridToPdf(rect.x + rect.width, rect.y + rect.height, geometry);
  return {
    x: topLeft.x,
    y: bottomRight.y,
    width: bottomRight.x - topLeft.x,
    height: topLeft.y - bottomRight.y,
  };
}

export function writeInCropArea(
  gridPosition: GridPosition,
  optionBoundsFromTargetMark: OptionBoundsFromTargetMark,
): Rect {
  if (gridPosition.bounds) {
    return gridPosition.bounds;
  }

  const { top, right, bottom, left } = optionBoundsFromTargetMark;
  return {
    x: gridPosition.column - left,
    y: gridPosition.row - top,
    width: left + right,
    height: top + bottom,
  };
}

function fitText(
  text: string,
  maxWidth: number,
  font: PDFFont,
  maxSize: number,
  minSize: number,
): { text: string; fontSize: number } {
  for (let size = maxSize; size >= minSize; size -= 0.5) {
    const width = font.widthOfTextAtSize(text, size);
    if (width <= maxWidth) {
      return { text, fontSize: size };
    }
  }

  // Truncate with ellipsis at minimum size
  let truncated = text;
  while (truncated.length > 1) {
    truncated = truncated.slice(0, -1);
    const width = font.widthOfTextAtSize(`${truncated}…`, minSize);
    if (width <= maxWidth) {
      return { text: `${truncated}…`, fontSize: minSize };
    }
  }

  return { text: '…', fontSize: minSize };
}

export function getOptionLabel(election: Election, gridPosition: GridPosition): string {
  const contest = election.contests.find((c) => c.id === gridPosition.contestId);
  if (!contest) return gridPosition.contestId;

  if (gridPosition.type === 'write-in') {
    return `Write-in #${gridPosition.writeInIndex + 1}`;
  }

  if (contest.type === 'candidate') {
    const candidate = contest.candidates.find((c) => c.id === gridPosition.optionId);
    return candidate?.name ?? gridPosition.optionId;
  }

  if (contest.type === 'yesno') {
    // v4.1+ ballot measures may carry options beyond yes/no.
    const options = contest.options ?? [contest.yesOption, contest.noOption];
    return (
      options.find((option) => option.id === gridPosition.optionId)?.label ?? gridPosition.optionId
    );
  }

  return gridPosition.optionId;
}

/**
 * Which side of the target mark an option's label goes on.
 */
export function labelSide(bounds: OptionBoundsFromTargetMark): 'left' | 'right' {
  return bounds.right > bounds.left ? 'right' : 'left';
}

function addProofAnnotationsToPage(
  page: PDFPage,
  gridPositions: GridPosition[],
  geometry: PageGeometry,
  fonts: Fonts,
  election: Election,
  optionBoundsFromTargetMark: OptionBoundsFromTargetMark,
): void {
  const labelMaxWidth = 120;
  const labelPadding = 2;
  const labelGap = 8;
  const side = labelSide(optionBoundsFromTargetMark);

  for (const gp of gridPositions) {
    const { x, y } = gridToPdf(gp.column, gp.row, geometry);

    // Draw red X at bubble position
    const xSize = 3;
    const xColor = rgb(1, 0, 0);
    page.drawLine({
      start: { x: x - xSize, y: y - xSize },
      end: { x: x + xSize, y: y + xSize },
      thickness: 1,
      color: xColor,
    });
    page.drawLine({
      start: { x: x - xSize, y: y + xSize },
      end: { x: x + xSize, y: y - xSize },
      thickness: 1,
      color: xColor,
    });

    // Get label text
    const contest = election.contests.find((c) => c.id === gp.contestId);
    const contestTitle = contest?.title ?? gp.contestId;
    const optionLabel = getOptionLabel(election, gp);

    const optionFit = fitText(optionLabel, labelMaxWidth - 2 * labelPadding, fonts.bold, 7, 4);
    const contestFit = fitText(
      contestTitle,
      labelMaxWidth - 2 * labelPadding,
      fonts.regular,
      5.5,
      3.5,
    );

    if (gp.type !== 'write-in') {
      const lineHeight = 1.2;
      const optionHeight = optionFit.fontSize * lineHeight;
      const contestHeight = contestFit.fontSize * lineHeight;
      const boxHeight = optionHeight + contestHeight + 2 * labelPadding;
      const boxX = side === 'left' ? x - labelMaxWidth - labelGap : x + labelGap;
      const boxY = y - boxHeight / 2;

      // Draw label background
      page.drawRectangle({
        x: boxX,
        y: boxY,
        width: labelMaxWidth,
        height: boxHeight,
        color: rgb(0.85, 1, 0.85),
        opacity: 0.8,
        borderColor: rgb(0, 0.5, 0),
        borderWidth: 0.5,
      });

      // Draw option name (bold, top)
      page.drawText(optionFit.text, {
        x: boxX + labelPadding,
        y: boxY + boxHeight - labelPadding - optionFit.fontSize,
        size: optionFit.fontSize,
        font: fonts.bold,
        color: rgb(0, 0, 0),
      });

      // Draw contest title (regular, bottom)
      page.drawText(contestFit.text, {
        x: boxX + labelPadding,
        y: boxY + labelPadding,
        size: contestFit.fontSize,
        font: fonts.regular,
        color: rgb(0.3, 0.3, 0.3),
      });
    } else {
      drawUnmarkedWriteInArea(page, gp, geometry, fonts, contestTitle);
      drawWriteInCropArea(page, gp, geometry, fonts, contestTitle, optionBoundsFromTargetMark);
    }
  }
}

const UNMARKED_WRITE_IN_AREA_FILL = rgb(0.96, 0.87, 0.7);
const UNMARKED_WRITE_IN_AREA_BORDER = rgb(0.7, 0.5, 0.2);
const UNMARKED_WRITE_IN_AREA_TEXT = rgb(0.4, 0.3, 0.1);
const WRITE_IN_CROP_AREA_BORDER = rgb(0.1, 0.3, 0.75);
const WRITE_IN_CROP_AREA_TEXT = rgb(0.1, 0.25, 0.6);

function writeInLabel(gp: GridPositionWriteIn, contestTitle: string): string {
  return `Write-in #${gp.writeInIndex + 1} — ${contestTitle}`;
}

function drawUnmarkedWriteInArea(
  page: PDFPage,
  gp: GridPositionWriteIn,
  geometry: PageGeometry,
  fonts: Fonts,
  contestTitle: string,
): void {
  const rect = gridRectToPdfRect(gp.writeInArea, geometry);
  page.drawRectangle({
    ...rect,
    color: UNMARKED_WRITE_IN_AREA_FILL,
    opacity: 0.5,
    borderColor: UNMARKED_WRITE_IN_AREA_BORDER,
    borderWidth: 0.5,
  });

  const label = fitText(writeInLabel(gp, contestTitle), rect.width - 4, fonts.regular, 6, 3.5);
  page.drawText(label.text, {
    x: rect.x + 2,
    y: rect.y + rect.height - label.fontSize - 2,
    size: label.fontSize,
    font: fonts.regular,
    color: UNMARKED_WRITE_IN_AREA_TEXT,
  });
}

function drawWriteInCropArea(
  page: PDFPage,
  gp: GridPositionWriteIn,
  geometry: PageGeometry,
  fonts: Fonts,
  contestTitle: string,
  optionBoundsFromTargetMark: OptionBoundsFromTargetMark,
): void {
  const rect = gridRectToPdfRect(writeInCropArea(gp, optionBoundsFromTargetMark), geometry);
  page.drawRectangle({
    ...rect,
    borderColor: WRITE_IN_CROP_AREA_BORDER,
    borderWidth: 0.75,
    borderDashArray: [3, 2],
  });

  const label = fitText(writeInLabel(gp, contestTitle), rect.width - 4, fonts.bold, 5.5, 3.5);
  page.drawText(label.text, {
    x: rect.x + 2,
    y: rect.y + 2,
    size: label.fontSize,
    font: fonts.bold,
    color: WRITE_IN_CROP_AREA_TEXT,
  });
}

export async function generateProofBallot(
  election: Election,
  ballotStyleId: string,
  baseBallotPdf: Uint8Array,
): Promise<Uint8Array> {
  const gridLayout = election.gridLayouts?.find((gl) => gl.ballotStyleId === ballotStyleId);
  if (!gridLayout) {
    throw new Error(`No grid layout found for ballot style: ${ballotStyleId}`);
  }

  const geometry = getPageGeometry(election.ballotLayout.paperSize);
  const pdfDoc = await PDFDocument.load(baseBallotPdf);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold };

  const pages = pdfDoc.getPages();

  // Group grid positions by page (sheetNumber + side)
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const sheetNumber = Math.floor(pageIndex / 2) + 1;
    const side = pageIndex % 2 === 0 ? 'front' : 'back';
    const pagePositions = gridLayout.gridPositions.filter(
      (gp) => gp.sheetNumber === sheetNumber && gp.side === side,
    );

    if (pagePositions.length > 0) {
      addProofAnnotationsToPage(
        pages[pageIndex],
        pagePositions,
        geometry,
        fonts,
        election,
        gridLayout.optionBoundsFromTargetMark,
      );
    }
  }

  return pdfDoc.save();
}
