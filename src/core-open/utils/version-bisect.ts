// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import type { GitCommitRef } from './git-history.js';
import type { PackageTimeline } from './version-timeline.js';

/**
 * Version-line bisection over a package's git-history timeline.
 *
 * Where `vg why` narrates *every* version transition for a dependency, bisection
 * answers a targeted question: "when did this dependency cross a specific version
 * line?" — e.g. "when did we finally patch past the vulnerable lodash" or "when
 * did we adopt React 18". It walks the same offline, no-checkout
 * `buildVersionTimelines` data the attribution code uses, finding the commits at
 * which the constraint's satisfied-state flipped.
 *
 * All functions here are pure (timeline in, crossings out), so they unit-test
 * without a repo and never touch git, the network, or the working tree.
 */

/** A commit at which the resolved version flipped the constraint's satisfied-state. */
export interface VersionCrossing {
  /** `entered` = the version started satisfying the constraint here; `left` = stopped. */
  kind: 'entered' | 'left';
  /** The commit that made the change. */
  commit: GitCommitRef;
  /** Resolved version at this commit (the version that triggered the crossing). */
  version: string;
  /** Resolved version immediately before this commit, or `null` if this is the package's first appearance. */
  previousVersion: string | null;
}

/**
 * Normalize a user-supplied target into a valid semver range.
 *
 * A bare version (`4.17.21`) means "reached or surpassed" → `>=4.17.21`, which is
 * the useful default for "did we get to the fix yet". Anything that already looks
 * like a range/operator (`>=1.2`, `^18`, `~4.17`, `<2 || >=3`, `*`) is passed
 * through verbatim. Returns `null` when the input is not a usable range.
 */
export function normalizeConstraint(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // A plain, exact version → ">=" that version. semver.valid rejects ranges and
  // partials (e.g. "18", "^1"), so only true pinned versions take this branch.
  const candidate = semver.valid(trimmed) ? `>=${trimmed}` : trimmed;
  return semver.validRange(candidate) ? candidate : null;
}

/**
 * Whether `version` satisfies `range`, tolerating non-semver resolved versions
 * (e.g. Go pseudo-versions): coerce, and treat anything unparseable as "does not
 * satisfy" rather than throwing. Mirrors the leniency in the vulnerability scanner.
 */
export function versionSatisfies(version: string, range: string): boolean {
  if (semver.valid(version) && semver.satisfies(version, range)) return true;
  const coerced = semver.valid(semver.coerce(version));
  return coerced != null && semver.satisfies(coerced, range);
}

/**
 * Find every commit at which the package's resolved version flipped the
 * constraint's satisfied-state, oldest → newest. Before a package first appears
 * the constraint is treated as unsatisfied, so a package that is introduced
 * already satisfying the constraint yields one `entered` crossing with a null
 * `previousVersion`.
 */
export function findVersionCrossings(timeline: PackageTimeline, range: string): VersionCrossing[] {
  const crossings: VersionCrossing[] = [];
  let prevSatisfied = false;
  let prevVersion: string | null = null;
  for (const change of timeline.changes) {
    const satisfied = versionSatisfies(change.version, range);
    if (satisfied !== prevSatisfied) {
      crossings.push({
        kind: satisfied ? 'entered' : 'left',
        commit: change.commit,
        version: change.version,
        previousVersion: prevVersion,
      });
    }
    prevSatisfied = satisfied;
    prevVersion = change.version;
  }
  return crossings;
}
