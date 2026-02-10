import { describe, test, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateProofBallot, getPageGeometry, gridToPdf, getOptionLabel } from './proof-ballot.js';
import { loadElectionPackage } from './election-loader.js';
import { expectToMatchPdfSnapshot } from '../test/pdf-snapshot.js';
import type {
  Election,
  CandidateContest,
  YesNoContest,
  GridPositionOption,
  GridPositionWriteIn,
  GridPosition,
  ElectionPackage,
  ElectionDefinition,
  BallotPdfInfo,
} from './election-loader.js';

const IN = 72;

function createTestElection(
  contests: (CandidateContest | YesNoContest)[],
  gridPositions: GridPosition[] = [],
): Election {
  return {
    title: 'Test Election',
    state: 'CA',
    county: { id: 'county-1', name: 'Test County' },
    date: '2024-11-05',
    type: 'general',
    ballotStyles: [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: contests.map((c) => c.districtId),
      },
    ],
    precincts: [{ id: 'precinct-1', name: 'Precinct 1' }],
    contests,
    ballotLayout: {
      paperSize: 'letter',
      metadataEncoding: 'qr-code',
    },
    gridLayouts: [
      {
        ballotStyleId: 'ballot-style-1',
        optionBoundsFromTargetMark: { x: 0, y: 0, width: 1, height: 1 },
        gridPositions,
      },
    ],
  };
}

async function createBlankPdf({ pageCount = 2 }: { pageCount?: number } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage([8.5 * IN, 11 * IN]);
  }
  return doc.save();
}

describe('getPageGeometry', () => {
  test('compute letter geometry', () => {
    const geo = getPageGeometry('letter');

    expect(geo.markCountX).toBe(34);
    expect(geo.markCountY).toBe(41);
    expect(geo.pageHeight).toBe(11 * IN);
    expect(geo.originX).toBeCloseTo(0.19685 * IN + (0.1875 * IN) / 2);
    expect(geo.originY).toBeCloseTo(0.16667 * IN + (0.0625 * IN) / 2);
    expect(geo.gridWidth).toBeGreaterThan(0);
    expect(geo.gridHeight).toBeGreaterThan(0);
  });

  test('compute legal geometry', () => {
    const geo = getPageGeometry('legal');

    expect(geo.markCountX).toBe(34);
    expect(geo.markCountY).toBe(53);
    expect(geo.pageHeight).toBe(14 * IN);
  });

  test('throw for unsupported paper size', () => {
    expect(() => getPageGeometry('tabloid')).toThrow('Unsupported paper size: tabloid');
  });

  test('grid dimensions are consistent with page size minus margins and marks', () => {
    const geo = getPageGeometry('letter');
    const expectedWidth = 8.5 * IN - 2 * 0.19685 * IN - 0.1875 * IN;
    const expectedHeight = 11 * IN - 2 * 0.16667 * IN - 0.0625 * IN;

    expect(geo.gridWidth).toBeCloseTo(expectedWidth, 5);
    expect(geo.gridHeight).toBeCloseTo(expectedHeight, 5);
  });
});

describe('gridToPdf', () => {
  test('top-left corner maps to origin with y flipped', () => {
    const geo = getPageGeometry('letter');
    const { x, y } = gridToPdf(0, 0, geo);

    expect(x).toBeCloseTo(geo.originX);
    expect(y).toBeCloseTo(geo.pageHeight - geo.originY);
  });

  test('bottom-right corner maps to origin + grid size', () => {
    const geo = getPageGeometry('letter');
    const { x, y } = gridToPdf(geo.markCountX - 1, geo.markCountY - 1, geo);

    expect(x).toBeCloseTo(geo.originX + geo.gridWidth);
    expect(y).toBeCloseTo(geo.pageHeight - geo.originY - geo.gridHeight);
  });

  test('midpoint maps to center of grid', () => {
    const geo = getPageGeometry('letter');
    const midCol = (geo.markCountX - 1) / 2;
    const midRow = (geo.markCountY - 1) / 2;
    const { x, y } = gridToPdf(midCol, midRow, geo);

    expect(x).toBeCloseTo(geo.originX + geo.gridWidth / 2);
    expect(y).toBeCloseTo(geo.pageHeight - geo.originY - geo.gridHeight / 2);
  });
});

describe('getOptionLabel', () => {
  const candidateContest: CandidateContest = {
    type: 'candidate',
    id: 'mayor',
    title: 'Mayor',
    seats: 1,
    candidates: [
      { id: 'alice', name: 'Alice Smith' },
      { id: 'bob', name: 'Bob Jones' },
    ],
    allowWriteIns: true,
    districtId: 'district-1',
  };

  const yesNoContest: YesNoContest = {
    type: 'yesno',
    id: 'measure-a',
    title: 'Measure A',
    yesOption: { id: 'yes-a', label: 'Yes on A' },
    noOption: { id: 'no-a', label: 'No on A' },
    districtId: 'district-1',
  };

  const election = createTestElection([candidateContest, yesNoContest]);

  test('return candidate name for option grid position', () => {
    const gp: GridPositionOption = {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 20,
      contestId: 'mayor',
      optionId: 'alice',
    };
    expect(getOptionLabel(election, gp)).toBe('Alice Smith');
  });

  test('return optionId when candidate not found', () => {
    const gp: GridPositionOption = {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 20,
      contestId: 'mayor',
      optionId: 'unknown-candidate',
    };
    expect(getOptionLabel(election, gp)).toBe('unknown-candidate');
  });

  test('return write-in label for write-in grid position', () => {
    const gp: GridPositionWriteIn = {
      type: 'write-in',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 25,
      contestId: 'mayor',
      writeInIndex: 0,
      writeInArea: { x: 5, y: 24, width: 20, height: 2 },
    };
    expect(getOptionLabel(election, gp)).toBe('Write-in #1');
  });

  test('return yes/no option labels', () => {
    const yesGp: GridPositionOption = {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 30,
      contestId: 'measure-a',
      optionId: 'yes-a',
    };
    const noGp: GridPositionOption = {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 31,
      contestId: 'measure-a',
      optionId: 'no-a',
    };
    expect(getOptionLabel(election, yesGp)).toBe('Yes on A');
    expect(getOptionLabel(election, noGp)).toBe('No on A');
  });

  test('return contestId when contest not found', () => {
    const gp: GridPositionOption = {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 20,
      contestId: 'nonexistent',
      optionId: 'whatever',
    };
    expect(getOptionLabel(election, gp)).toBe('nonexistent');
  });
});

describe('generateProofBallot', () => {
  const candidateContest: CandidateContest = {
    type: 'candidate',
    id: 'mayor',
    title: 'Mayor',
    seats: 2,
    candidates: [
      { id: 'alice', name: 'Alice Smith' },
      { id: 'bob', name: 'Bob Jones' },
    ],
    allowWriteIns: true,
    districtId: 'district-1',
  };

  const gridPositions: GridPosition[] = [
    {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 10,
      contestId: 'mayor',
      optionId: 'alice',
    },
    {
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 12,
      contestId: 'mayor',
      optionId: 'bob',
    },
    {
      type: 'write-in',
      sheetNumber: 1,
      side: 'front',
      column: 10,
      row: 14,
      contestId: 'mayor',
      writeInIndex: 0,
      writeInArea: { x: 11, y: 13, width: 20, height: 2 },
    },
    {
      type: 'option',
      sheetNumber: 1,
      side: 'back',
      column: 10,
      row: 10,
      contestId: 'measure-a',
      optionId: 'yes-a',
    },
    {
      type: 'option',
      sheetNumber: 1,
      side: 'back',
      column: 10,
      row: 12,
      contestId: 'measure-a',
      optionId: 'no-a',
    },
  ];

  test('throw when grid layout not found', async () => {
    const election = createTestElection([candidateContest], gridPositions);
    const basePdf = await createBlankPdf({ pageCount: 2 });

    await expect(generateProofBallot(election, 'nonexistent-style', basePdf)).rejects.toThrow(
      'No grid layout found for ballot style: nonexistent-style',
    );
  });

  test('handle pages with no grid positions', async () => {
    const frontOnlyPositions: GridPosition[] = [
      {
        type: 'option',
        sheetNumber: 1,
        side: 'front',
        column: 10,
        row: 10,
        contestId: 'mayor',
        optionId: 'alice',
      },
    ];
    const election = createTestElection([candidateContest], frontOnlyPositions);
    const basePdf = await createBlankPdf({ pageCount: 2 });
    const proofPdf = await generateProofBallot(election, 'ballot-style-1', basePdf);

    const doc = await PDFDocument.load(proofPdf);
    expect(doc.getPageCount()).toBe(2);
  });

  test('preserve original page dimensions', async () => {
    const election = createTestElection(
      [candidateContest],
      [
        {
          type: 'option',
          sheetNumber: 1,
          side: 'front',
          column: 5,
          row: 5,
          contestId: 'mayor',
          optionId: 'alice',
        },
      ],
    );
    const basePdf = await createBlankPdf({ pageCount: 1 });
    const proofPdf = await generateProofBallot(election, 'ballot-style-1', basePdf);

    const originalDoc = await PDFDocument.load(basePdf);
    const proofDoc = await PDFDocument.load(proofPdf);

    const originalPage = originalDoc.getPage(0);
    const proofPage = proofDoc.getPage(0);

    expect(proofPage.getWidth()).toBe(originalPage.getWidth());
    expect(proofPage.getHeight()).toBe(originalPage.getHeight());
  });
});

const FIXTURE_PATH = join(
  import.meta.dirname,
  '../../test-fixtures/election-package-and-ballots-e71c80e-c4446e7.zip',
);

const prooftest = test.extend<{
  tmp: string;
  electionPackage: ElectionPackage;
  electionDefinition: ElectionDefinition;
  election: Election;
  ballotStyle1: BallotPdfInfo;
  ballotStyle2: BallotPdfInfo;
}>({
  // eslint-disable-next-line no-empty-pattern
  tmp: async ({}, use) => {
    const path = await mkdtemp(join(tmpdir(), 'vx-qa-proof-test-'));
    await use(path);
    await rm(path, { recursive: true, force: true });
  },
  electionPackage: async ({ tmp }, use) =>
    use((await loadElectionPackage(FIXTURE_PATH, tmp)).electionPackage),
  electionDefinition: ({ electionPackage }, use) => use(electionPackage.electionDefinition),
  election: ({ electionDefinition }, use) => use(electionDefinition.election),
  ballotStyle1: ({ electionPackage }, use) =>
    use(
      electionPackage.ballots.find(
        (b) =>
          b.ballotStyleId === '1_en' && b.ballotMode === 'official' && b.ballotType === 'precinct',
      )!,
    ),
  ballotStyle2: ({ electionPackage }, use) =>
    use(
      electionPackage.ballots.find(
        (b) =>
          b.ballotStyleId === '2_en' && b.ballotMode === 'official' && b.ballotType === 'precinct',
      )!,
    ),
});

describe('generateProofBallot with real election fixture', async () => {
  prooftest('ballot style 1_en (2 pages)', async ({ election, ballotStyle1 }) => {
    const proofPdf = await generateProofBallot(
      election,
      ballotStyle1.ballotStyleId,
      ballotStyle1.pdfData,
    );

    const doc = await PDFDocument.load(proofPdf);
    expect(doc.getPageCount()).toBe(2);

    await expectToMatchPdfSnapshot(proofPdf, {
      customSnapshotIdentifier: 'fixture-proof-ballot-style-1_en',
    });
  });

  prooftest('ballot style 2_en (4 pages)', async ({ election, ballotStyle2 }) => {
    const proofPdf = await generateProofBallot(
      election,
      ballotStyle2.ballotStyleId,
      ballotStyle2.pdfData,
    );

    const doc = await PDFDocument.load(proofPdf);
    expect(doc.getPageCount()).toBe(4);

    await expectToMatchPdfSnapshot(proofPdf, {
      customSnapshotIdentifier: 'fixture-proof-ballot-style-2_en',
    });
  });
});
