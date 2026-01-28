/**
 * Tests for election loading utilities
 */

import { describe, test, expect } from 'vitest';
import { getContestsForBallotStyle } from './election-loader.js';
import type { Election, CandidateContest, YesNoContest, BallotStyle } from './election-loader.js';

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
