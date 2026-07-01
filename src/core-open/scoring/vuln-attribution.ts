// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { isVersionAffected, manifestAdvisoryToAdvisory } from '../scanners/vulnerability-scanner.js';
import {
  getManifestEntry,
  type ManifestEcosystem,
  type PackageVersionManifest,
} from '../package-version-manifest.js';
import {
  findPackageTimeline,
  type PackageTimeline,
  type PresenceEvent,
  type VersionTimelines,
} from '../utils/version-timeline.js';
import type {
  CommitAttribution,
  CraRemediationMetrics,
  VulnerabilityAdvisory,
  VulnerabilityScanResult,
  VulnSeverity,
} from '../types.js';

/**
 * Vulnerability exposure attribution + CRA remediation metrics.
 *
 * Given the scan's vulnerability result and the npm version timeline (from git
 * history), this answers "who introduced the still-open exposure to this
 * advisory, and how long have we been exposed". It replays each package's
 * version history against the advisory's affected ranges to find the commit at
 * which the package most recently entered (and stayed in) the affected state.
 *
 * All time figures are relative to a caller-supplied `nowIso` (the scan
 * timestamp), never the wall clock, so a scan's metrics are reproducible.
 */

/**
 * Default CRA-inspired remediation SLA, in days, by severity. Tunable later;
 * `unknown` has no SLA. Critical mirrors CRA's "act without undue delay" posture.
 */
export const DEFAULT_CRA_SLA_DAYS: Record<VulnSeverity, number | null> = {
  critical: 7,
  high: 30,
  moderate: 90,
  low: 180,
  unknown: null,
};

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Lowest published fix version (semver), or null when none. */
function earliestFix(advisory: VulnerabilityAdvisory): string | null {
  const valid = advisory.fixedVersions.map((v) => semver.valid(semver.coerce(v))).filter((v): v is string => Boolean(v));
  if (!valid.length) return null;
  return valid.sort(semver.compare)[0] ?? null;
}

/**
 * Whether `version` is affected by `advisory`. Prefers explicit affected ranges/
 * versions; falls back to "below the earliest fix" (or "all versions" when no fix
 * is published) so an advisory that matched the installed version stays affected.
 */
export function isAffectedByAdvisory(version: string, advisory: VulnerabilityAdvisory): boolean {
  if ((advisory.affectedRanges && advisory.affectedRanges.length) || (advisory.affectedVersions && advisory.affectedVersions.length)) {
    return isVersionAffected(version, advisory.affectedRanges, advisory.affectedVersions);
  }
  const fix = earliestFix(advisory);
  if (!fix) return true; // no fix published → treat as affected
  const v = semver.valid(semver.coerce(version));
  return v ? semver.lt(v, fix) : false;
}

function toAttribution(commit: PackageTimeline['changes'][number]['commit']): CommitAttribution {
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    date: commit.date,
    subject: commit.subject,
  };
}

/**
 * The commit that began the current exposure: the earliest change in the trailing
 * contiguous run of affected versions ending at the installed version. Null when
 * the timeline is unknown or the current version isn't affected in it.
 */
export function findIntroduced(timeline: PackageTimeline | undefined, advisory: VulnerabilityAdvisory): CommitAttribution | null {
  if (!timeline || !timeline.changes.length) return null;
  let introduced: CommitAttribution | null = null;
  for (let i = timeline.changes.length - 1; i >= 0; i--) {
    const change = timeline.changes[i];
    if (isAffectedByAdvisory(change.version, advisory)) {
      introduced = toAttribution(change.commit);
    } else {
      break;
    }
  }
  return introduced;
}

/** One contiguous span during which the package was affected by an advisory. */
export interface ExposureWindow {
  /** Commit that began the affected span. */
  introduced: CommitAttribution;
  /** Commit that ended it — a bump out of the affected range, or the package's removal — or `null` if still open. */
  remediated: CommitAttribution | null;
  /** Days affected: `introduced`→`remediated` for a closed window, `introduced`→`now` for an open one. */
  exposureDays: number | null;
  /** Whether the span is still open at the current state. */
  open: boolean;
}

/**
 * Reconstruct every span during which the package was affected by the advisory,
 * walking its full presence history (version bumps and removals). A span closes
 * when the resolved version moves out of the affected range or the package is
 * removed from the lockfile — that closing commit is the real remediation. The
 * trailing span stays open when the current version is still affected.
 *
 * Pure: presence history in, windows out. Falls back to `changes` (present states
 * only) when an older cache has no `presence`, so removals just aren't seen there.
 */
export function analyzeExposureWindows(
  timeline: PackageTimeline | undefined,
  advisory: VulnerabilityAdvisory,
  nowIso: string,
): ExposureWindow[] {
  if (!timeline) return [];
  const events: PresenceEvent[] = timeline.presence
    ?? timeline.changes.map((c) => ({ version: c.version as string | null, commit: c.commit }));
  const windows: ExposureWindow[] = [];
  let introduced: CommitAttribution | null = null;
  for (const event of events) {
    const affected = event.version != null && isAffectedByAdvisory(event.version, advisory);
    if (affected && !introduced) {
      introduced = toAttribution(event.commit);
    } else if (!affected && introduced) {
      const remediated = toAttribution(event.commit);
      windows.push({ introduced, remediated, exposureDays: daysBetween(introduced.date, remediated.date), open: false });
      introduced = null;
    }
  }
  if (introduced) {
    windows.push({ introduced, remediated: null, exposureDays: daysBetween(introduced.date, nowIso), open: true });
  }
  return windows;
}

function emptySeverityCounts(): Record<VulnSeverity, number> {
  return { low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 };
}

/** Build the CRA remediation metrics from already-attributed advisories and any closed remediation windows. */
export function computeCra(
  result: VulnerabilityScanResult,
  nowIso: string,
  slaDays: Record<VulnSeverity, number | null> = DEFAULT_CRA_SLA_DAYS,
  remediationDays: number[] = [],
): CraRemediationMetrics {
  const openBySeverity = emptySeverityCounts();
  let openCount = 0;
  let slaBreaches = 0;
  let attributedCount = 0;
  let maxOpenExposureDays: number | null = null;
  let exposureSum = 0;
  let exposureN = 0;

  for (const pkg of result.packages) {
    for (const adv of pkg.advisories) {
      openCount++;
      openBySeverity[adv.severity]++;
      const exposure = adv.exposureDays ?? null;
      if (exposure != null) {
        attributedCount++;
        exposureSum += exposure;
        exposureN++;
        if (maxOpenExposureDays == null || exposure > maxOpenExposureDays) maxOpenExposureDays = exposure;
        const sla = slaDays[adv.severity];
        if (sla != null && exposure > sla) slaBreaches++;
      }
    }
  }

  const remediatedCount = remediationDays.length;
  const remediationSum = remediationDays.reduce((a, b) => a + b, 0);

  return {
    openCount,
    openBySeverity,
    slaDays,
    slaBreaches,
    maxOpenExposureDays,
    meanOpenExposureDays: exposureN > 0 ? Math.round(exposureSum / exposureN) : null,
    attributedCount,
    remediatedCount,
    meanRemediationDays: remediatedCount > 0 ? Math.round(remediationSum / remediatedCount) : null,
    maxRemediationDays: remediatedCount > 0 ? Math.max(...remediationDays) : null,
  };
}

/**
 * Real remediation times (introduced→remediated, in days) for every closed
 * exposure window we can evaluate against history, deduplicated by
 * (ecosystem, package, advisory):
 *
 * - advisories the scan currently reports — catches an earlier fix that later
 *   regressed, and
 * - when a package-version manifest is supplied (offline mode), every advisory it
 *   carries for any package seen in history — catches fully-remediated advisories
 *   the current-version scan never surfaces because the installed version is now
 *   clean.
 *
 * Online without a manifest, only the first source is available, so a package that
 * is clean today contributes no remediation sample (honestly absent, not zero).
 */
function collectRemediationDays(
  result: VulnerabilityScanResult,
  timelines: VersionTimelines | null,
  nowIso: string,
  manifest?: PackageVersionManifest,
): number[] {
  if (!timelines) return [];
  const seen = new Set<string>();
  const days: number[] = [];
  const analyze = (pt: PackageTimeline, advisory: VulnerabilityAdvisory): void => {
    const key = `${pt.ecosystem}\0${pt.name}\0${advisory.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const w of analyzeExposureWindows(pt, advisory, nowIso)) {
      if (!w.open && w.exposureDays != null) days.push(w.exposureDays);
    }
  };

  for (const pkg of result.packages) {
    const pt = findPackageTimeline(timelines, pkg.ecosystem, pkg.package);
    if (pt) for (const adv of pkg.advisories) analyze(pt, adv);
  }

  if (manifest) {
    for (const eco of timelines.ecosystems) {
      for (const pt of eco.packages) {
        const entry = getManifestEntry(manifest, pt.ecosystem as ManifestEcosystem, pt.name);
        for (const m of entry?.vulns ?? []) {
          if (m.withdrawn) continue;
          analyze(pt, manifestAdvisoryToAdvisory(m));
        }
      }
    }
  }
  return days;
}

/**
 * Enrich a vulnerability result in place with per-advisory introduction
 * attribution and exposure days, then attach the CRA remediation metrics —
 * including real remediation times (MTTR) reconstructed from closed exposure
 * windows in git history. Returns the same result for convenience.
 */
export function attributeVulnerabilities(
  result: VulnerabilityScanResult,
  timelines: VersionTimelines | null,
  nowIso: string,
  opts: { slaDays?: Record<VulnSeverity, number | null>; manifest?: PackageVersionManifest } = {},
): VulnerabilityScanResult {
  const slaDays = opts.slaDays ?? DEFAULT_CRA_SLA_DAYS;
  for (const pkg of result.packages) {
    const pt: PackageTimeline | undefined = timelines
      ? findPackageTimeline(timelines, pkg.ecosystem, pkg.package)
      : undefined;
    for (const adv of pkg.advisories) {
      const introduced = findIntroduced(pt, adv);
      adv.introduced = introduced;
      adv.exposureDays = introduced ? daysBetween(introduced.date, nowIso) : null;
    }
  }

  const remediationDays = collectRemediationDays(result, timelines, nowIso, opts.manifest);
  result.cra = computeCra(result, nowIso, slaDays, remediationDays);
  return result;
}
