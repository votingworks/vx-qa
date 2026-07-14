/**
 * Heuristic for auto-detecting tallyMode from election data
 */

import type { Election } from '../ballots/election-loader.js';
import type { TallyMode } from './types.js';

/**
 * NH "city" elections generate one election package per city with each ward
 * modeled as its own precinct; each ward's VxAdmin only ever tallies its own
 * ward. Elections matching that shape (NH, >1 real precinct) default to
 * 'per-precinct'; everything else defaults to 'consolidated'.
 */
export function determineTallyMode(election: Election): TallyMode {
  return election.state === 'NH' && election.precincts.length > 1 ? 'per-precinct' : 'consolidated';
}
