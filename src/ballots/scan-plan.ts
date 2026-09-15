/**
 * Plans which marked variants of each ballot PDF to scan, and whether VxScan
 * should count or return each one.
 */

import type { BallotToScan } from '../automation/scan-workflow.ts';
import type { BallotPdfInfo } from './election-loader.ts';

/**
 * The election settings that decide whether VxScan counts a ballot outright or
 * returns it to the voter for review.
 */
export interface ScanExpectations {
  /** `BlankBallot` is a precinct-scan adjudication reason. */
  blankBallotRequiresReview: boolean;
  /** `Overvote` is a precinct-scan adjudication reason. */
  overvoteRequiresReview: boolean;
  /** `Undervote` is a precinct-scan adjudication reason. */
  undervoteRequiresReview: boolean;
  /** VxScan hides "Cast Ballot" on the review screen for overvoted ballots. */
  disallowCastingOvervotes: boolean;
}

export function scanExpectationsFromSystemSettings(
  systemSettings: Record<string, unknown>,
): ScanExpectations {
  const reasons = Array.isArray(systemSettings['precinctScanAdjudicationReasons'])
    ? (systemSettings['precinctScanAdjudicationReasons'] as string[])
    : [];

  return {
    blankBallotRequiresReview: reasons.includes('BlankBallot'),
    overvoteRequiresReview: reasons.includes('Overvote'),
    undervoteRequiresReview: reasons.includes('Undervote'),
    disallowCastingOvervotes: systemSettings['disallowCastingOvervotes'] === true,
  };
}

/**
 * Plan the scans for one ballot PDF from the election package.
 *
 * Test-mode ballots are scanned once, blank, to confirm the official-mode
 * scanner returns them. Official ballots get every mark pattern, with a second
 * copy of any pattern VxScan returns for review but lets the voter cast anyway,
 * so both voter choices are exercised.
 */
export function planBallotsToScan(
  ballot: Pick<BallotPdfInfo, 'ballotStyleId' | 'precinctId' | 'ballotMode' | 'ballotType'>,
  pdfPath: string,
  expectations: ScanExpectations,
): BallotToScan[] {
  const base = {
    ballotStyleId: ballot.ballotStyleId,
    precinctId: ballot.precinctId,
    ballotMode: ballot.ballotMode,
    ballotType: ballot.ballotType,
    pdfPath,
  };

  const plan: BallotToScan[] = [
    {
      ...base,
      pattern: 'blank',
      // A blank ballot is counted only if the scanner is in official mode
      // (test ballots are returned) and blank ballots aren't flagged for
      // review by the election's adjudication settings.
      expectedAccepted: ballot.ballotMode === 'official' && !expectations.blankBallotRequiresReview,
    },
  ];

  if (ballot.ballotMode !== 'official') {
    return plan;
  }

  plan.push({ ...base, pattern: 'valid', expectedAccepted: true });

  // VxScan only flags overvotes when `Overvote` is an enabled adjudication
  // reason; `disallowCastingOvervotes` merely hides "Cast Ballot" on that
  // review screen. Without the reason, an overvoted ballot is counted outright
  // whatever `disallowCastingOvervotes` says.
  if (!expectations.overvoteRequiresReview) {
    plan.push({ ...base, pattern: 'overvote', expectedAccepted: true });
  } else if (expectations.disallowCastingOvervotes) {
    plan.push({ ...base, pattern: 'overvote', expectedAccepted: false });
  } else {
    plan.push(
      { ...base, pattern: 'overvote', expectedAccepted: true },
      { ...base, pattern: 'overvote', expectedAccepted: false },
    );
  }

  // Under-votes are flagged for review when configured but are always
  // castable, so exercise both voter choices in that case.
  if (expectations.undervoteRequiresReview) {
    plan.push(
      { ...base, pattern: 'undervote', expectedAccepted: true },
      { ...base, pattern: 'undervote', expectedAccepted: false },
    );
  } else {
    plan.push({ ...base, pattern: 'undervote', expectedAccepted: true });
  }

  plan.push(
    { ...base, pattern: 'marked-write-in', expectedAccepted: true },
    {
      ...base,
      pattern: 'unmarked-write-in',
      // The unmarked-write-in pattern fills no bubbles, so the ballot has no
      // counted votes and is treated as blank: returned for review when blank
      // ballots are flagged, otherwise counted (and the unmarked write-in
      // flagged for later adjudication in VxAdmin).
      expectedAccepted: !expectations.blankBallotRequiresReview,
    },
  );

  return plan;
}
