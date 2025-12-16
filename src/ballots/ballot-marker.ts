/**
 * Ballot marking - generate marked ballot PDFs
 *
 * This module provides functionality to mark ballots with votes.
 * For full functionality, it uses VxSuite's libs/hmpb/src/marking.ts.
 */

import { join } from 'path';
import { logger } from '../utils/logger.js';
import { getContestsForBallotStyle, type Election } from './election-loader.js';
import type { VotesDict } from './vote-generator.js';
import type { BallotPattern } from '../config/types.js';

export interface MarkedBallot {
  ballotStyleId: string;
  pattern: BallotPattern;
  pdfBytes: Uint8Array;
  votes?: VotesDict;
}

/**
 * Generate a marked ballot PDF using VxSuite's marking library
 */
export async function generateMarkedBallot(
  repoPath: string,
  election: Election,
  ballotStyleId: string,
  votes: VotesDict,
  baseBallotPdf: Uint8Array
): Promise<Uint8Array> {
  logger.debug(`Generating marked ballot for style ${ballotStyleId}`);

  const { generateMarkOverlay } = await import(join(repoPath, 'libs/hmpb/src/marking'));
  return await generateMarkOverlay(
    election,
    ballotStyleId,
    votes,
    { offsetMmX: 0, offsetMmY: 0 },
    baseBallotPdf,
  );
}

export async function generateMarkedBallotForPattern(
  repoPath: string,
  election: Election,
  ballotStyleId: string,
  pattern: BallotPattern,
  baseBallotPdf: Uint8Array
): Promise<MarkedBallot | undefined> {
  switch (pattern) {
    case 'blank':
      return {
        ballotStyleId,
        pattern,
        pdfBytes: baseBallotPdf,
        votes: {},
      };

    case 'valid': {
      const votes = generateValidVotes(election, ballotStyleId);
      return {
        ballotStyleId,
        pattern,
        pdfBytes: await generateMarkedBallot(repoPath, election, ballotStyleId, votes, baseBallotPdf),
        votes,
      };
    }

    case 'overvote': {
      const votes = generateOvervoteVotes(election, ballotStyleId);

      if (!votes) {
        return undefined;
      }

      return {
        ballotStyleId,
        pattern,
        pdfBytes: await generateMarkedBallot(repoPath, election, ballotStyleId, votes, baseBallotPdf),
        votes,
      };
    }

    default: {
      const _: never = pattern;
      throw new Error(`Unexpected ballot marking pattern: ${_}`);
    }
  }
}

export function generateValidVotes(
  election: Election,
  ballotStyleId: string
): VotesDict {
  const votes: VotesDict = {};
  const contests = getContestsForBallotStyle(election, ballotStyleId);

  for (const contest of contests) {
    switch (contest.type) {
      case 'candidate': {
        votes[contest.id] = contest.candidates.slice(0, contest.seats);
        break;
      }
      case 'yesno': {
        votes[contest.id] = [contest.yesOption.id];
        break;
      }
      default: {
        const _: never = contest;
        throw new Error(`Unexpected contest type: ${(_ as any).type}`);
      }
    }
  }

  return votes;
}

export function generateOvervoteVotes(
  election: Election,
  ballotStyleId: string,
): VotesDict | undefined {
  const votes: VotesDict = {};
  let hasAnyOvervote = false;
  
  for (const contest of getContestsForBallotStyle(election, ballotStyleId)) {
    switch (contest.type) {
      case 'candidate': {
        if (contest.candidates.length > contest.seats) {
          // Overvote by selecting all candidates
          votes[contest.id] = contest.candidates;
          hasAnyOvervote = true;
        } else {
          // Not enough candidates to overvote, just vote normally
          votes[contest.id] = contest.candidates.slice(0, contest.seats);
        }
        break;
      }

      case 'yesno': {
        // Overvote by selecting both yes and no
        votes[contest.id] = [contest.yesOption.id, contest.noOption.id];
        hasAnyOvervote = true;
        break;
      }

      default: {
        const _: never = contest;
        throw new Error(`Unexpected contest type: ${(_ as any).type}`);
      }
    }
  }

  return hasAnyOvervote ? votes : undefined;
}
