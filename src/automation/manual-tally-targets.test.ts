import { describe, expect, test } from 'vitest';
import { manualTallyTargets } from './admin-tally-workflow.ts';

const shared = { id: 'shared', precincts: ['a', 'b'], districts: ['d1'] };
const onlyB = { id: 'only-b', precincts: ['b'], districts: ['d2'] };
const election = { ballotStyles: [shared, onlyB] };

describe('manualTallyTargets', () => {
  test('consolidated mode tallies each ballot style once, under its first precinct', () => {
    expect(manualTallyTargets(election)).toEqual([
      { ballotStyle: shared, precinctId: 'a' },
      { ballotStyle: onlyB, precinctId: 'b' },
    ]);
  });

  test("per-precinct mode tallies only the cycle's precinct, even for shared styles", () => {
    expect(manualTallyTargets(election, 'b')).toEqual([
      { ballotStyle: shared, precinctId: 'b' },
      { ballotStyle: onlyB, precinctId: 'b' },
    ]);
    expect(manualTallyTargets(election, 'a')).toEqual([{ ballotStyle: shared, precinctId: 'a' }]);
  });
});
