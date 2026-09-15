/**
 * Tests for manual tally dropdown option labels
 */

import { describe, test, expect } from 'vitest';
import {
  manualTallyOptionName,
  type ManualTallyBallotStyle,
  type ManualTallyPrecinct,
} from './admin-tally-workflow.js';

/**
 * Splits of a real precinct share every district but the one distinguishing
 * their ballot styles, so matching on any shared district is ambiguous.
 */
const splitPrecinct: ManualTallyPrecinct = {
  name: 'Precinct 1',
  splits: [
    {
      id: 'split-a',
      name: 'Precinct 1 - Ballot Style A',
      districtIds: ['shared-1', 'shared-2', 'only-a'],
    },
    {
      id: 'split-b',
      name: 'Precinct 1 - Ballot Style B',
      districtIds: ['shared-1', 'shared-2', 'only-b'],
    },
  ],
};

const styleA: ManualTallyBallotStyle = {
  id: 'bs-a',
  districts: ['shared-1', 'shared-2', 'only-a'],
};

const styleB: ManualTallyBallotStyle = {
  id: 'bs-b',
  districts: ['shared-1', 'shared-2', 'only-b'],
};

describe('manualTallyOptionName', () => {
  test('use the precinct name when it has no splits', () => {
    expect(manualTallyOptionName(styleA, { name: 'Precinct 1' })).toEqual('Precinct 1');
    expect(manualTallyOptionName(styleA, { name: 'Precinct 1', splits: [] })).toEqual('Precinct 1');
  });

  test('use the split whose districts match the ballot style', () => {
    expect(manualTallyOptionName(styleA, splitPrecinct)).toEqual('Precinct 1 - Ballot Style A');
    expect(manualTallyOptionName(styleB, splitPrecinct)).toEqual('Precinct 1 - Ballot Style B');
  });

  test('match splits regardless of district order', () => {
    const reordered: ManualTallyBallotStyle = {
      ...styleB,
      districts: ['only-b', 'shared-2', 'shared-1'],
    };

    expect(manualTallyOptionName(reordered, splitPrecinct)).toEqual('Precinct 1 - Ballot Style B');
  });

  test('give each ballot style in a precinct its own split', () => {
    const names = [styleA, styleB].map((style) => manualTallyOptionName(style, splitPrecinct));

    expect(new Set(names).size).toEqual(names.length);
  });

  test('append the party in primaries', () => {
    expect(manualTallyOptionName({ ...styleA, partyName: 'Democratic' }, splitPrecinct)).toEqual(
      'Precinct 1 - Ballot Style A - Democratic',
    );
    expect(
      manualTallyOptionName({ ...styleA, partyName: 'Democratic' }, { name: 'Precinct 1' }),
    ).toEqual('Precinct 1 - Democratic');
  });

  test('throw when no split matches the ballot style', () => {
    const unmatched: ManualTallyBallotStyle = {
      id: 'bs-c',
      districts: ['shared-1', 'shared-2', 'only-c'],
    };

    expect(() => manualTallyOptionName(unmatched, splitPrecinct)).toThrow(
      /No split of precinct "Precinct 1" has the same districts as ballot style bs-c/,
    );
  });

  test('do not match a split that merely shares districts', () => {
    const superset: ManualTallyBallotStyle = {
      id: 'bs-d',
      districts: ['shared-1', 'shared-2', 'only-a', 'only-b'],
    };

    expect(() => manualTallyOptionName(superset, splitPrecinct)).toThrow();
  });
});
