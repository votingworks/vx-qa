/**
 * Ballot marking - generate marked ballot PDFs
 *
 * This module provides functionality to mark ballots with votes.
 * For full functionality, it uses VxSuite's libs/hmpb/src/marking.ts.
 */

import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import {
  getContestsForBallotStyle,
  GridPosition,
  Vote,
  type Election,
  type VotesDict,
} from './election-loader.js';
import type { BallotPattern } from '../config/types.js';

export interface MarkedBallot {
  ballotStyleId: string;
  pattern: BallotPattern;
  pdfBytes: Uint8Array;
  votes: VotesDict;
}

/**
 * Generate a marked ballot PDF using VxSuite's marking library
 */
export async function generateMarkedBallot(
  repoPath: string,
  election: Election,
  ballotStyleId: string,
  votes: VotesDict,
  baseBallotPdf: Uint8Array,
  onDraw?: (
    type: 'bubble' | 'write-in-text',
    gridPosition: GridPosition,
    vote: Vote,
  ) => 'draw' | 'ignore',
): Promise<Uint8Array> {
  logger.debug(`Generating marked ballot for style ${ballotStyleId}`);

  const { generateMarkOverlay } = await import(join(repoPath, 'libs/hmpb/build/marking.js'));
  return await generateMarkOverlay(
    election,
    ballotStyleId,
    votes,
    { offsetMmX: 0, offsetMmY: 0 },
    baseBallotPdf,
    onDraw,
  );
}

export async function generateMarkedBallotForPattern(
  repoPath: string,
  election: Election,
  ballotStyleId: string,
  pattern: BallotPattern,
  baseBallotPdf: Uint8Array,
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
        pdfBytes: await generateMarkedBallot(
          repoPath,
          election,
          ballotStyleId,
          votes,
          baseBallotPdf,
        ),
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
        pdfBytes: await generateMarkedBallot(
          repoPath,
          election,
          ballotStyleId,
          votes,
          baseBallotPdf,
        ),
        votes,
      };
    }

    case 'unmarked-write-in': {
      const votes = generateUnmarkedWriteInVotes(election, ballotStyleId);

      if (!votes) {
        return undefined;
      }

      return {
        ballotStyleId,
        pattern,
        pdfBytes: await generateMarkedBallot(
          repoPath,
          election,
          ballotStyleId,
          votes,
          baseBallotPdf,
          (type) => (type === 'bubble' ? 'ignore' : 'draw'),
        ),
        votes,
      };
    }

    case 'marked-write-in': {
      const votes = generateMarkedWriteInVotes(election, ballotStyleId);

      if (!votes) {
        return undefined;
      }

      return {
        ballotStyleId,
        pattern,
        pdfBytes: await generateMarkedBallot(
          repoPath,
          election,
          ballotStyleId,
          votes,
          baseBallotPdf,
        ),
        votes,
      };
    }

    default: {
      const _: never = pattern;
      throw new Error(`Unexpected ballot marking pattern: ${_ as string}`);
    }
  }
}

export function generateValidVotes(election: Election, ballotStyleId: string): VotesDict {
  const votes: VotesDict = {};
  const contests = getContestsForBallotStyle(election, ballotStyleId);

  for (const contest of contests) {
    switch (contest.type) {
      case 'candidate': {
        const selectedCandidates = contest.candidates.slice(0, contest.seats);

        // If there's still room after selecting regular candidates and write-ins are allowed,
        // add write-in candidates to fill remaining seats
        if (contest.allowWriteIns && selectedCandidates.length < contest.seats) {
          const writeInsNeeded = contest.seats - selectedCandidates.length;
          for (let i = 0; i < writeInsNeeded; i++) {
            selectedCandidates.push({
              id: `write-in-${i}`,
              name: 'Write-In',
              isWriteIn: true,
            });
          }
        }

        votes[contest.id] = selectedCandidates;
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
        // Start with all regular candidates
        const allCandidates = [...contest.candidates];

        // Add write-in candidates if allowed, to create more overvote opportunities
        if (contest.allowWriteIns) {
          for (let i = 0; i < contest.seats; i++) {
            allCandidates.push({
              id: `write-in-${i}`,
              name: 'Write-In',
              isWriteIn: true,
              writeInIndex: i,
            });
          }
        }

        if (allCandidates.length > contest.seats) {
          // Minimal overvote: select exactly seats + 1 candidates
          votes[contest.id] = allCandidates.slice(0, contest.seats + 1);
          hasAnyOvervote = true;
        } else {
          // Not enough candidates to overvote, just vote normally
          votes[contest.id] = allCandidates.slice(0, contest.seats);
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

export function generateValidWriteInVotes(
  election: Election,
  ballotStyleId: string,
): VotesDict | undefined {
  const votes: VotesDict = {};
  let hasAnyVotes = false;

  for (const contest of getContestsForBallotStyle(election, ballotStyleId)) {
    switch (contest.type) {
      case 'candidate': {
        if (contest.allowWriteIns && contest.seats > 0) {
          votes[contest.id] = [
            {
              id: `write-in-0`,
              name: 'Testy McTester',
              isWriteIn: true,
              writeInIndex: 0,
            },
          ];
          hasAnyVotes = true;
        }

        break;
      }

      case 'yesno': {
        break;
      }

      default: {
        const _: never = contest;
        throw new Error(`Unexpected contest type: ${(_ as any).type}`);
      }
    }
  }

  return hasAnyVotes ? votes : undefined;
}

export function generateUnmarkedWriteInVotes(
  election: Election,
  ballotStyleId: string,
): VotesDict | undefined {
  return generateValidWriteInVotes(election, ballotStyleId);
}

export function generateMarkedWriteInVotes(
  election: Election,
  ballotStyleId: string,
): VotesDict | undefined {
  return generateValidWriteInVotes(election, ballotStyleId);
}
