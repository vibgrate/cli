import { computeDriftScore } from '../../core-open/index.js';
import type { ScanArtifact, ProjectScan } from '../../core-open/index.js';

/**
 * Estimate the DriftScore after applying a plan's upgrades.
 *
 * The DriftScore is a pure function of the scan's per-project state
 * (`computeDriftScore`), so we project the post-upgrade score by mutating a copy
 * of the scan to reflect the plan landing, then recomputing:
 *
 *  - each upgraded dependency moves out of its major-age bucket
 *    (`majorsBehind ≥ 2 → twoPlusBehind`, `== 1 → oneBehind`) into `current`;
 *  - each upgraded framework's `majorsBehind` is zeroed.
 *
 * It is a principled estimate, not a re-scan: patch/minor upgrades (0 majors
 * behind) don't move the major-age buckets, so their gain shows up only through
 * the freshness component when release-date data is present — which is honest,
 * since a patch bump barely changes structural drift. Deterministic.
 */

/** Recompute the DriftScore assuming every package named in `upgraded` lands at latest. */
export function estimateDriftScore(artifact: ScanArtifact, upgraded: Set<string>): number {
  const projects: ProjectScan[] = JSON.parse(JSON.stringify(artifact.projects ?? []));
  for (const p of projects) {
    const buckets = p.dependencyAgeBuckets;
    for (const dep of p.dependencies ?? []) {
      if (!upgraded.has(dep.package)) continue;
      const mb = dep.majorsBehind ?? 0;
      if (mb >= 2 && buckets.twoPlusBehind > 0) {
        buckets.twoPlusBehind--;
        buckets.current++;
      } else if (mb === 1 && buckets.oneBehind > 0) {
        buckets.oneBehind--;
        buckets.current++;
      }
    }
    for (const fw of p.frameworks ?? []) {
      if (upgraded.has(fw.name)) fw.majorsBehind = 0;
    }
  }
  return computeDriftScore(projects).score;
}
