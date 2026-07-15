import { computeDriftScore } from '../../core-open/index.js';
import type { ScanArtifact, ProjectScan } from '../../core-open/index.js';

/**
 * Estimate the DriftScore after applying a plan's upgrades.
 *
 * The DriftScore is a pure function of the scan's per-project state
 * (`computeDriftScore`), so we project the post-upgrade score by mutating a copy
 * of the scan to reflect the plan landing, then recomputing:
 *
 *  - each upgraded dependency row lands at latest: `current`, zero majors
 *    behind, and zero calendar-time drift (libyears/ageDays) — because the
 *    driftscore-3.0 dependency pillar reads the per-dependency rows directly
 *    (time-primary), not the age buckets;
 *  - the age buckets are updated in lockstep for any legacy/aggregate consumer;
 *  - each upgraded framework's `majorsBehind` is zeroed.
 *
 * It is a principled estimate, not a re-scan, but under v3 a fully-upgraded set
 * projects to 0 dependency drift (current version AND no time distance).
 * Deterministic.
 */

/** Recompute the DriftScore assuming every package named in `upgraded` lands at latest. */
export function estimateDriftScore(artifact: ScanArtifact, upgraded: Set<string>): number {
  const projects: ProjectScan[] = JSON.parse(JSON.stringify(artifact.projects ?? []));
  for (const p of projects) {
    const buckets = p.dependencyAgeBuckets;
    for (const dep of p.dependencies ?? []) {
      if (!upgraded.has(dep.package)) continue;
      const mb = dep.majorsBehind ?? 0;
      // v3: project the upgrade onto the row — landed at latest ⇒ current, no
      // version lag, no calendar-time drift. Without this the time term (T)
      // would keep an upgraded dependency scoring > 0.
      dep.majorsBehind = 0;
      dep.drift = 'current';
      if (dep.libyears != null) dep.libyears = 0;
      if (dep.ageDays != null) dep.ageDays = 0;
      if (dep.latestStable) dep.resolvedVersion = dep.latestStable;
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
