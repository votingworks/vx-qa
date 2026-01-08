/**
 * Tests for ballot marking and vote generation
 */

import { describe, test, expect } from 'vitest';
import {
  generateValidVotes,
  generateOvervoteVotes,
  generateValidWriteInVotes,
  generateUnmarkedWriteInVotes,
  generateMarkedWriteInVotes,
} from './ballot-marker.js';
import type { Election, CandidateContest, YesNoContest } from './election-loader.js';

/**
 * Helper to create a minimal election for testing
 */
function createTestElection(contests: (CandidateContest | YesNoContest)[]): Election {
  return {
    title: 'Test Election',
    state: 'CA',
    county: { id: 'county-1', name: 'Test County' },
    date: '2024-11-05',
    type: 'general',
    ballotStyles: [
      {
        id: 'test-ballot-style',
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
  };
}

describe('generateValidVotes', () => {
  test('generate valid votes for candidate contest with single seat', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidVotes(election, 'test-ballot-style');

    expect(votes).toHaveProperty('mayor');
    expect(votes.mayor).toHaveLength(1);
    expect(votes.mayor[0]).toEqual({ id: 'alice', name: 'Alice' });
  });

  test('generate valid votes for candidate contest with multiple seats', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'city-council',
      title: 'City Council',
      seats: 3,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
        { id: 'dave', name: 'Dave' },
      ],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidVotes(election, 'test-ballot-style');

    expect(votes).toHaveProperty('city-council');
    expect(votes['city-council']).toHaveLength(3);
    expect(votes['city-council'][0]).toEqual({ id: 'alice', name: 'Alice' });
    expect(votes['city-council'][1]).toEqual({ id: 'bob', name: 'Bob' });
    expect(votes['city-council'][2]).toEqual({ id: 'carol', name: 'Carol' });
  });

  test('fill remaining seats with write-ins when allowed', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'city-council',
      title: 'City Council',
      seats: 3,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidVotes(election, 'test-ballot-style');

    expect(votes).toHaveProperty('city-council');
    expect(votes['city-council']).toHaveLength(3);
    expect(votes['city-council'][0]).toEqual({ id: 'alice', name: 'Alice' });
    expect(votes['city-council'][1]).toEqual({ id: 'bob', name: 'Bob' });
    expect(votes['city-council'][2]).toMatchObject({
      id: 'write-in-0',
      name: 'Write-In',
      isWriteIn: true,
    });
  });

  test('generate yes vote for yes/no contest', () => {
    const contest: YesNoContest = {
      type: 'yesno',
      id: 'proposition-1',
      title: 'Proposition 1',
      yesOption: { id: 'yes', label: 'Yes' },
      noOption: { id: 'no', label: 'No' },
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidVotes(election, 'test-ballot-style');

    expect(votes).toHaveProperty('proposition-1');
    expect(votes['proposition-1']).toEqual(['yes']);
  });

  test('generate votes for multiple contests', () => {
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
        type: 'yesno',
        id: 'proposition-1',
        title: 'Proposition 1',
        yesOption: { id: 'yes', label: 'Yes' },
        noOption: { id: 'no', label: 'No' },
        districtId: 'district-1',
      },
    ];

    const election = createTestElection(contests);
    const votes = generateValidVotes(election, 'test-ballot-style');

    expect(votes).toHaveProperty('mayor');
    expect(votes).toHaveProperty('proposition-1');
    expect(votes.mayor).toHaveLength(1);
    expect(votes['proposition-1']).toEqual(['yes']);
  });
});

describe('generateOvervoteVotes', () => {
  test('generate overvote for single-seat candidate contest', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(2); // seats + 1
    expect(votes!.mayor[0]).toEqual({ id: 'alice', name: 'Alice' });
    expect(votes!.mayor[1]).toEqual({ id: 'bob', name: 'Bob' });
  });

  test('generate overvote for multi-seat candidate contest', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'city-council',
      title: 'City Council',
      seats: 2,
      candidates: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
        { id: 'carol', name: 'Carol' },
      ],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!['city-council']).toHaveLength(3); // seats + 1
  });

  test('include write-ins in overvote when allowed', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(2); // seats + 1
    expect(votes!.mayor[0]).toEqual({ id: 'alice', name: 'Alice' });
    expect(votes!.mayor[1]).toMatchObject({
      id: 'write-in-0',
      name: 'Write-In',
      isWriteIn: true,
    });
  });

  test('generate overvote for yes/no contest', () => {
    const contest: YesNoContest = {
      type: 'yesno',
      id: 'proposition-1',
      title: 'Proposition 1',
      yesOption: { id: 'yes', label: 'Yes' },
      noOption: { id: 'no', label: 'No' },
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!['proposition-1']).toEqual(['yes', 'no']);
  });

  test('return undefined if no overvote is possible', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 2,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    // Should return undefined because we can't overvote with only 1 candidate and 2 seats
    expect(votes).toBeUndefined();
  });

  test('vote normally when overvote is not possible for a contest', () => {
    const contests: CandidateContest[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [
          { id: 'alice', name: 'Alice' },
          { id: 'bob', name: 'Bob' },
        ],
        allowWriteIns: false,
        districtId: 'district-1',
      },
      {
        type: 'candidate',
        id: 'treasurer',
        title: 'Treasurer',
        seats: 2,
        candidates: [{ id: 'carol', name: 'Carol' }],
        allowWriteIns: false,
        districtId: 'district-1',
      },
    ];

    const election = createTestElection(contests);
    const votes = generateOvervoteVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(2); // Overvoted
    expect(votes!.treasurer).toHaveLength(1); // Not overvoted, just voted normally
  });
});

describe('generateValidWriteInVotes', () => {
  test('generate write-in vote for contest with write-ins allowed', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(1);
    expect(votes!.mayor[0]).toMatchObject({
      id: 'write-in-0',
      name: 'Testy McTester',
      isWriteIn: true,
      writeInIndex: 0,
    });
  });

  test('return undefined if no contests allow write-ins', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: false,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeUndefined();
  });

  test('skip yes/no contests', () => {
    const contests: (CandidateContest | YesNoContest)[] = [
      {
        type: 'candidate',
        id: 'mayor',
        title: 'Mayor',
        seats: 1,
        candidates: [{ id: 'alice', name: 'Alice' }],
        allowWriteIns: true,
        districtId: 'district-1',
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

    const election = createTestElection(contests);
    const votes = generateValidWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toBeDefined();
    expect(votes!['proposition-1']).toBeUndefined();
  });

  test('return undefined for zero-seat contest even with write-ins allowed', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 0,
      candidates: [],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateValidWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeUndefined();
  });
});

describe('generateUnmarkedWriteInVotes', () => {
  test('delegate to generateValidWriteInVotes', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateUnmarkedWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(1);
    expect(votes!.mayor[0]).toMatchObject({
      id: 'write-in-0',
      name: 'Testy McTester',
      isWriteIn: true,
    });
  });
});

describe('generateMarkedWriteInVotes', () => {
  test('delegate to generateValidWriteInVotes', () => {
    const contest: CandidateContest = {
      type: 'candidate',
      id: 'mayor',
      title: 'Mayor',
      seats: 1,
      candidates: [{ id: 'alice', name: 'Alice' }],
      allowWriteIns: true,
      districtId: 'district-1',
    };

    const election = createTestElection([contest]);
    const votes = generateMarkedWriteInVotes(election, 'test-ballot-style');

    expect(votes).toBeDefined();
    expect(votes!.mayor).toHaveLength(1);
    expect(votes!.mayor[0]).toMatchObject({
      id: 'write-in-0',
      name: 'Testy McTester',
      isWriteIn: true,
    });
  });
});
