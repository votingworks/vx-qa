/**
 * Supported VxSuite versions and how the QA tool maps each one to a concrete
 * git ref, patch file, and ballot data model.
 *
 * A QA job specifies only a `version`; everything version-specific is derived
 * from it here. Older versions (<= v4.0.4) are intentionally unsupported.
 */

/**
 * Versions of VxSuite the QA tool knows how to run against. These match
 * VxSuite's own `SoftwareVersion` values (`v4.0`, `v4.1`); the specific git tag
 * for each is resolved via {@link VERSION_SPECS}.
 */
export const SUPPORTED_VERSIONS = ['v4.0', 'v4.1'] as const;

export type VxSuiteVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * The election ballot-geometry data model used by a given version.
 *
 * - `gridLayouts`: election definition carries top-level `gridLayouts`
 *   (v4.0.x).
 * - `ballotPositions`: geometry moved onto `ballotStyles[].ballotPositions`
 *   (v4.1+). The election loader normalizes this back into the flat
 *   grid-position model the rest of the tool expects.
 */
export type BallotModel = 'gridLayouts' | 'ballotPositions';

export interface VersionSpec {
  /** Git tag/branch to check out in the VxSuite repo. */
  ref: string;
  /** Patch file (relative to project root) to apply after checkout. */
  patchFile: string;
  /** Ballot-geometry data model used by this version's election definition. */
  ballotModel: BallotModel;
}

export const VERSION_SPECS: Record<VxSuiteVersion, VersionSpec> = {
  'v4.0': {
    ref: 'v4.0.7',
    patchFile: 'vxsuite-v4.0.patch',
    ballotModel: 'gridLayouts',
  },
  'v4.1': {
    // v4.1 is not yet tagged for release; the alpha tag is the pinned point.
    ref: 'v4.1.0-alpha',
    patchFile: 'vxsuite-v4.1.patch',
    ballotModel: 'ballotPositions',
  },
};

/** Look up the version spec for a supported version. */
export function getVersionSpec(version: VxSuiteVersion): VersionSpec {
  return VERSION_SPECS[version];
}

/** Resolve the git ref to check out for a given version. */
export function refForVersion(version: VxSuiteVersion): string {
  return VERSION_SPECS[version].ref;
}
