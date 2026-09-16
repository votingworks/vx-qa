import { describe, expect, test } from 'vitest';
import type { Election, PollingPlace } from '../ballots/election-loader.ts';
import { scannerAcceptedPrecinctIds, scannerLocationSelection } from './scan-workflow.ts';

function election(precinctIds: string[], pollingPlaces?: PollingPlace[]): Election {
  return {
    title: 'Test',
    state: 'MS',
    county: { id: 'c', name: 'County' },
    date: '2026-11-03',
    type: 'general',
    ballotStyles: [],
    precincts: precinctIds.map((id) => ({ id, name: `Precinct ${id}` })),
    pollingPlaces,
    contests: [],
    ballotLayout: { paperSize: 'letter', metadataEncoding: 'qr-code' },
  };
}

function place(id: string, type: PollingPlace['type'], ...precinctIds: string[]): PollingPlace {
  return {
    id,
    name: `Place ${id}`,
    type,
    precincts: Object.fromEntries(precinctIds.map((p) => [p, { type: 'whole' as const }])),
  };
}

describe('v4.0 (precinct location model)', () => {
  test('a single precinct is auto-selected', () => {
    expect(scannerLocationSelection('v4.0', election(['a']), 'a')).toBeUndefined();
  });

  test('picks the precinct by name and accepts only that precinct', () => {
    const e = election(['a', 'b']);
    expect(scannerLocationSelection('v4.0', e, 'b')).toEqual({
      placeholder: 'Select a precinct…',
      optionName: 'Precinct b',
    });
    expect([...scannerAcceptedPrecinctIds('v4.0', e, 'b')]).toEqual(['b']);
  });
});

describe('v4.1 (polling place location model)', () => {
  test('a single polling place is auto-selected and accepts all its precincts', () => {
    const e = election(['a', 'b'], [place('pp', 'election_day', 'a', 'b')]);
    expect(scannerLocationSelection('v4.1', e, 'a')).toBeUndefined();
    expect([...scannerAcceptedPrecinctIds('v4.1', e, 'a')].toSorted()).toEqual(['a', 'b']);
  });

  test('picks the election day polling place covering the precinct', () => {
    const e = election(
      ['a', 'b'],
      [
        place('pa', 'election_day', 'a'),
        place('pb', 'election_day', 'b'),
        place('central', 'absentee', 'a', 'b'),
      ],
    );
    expect(scannerLocationSelection('v4.1', e, 'b')).toEqual({
      placeholder: 'Select a polling place…',
      optionName: 'Place pb',
    });
    expect([...scannerAcceptedPrecinctIds('v4.1', e, 'b')]).toEqual(['b']);
  });

  test('a shared election day polling place accepts every precinct it covers', () => {
    const e = election(
      ['a', 'b', 'c'],
      [place('pab', 'election_day', 'a', 'b'), place('pc', 'election_day', 'c')],
    );
    expect([...scannerAcceptedPrecinctIds('v4.1', e, 'a')].toSorted()).toEqual(['a', 'b']);
    expect([...scannerAcceptedPrecinctIds('v4.1', e, 'c')]).toEqual(['c']);
  });

  test('rejects a precinct with no election day polling place', () => {
    const e = election(['a', 'b'], [place('pa', 'election_day', 'a'), place('x', 'absentee', 'b')]);
    expect(() => scannerLocationSelection('v4.1', e, 'b')).toThrow(
      /No election day polling place/u,
    );
  });

  test('rejects a lone polling place that does not cover the precinct', () => {
    const e = election(['a', 'b'], [place('pa', 'election_day', 'a')]);
    expect(() => scannerAcceptedPrecinctIds('v4.1', e, 'b')).toThrow(/does not cover precinct b/u);
  });
});
