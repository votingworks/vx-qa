/**
 * Tests for election loading utilities
 */

import { describe, test, expect } from 'vitest';
import {
  getContestsForBallotStyle,
  normalizeGridLayouts,
  normalizeYesNoContests,
} from './election-loader.js';
import type {
  Election,
  CandidateContest,
  YesNoContest,
  BallotStyle,
  SheetPositions,
} from './election-loader.js';

/**
 * Helper to create a test election
 */
function createTestElection(
  ballotStyles: BallotStyle[],
  contests: (CandidateContest | YesNoContest)[],
): Election {
  return {
    title: 'Test Election',
    state: 'CA',
    county: { id: 'county-1', name: 'Test County' },
    date: '2024-11-05',
    type: 'general',
    ballotStyles,
    precincts: [
      { id: 'precinct-1', name: 'Precinct 1' },
      { id: 'precinct-2', name: 'Precinct 2' },
    ],
    contests,
    ballotLayout: {
      paperSize: 'letter',
      metadataEncoding: 'qr-code',
    },
  };
}

describe('getContestsForBallotStyle', () => {
  test('return contests for a given ballot style', () => {
    const contests: CandidateContest[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
      {
        type: 'candidate',
        id: 'city-council',
        title: 'City Council',
        seats: 2,
        candidates: [{ id: 'bob', name: 'Bob' }],
        allowWriteIns: false,
        districtId: 'district-2',
      },
    ];

    const ballotStyles: BallotStyle[] = [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: ['district-1'],
      },
    ];

    const election = createTestElection(ballotStyles, contests);
    const result = getContestsForBallotStyle(election, 'ballot-style-1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mayor');
  });

  test('return multiple contests for ballot style with multiple districts', () => {
    const contests: (CandidateContest | YesNoContest)[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
      {
        type: 'candidate',
        id: 'city-council',
        title: 'City Council',
        seats: 2,
        candidates: [{ id: 'bob', name: 'Bob' }],
        allowWriteIns: false,
        districtId: 'district-2',
      },
      {
        type: 'yesno',
        id: 'proposition-1',
        title: 'Proposition 1',
        yesOption: { id: 'yes', label: 'Yes' },
        noOption: { id: 'no', label: 'No' },
        districtId: 'district-1',
      },
    ];

    const ballotStyles: BallotStyle[] = [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: ['district-1', 'district-2'],
      },
    ];

    const election = createTestElection(ballotStyles, contests);
    const result = getContestsForBallotStyle(election, 'ballot-style-1');

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id).sort()).toEqual(['city-council', 'mayor', 'proposition-1']);
  });

  test('return empty array for ballot style with no matching contests', () => {
    const contests: CandidateContest[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
    ];

    const ballotStyles: BallotStyle[] = [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: ['district-2'], // Different district
      },
    ];

    const election = createTestElection(ballotStyles, contests);
    const result = getContestsForBallotStyle(election, 'ballot-style-1');

    expect(result).toHaveLength(0);
  });

  test('throw error for non-existent ballot style', () => {
    const contests: CandidateContest[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
    ];

    const ballotStyles: BallotStyle[] = [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: ['district-1'],
      },
    ];

    const election = createTestElection(ballotStyles, contests);

    expect(() => {
      getContestsForBallotStyle(election, 'non-existent-ballot-style');
    }).toThrow('Ballot style not found: non-existent-ballot-style');
  });

  test('filter contests correctly for different ballot styles', () => {
    const contests: CandidateContest[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
      {
        type: 'candidate',
        id: 'city-council',
        title: 'City Council',
        seats: 2,
        candidates: [{ id: 'bob', name: 'Bob' }],
        allowWriteIns: false,
        districtId: 'district-2',
      },
    ];

    const ballotStyles: BallotStyle[] = [
      {
        id: 'ballot-style-1',
        precincts: ['precinct-1'],
        districts: ['district-1'],
      },
      {
        id: 'ballot-style-2',
        precincts: ['precinct-2'],
        districts: ['district-2'],
      },
    ];

    const election = createTestElection(ballotStyles, contests);

    const result1 = getContestsForBallotStyle(election, 'ballot-style-1');
    const result2 = getContestsForBallotStyle(election, 'ballot-style-2');

    expect(result1).toHaveLength(1);
    expect(result1[0].id).toBe('mayor');

    expect(result2).toHaveLength(1);
    expect(result2[0].id).toBe('city-council');
  });
});

describe('normalizeGridLayouts', () => {
  test('leaves existing gridLayouts untouched (v4.0.x format)', () => {
    const election = createTestElection(
      [{ id: 'bs-1', precincts: ['precinct-1'], districts: ['district-1'] }],
      [],
    );
    election.gridLayouts = [
      {
        ballotStyleId: 'bs-1',
        optionBoundsFromTargetMark: { x: 0, y: 0, width: 1, height: 1 },
        gridPositions: [
          {
            type: 'option',
            sheetNumber: 1,
            side: 'front',
            column: 2,
            row: 3,
            contestId: 'c',
            optionId: 'o',
          },
        ],
      },
    ];

    normalizeGridLayouts(election);

    expect(election.gridLayouts).toHaveLength(1);
    expect(election.gridLayouts[0].gridPositions[0]).toMatchObject({ optionId: 'o' });
  });

  test('derives gridLayouts from ballotPositions (v4.1 format)', () => {
    const ballotPositions: SheetPositions[] = [
      [
        // front
        [
          {
            contestId: 'mayor',
            bounds: { row: 0, column: 0, width: 10, height: 10 },
            options: [
              {
                type: 'option',
                bubbleCenter: { row: 5, column: 4 },
                bounds: { row: 4, column: 3, width: 2, height: 2 },
                optionId: 'alice',
              },
              {
                type: 'write-in',
                bubbleCenter: { row: 7, column: 4 },
                bounds: { row: 6, column: 3, width: 2, height: 2 },
                writeInIndex: 0,
                writeInArea: { row: 6, column: 8, width: 12, height: 3 },
              },
            ],
          },
        ],
        // back
        [],
      ],
    ];

    const election = createTestElection(
      [{ id: 'bs-1', precincts: ['precinct-1'], districts: ['district-1'], ballotPositions }],
      [],
    );

    normalizeGridLayouts(election);

    expect(election.gridLayouts).toHaveLength(1);
    const layout = election.gridLayouts![0];
    expect(layout.ballotStyleId).toBe('bs-1');
    expect(layout.gridPositions).toHaveLength(2);

    expect(layout.gridPositions[0]).toEqual({
      type: 'option',
      sheetNumber: 1,
      side: 'front',
      column: 4,
      row: 5,
      contestId: 'mayor',
      optionId: 'alice',
    });

    expect(layout.gridPositions[1]).toEqual({
      type: 'write-in',
      sheetNumber: 1,
      side: 'front',
      column: 4,
      row: 7,
      contestId: 'mayor',
      writeInIndex: 0,
      // grid rect (row/column/width/height) converted to Rect (x/y/width/height)
      writeInArea: { x: 8, y: 6, width: 12, height: 3 },
    });
  });

  test('is a no-op when neither gridLayouts nor ballotPositions are present', () => {
    const election = createTestElection(
      [{ id: 'bs-1', precincts: ['precinct-1'], districts: ['district-1'] }],
      [],
    );

    normalizeGridLayouts(election);

    expect(election.gridLayouts).toBeUndefined();
  });
});

describe('normalizeYesNoContests', () => {
  test('derives yesOption/noOption from a v4.1 options[] array', () => {
    const yesno = {
      type: 'yesno',
      id: 'measure-1',
      title: 'Measure 1',
      districtId: 'district-1',
      options: [
        { id: 'measure-1-yes', label: 'Yes' },
        { id: 'measure-1-no', label: 'No' },
      ],
    } as unknown as YesNoContest;

    const election = createTestElection(
      [{ id: 'bs-1', precincts: ['precinct-1'], districts: ['district-1'] }],
      [yesno],
    );

    normalizeYesNoContests(election);

    const result = election.contests[0] as YesNoContest;
    expect(result.yesOption).toEqual({ id: 'measure-1-yes', label: 'Yes' });
    expect(result.noOption).toEqual({ id: 'measure-1-no', label: 'No' });
  });

  test('leaves v4.0 yesOption/noOption contests untouched', () => {
    const yesno: YesNoContest = {
      type: 'yesno',
      id: 'measure-1',
      title: 'Measure 1',
      districtId: 'district-1',
      yesOption: { id: 'y', label: 'Yes' },
      noOption: { id: 'n', label: 'No' },
    };

    const election = createTestElection(
      [{ id: 'bs-1', precincts: ['precinct-1'], districts: ['district-1'] }],
      [yesno],
    );

    normalizeYesNoContests(election);

    const result = election.contests[0] as YesNoContest;
    expect(result.yesOption).toEqual({ id: 'y', label: 'Yes' });
    expect(result.noOption).toEqual({ id: 'n', label: 'No' });
  });
});
