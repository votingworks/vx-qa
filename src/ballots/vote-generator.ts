/**
 * Generate vote patterns for ballot marking
 */

import type { BallotPattern } from '../config/types.js';
import type {
  Election,
  Contest,
  CandidateContest,
  YesNoContest,
  Candidate,
} from './election-loader.js';
import { getContestsForBallotStyle } from './election-loader.js';
import { logger } from '../utils/logger.js';

/**
 * VotesDict maps contest ID to array of votes
 * For candidate contests: array of Candidate objects
 * For yes/no contests: array of option IDs ('yes' or 'no')
 */
export type Vote = Candidate | string;
export type VotesDict = Record<string, Vote[]>;

/**
 * Generate vote patterns for a ballot style
 */
export function generateVotePatterns(
  election: Election,
  ballotStyleId: string,
  patterns: BallotPattern[]
): Map<BallotPattern, VotesDict> {
  const contests = getContestsForBallotStyle(election, ballotStyleId);
  const result = new Map<BallotPattern, VotesDict>();

  for (const pattern of patterns) {
    logger.debug(`Generating ${pattern} votes for ballot style ${ballotStyleId}`);

    switch (pattern) {
      case 'blank':
        result.set('blank', generateBlankVotes());
        break;
      case 'fully_filled':
        result.set('fully_filled', generateFullyFilledVotes(contests));
        break;
      case 'partial':
        result.set('partial', generatePartialVotes(contests));
        break;
      case 'overvote':
        result.set('overvote', generateOvervotedVotes(contests));
        break;
    }
  }

  return result;
}

/**
 * Generate blank votes (empty ballot)
 */
function generateBlankVotes(): VotesDict {
  return {};
}

/**
 * Generate fully filled votes (maximum valid votes in each contest)
 */
function generateFullyFilledVotes(contests: Contest[]): VotesDict {
  const votes: VotesDict = {};

  for (const contest of contests) {
    if (contest.type === 'candidate') {
      votes[contest.id] = selectCandidates(contest, contest.seats);
    } else if (contest.type === 'yesno') {
      // Vote 'yes' for yes/no contests
      votes[contest.id] = [contest.yesOption.id];
    }
  }

  return votes;
}

/**
 * Generate partial votes (some contests voted, some blank)
 */
function generatePartialVotes(contests: Contest[]): VotesDict {
  const votes: VotesDict = {};

  // Vote in every other contest
  for (let i = 0; i < contests.length; i++) {
    if (i % 2 === 0) {
      const contest = contests[i];
      if (contest.type === 'candidate') {
        // Vote for fewer than max allowed
        const numVotes = Math.max(1, Math.floor(contest.seats / 2));
        votes[contest.id] = selectCandidates(contest, numVotes);
      } else if (contest.type === 'yesno') {
        // Alternate yes/no
        votes[contest.id] = [i % 4 === 0 ? contest.yesOption.id : contest.noOption.id];
      }
    }
  }

  return votes;
}

/**
 * Generate overvoted ballots (too many votes in candidate contests)
 */
function generateOvervotedVotes(contests: Contest[]): VotesDict {
  const votes: VotesDict = {};

  // Find a candidate contest to overvote
  const candidateContest = contests.find(
    (c): c is CandidateContest => c.type === 'candidate' && c.candidates.length > c.seats
  );

  if (candidateContest) {
    // Vote for seats + 1 candidates (overvote)
    votes[candidateContest.id] = selectCandidates(
      candidateContest,
      candidateContest.seats + 1
    );
  }

  // Vote normally in other contests
  for (const contest of contests) {
    if (contest.id === candidateContest?.id) continue;

    if (contest.type === 'candidate') {
      votes[contest.id] = selectCandidates(contest, 1);
    } else if (contest.type === 'yesno') {
      votes[contest.id] = [contest.yesOption.id];
    }
  }

  return votes;
}

/**
 * Select candidates from a contest
 */
function selectCandidates(contest: CandidateContest, count: number): Candidate[] {
  const availableCandidates = contest.candidates.filter((c) => !c.isWriteIn);
  const toSelect = Math.min(count, availableCandidates.length);
  return availableCandidates.slice(0, toSelect);
}

/**
 * Get a human-readable description of the votes
 */
export function describeVotes(votes: VotesDict, contests: Contest[]): string {
  const descriptions: string[] = [];

  for (const [contestId, contestVotes] of Object.entries(votes)) {
    const contest = contests.find((c) => c.id === contestId);
    if (!contest) continue;

    if (contest.type === 'candidate') {
      const candidateNames = contestVotes
        .filter((v): v is Candidate => typeof v === 'object')
        .map((c) => c.name);
      descriptions.push(`${contest.title}: ${candidateNames.join(', ')}`);
    } else if (contest.type === 'yesno') {
      const option = contestVotes[0] === contest.yesOption.id ? 'Yes' : 'No';
      descriptions.push(`${contest.title}: ${option}`);
    }
  }

  return descriptions.join('\n');
}

/**
 * Check if votes represent an overvote
 */
export function hasOvervote(votes: VotesDict, contests: Contest[]): boolean {
  for (const [contestId, contestVotes] of Object.entries(votes)) {
    const contest = contests.find((c) => c.id === contestId);
    if (!contest) continue;

    if (contest.type === 'candidate') {
      if (contestVotes.length > contest.seats) {
        return true;
      }
    } else if (contest.type === 'yesno') {
      if (contestVotes.length > 1) {
        return true;
      }
    }
  }

  return false;
}
