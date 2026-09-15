import { describe, expect, test } from 'vitest';
import {
  planBallotsToScan,
  scanExpectationsFromSystemSettings,
  type ScanExpectations,
} from './scan-plan.js';

const officialBallot = {
  ballotStyleId: '1',
  precinctId: 'p1',
  ballotMode: 'official',
  ballotType: 'precinct',
} as const;

const noReview: ScanExpectations = {
  blankBallotRequiresReview: false,
  overvoteRequiresReview: false,
  undervoteRequiresReview: false,
  disallowCastingOvervotes: false,
};

function outcomes(expectations: ScanExpectations, pattern: string): boolean[] {
  return planBallotsToScan(officialBallot, 'ballot.pdf', expectations)
    .filter((ballot) => ballot.pattern === pattern)
    .map((ballot) => ballot.expectedAccepted);
}

describe('scanExpectationsFromSystemSettings', () => {
  test('reads adjudication reasons and overvote casting', () => {
    expect(
      scanExpectationsFromSystemSettings({
        precinctScanAdjudicationReasons: ['Overvote', 'Undervote', 'BlankBallot'],
        disallowCastingOvervotes: true,
      }),
    ).toEqual({
      blankBallotRequiresReview: true,
      overvoteRequiresReview: true,
      undervoteRequiresReview: true,
      disallowCastingOvervotes: true,
    });
  });

  test('defaults everything off when settings are missing', () => {
    expect(scanExpectationsFromSystemSettings({})).toEqual(noReview);
  });
});

describe('planBallotsToScan', () => {
  test('test-mode ballots are scanned blank only and returned', () => {
    const plan = planBallotsToScan(
      { ...officialBallot, ballotMode: 'test' },
      'ballot.pdf',
      noReview,
    );
    expect(plan).toEqual([expect.objectContaining({ pattern: 'blank', expectedAccepted: false })]);
  });

  test('overvotes are counted when Overvote is not an adjudication reason', () => {
    expect(outcomes(noReview, 'overvote')).toEqual([true]);
  });

  test('disallowCastingOvervotes has no effect without the Overvote reason', () => {
    expect(outcomes({ ...noReview, disallowCastingOvervotes: true }, 'overvote')).toEqual([true]);
  });

  test('overvotes can only be returned when flagged and casting is disallowed', () => {
    expect(
      outcomes(
        { ...noReview, overvoteRequiresReview: true, disallowCastingOvervotes: true },
        'overvote',
      ),
    ).toEqual([false]);
  });

  test('flagged, castable overvotes exercise both voter choices', () => {
    expect(outcomes({ ...noReview, overvoteRequiresReview: true }, 'overvote')).toEqual([
      true,
      false,
    ]);
  });

  test('flagged undervotes exercise both voter choices', () => {
    expect(outcomes(noReview, 'undervote')).toEqual([true]);
    expect(outcomes({ ...noReview, undervoteRequiresReview: true }, 'undervote')).toEqual([
      true,
      false,
    ]);
  });

  test('blank and unmarked-write-in ballots follow the BlankBallot reason', () => {
    expect(outcomes(noReview, 'blank')).toEqual([true]);
    expect(outcomes(noReview, 'unmarked-write-in')).toEqual([true]);

    const flagged = { ...noReview, blankBallotRequiresReview: true };
    expect(outcomes(flagged, 'blank')).toEqual([false]);
    expect(outcomes(flagged, 'unmarked-write-in')).toEqual([false]);
  });

  test('every plan entry carries the ballot identity and PDF path', () => {
    for (const ballot of planBallotsToScan(officialBallot, 'ballot.pdf', noReview)) {
      expect(ballot).toMatchObject({ ...officialBallot, pdfPath: 'ballot.pdf' });
    }
  });
});
