/**
 * Tests for the tallyMode auto-detection heuristic
 */

import { describe, test, expect } from 'vitest';
import { determineTallyMode } from './tally-mode.js';
import type { Election, Precinct } from '../ballots/election-loader.js';

function createTestElection(state: string, precincts: Precinct[]): Election {
  return {
    title: 'Test Election',
    state,
    county: { id: 'county-1', name: 'Test County' },
    date: '2024-11-05',
    type: 'general',
    ballotStyles: [],
    precincts,
    contests: [],
    ballotLayout: {
      paperSize: 'letter',
      metadataEncoding: 'qr-code',
    },
  };
}

const wards = [
  { id: 'ward-1', name: 'Ward 1' },
  { id: 'ward-2', name: 'Ward 2' },
];

const singlePrecinct = [{ id: 'precinct-1', name: 'Precinct 1' }];

describe('determineTallyMode', () => {
  test('NH with more than one precinct is per-precinct', () => {
    expect(determineTallyMode(createTestElection('NH', wards))).toBe('per-precinct');
  });

  test('NH with a single precinct is consolidated', () => {
    expect(determineTallyMode(createTestElection('NH', singlePrecinct))).toBe('consolidated');
  });

  test('non-NH with more than one precinct is consolidated', () => {
    expect(determineTallyMode(createTestElection('MS', wards))).toBe('consolidated');
  });

  test('non-NH with a single precinct is consolidated', () => {
    expect(determineTallyMode(createTestElection('CA', singlePrecinct))).toBe('consolidated');
  });
});
