/**
 * Reachable-vulnerability badges: a red/amber shield on any card whose code
 * a prior `vg scan` found to actually call into a vulnerable dependency
 * symbol, sourced from `.vibgrate/scan_result.json` → `reachability`.
 *
 * `reachability` is itself the local half of a DSN-connected scan (Vibgrate
 * Cloud resolves which of the repo's dependencies carry advisories; this
 * package's own graph query then checks whether the vulnerable symbol is
 * actually imported/called). It is present only when that scan ran online
 * with a DSN — offline or DSN-less scans never populate it, so this stays a
 * no-op rather than a guess. Only `reachable` and `potentially_reachable`
 * tiers ever produce a badge; `not_reached`/`unknown` are not a finding.
 *
 * Matching is file-based, same precision tradeoff as `external-lane.ts`:
 * `ReachabilitySite.file` (+ its enclosing `function` when present) is
 * matched against a card's own file and its members' files/names.
 */
import type { ScanReachabilityFinding } from '../../core-open/index.js';
import type { ArchCardVuln, ArchOverview, ArchPackageNode, ArchSlice } from './arch-types.js';
import { loadScanArtifact, pathUnder, posixPath } from './overlay-context.js';

const MAX_VULNS_PER_CARD = 6;

/** Best-effort load of the last scan's reachability findings. Never throws. */
export function loadReachabilityFindings(root: string): ScanReachabilityFinding[] {
  const artifact = loadScanArtifact(root);
  const findings = artifact?.reachability?.findings;
  return Array.isArray(findings) ? findings : [];
}

export function relevantVulnFindings(findings: ScanReachabilityFinding[]): ScanReachabilityFinding[] {
  return findings.filter((f) => f.tier === 'reachable' || f.tier === 'potentially_reachable');
}

/**
 * Attach a `vulnerabilities` badge to every card whose file matches a
 * reachable/potentially-reachable finding's evidence site. Returns `slice`
 * unchanged when nothing matches (including when `findings` is empty).
 */
export function withVulnBadges(slice: ArchSlice, findings: ScanReachabilityFinding[]): ArchSlice {
  const relevant = relevantVulnFindings(findings);
  if (!relevant.length) return slice;

  let changed = false;
  const columns = slice.columns.map((col) => {
    let colChanged = false;
    const cards = col.cards.map((card) => {
      const files = new Set([card.file, ...(card.members ?? []).map((m) => m.file)].filter(Boolean));
      const hits = vulnsForFiles(files, relevant);
      if (!hits.length) return card;
      colChanged = true;
      return { ...card, vulnerabilities: hits };
    });
    if (!colChanged) return col;
    changed = true;
    return { ...col, cards };
  });

  return changed ? { ...slice, columns } : slice;
}

/**
 * Roll reachable findings onto overview packages by path prefix.
 * Returns `overview` unchanged when nothing matches.
 */
export function withOverviewVulnBadges(overview: ArchOverview, findings: ScanReachabilityFinding[]): ArchOverview {
  const relevant = relevantVulnFindings(findings);
  if (!relevant.length) return overview;
  let changed = false;
  const packages = overview.packages.map((pkg) => {
    const hits = vulnsForPackage(pkg, relevant);
    if (!hits.length) return pkg;
    changed = true;
    return { ...pkg, vulnerabilities: hits };
  });
  return changed ? { ...overview, packages } : overview;
}

function vulnsForPackage(pkg: ArchPackageNode, findings: ScanReachabilityFinding[]): ArchCardVuln[] {
  const files = new Set<string>();
  for (const finding of findings) {
    for (const site of finding.sites ?? []) {
      if (site.file && pathUnder(site.file, pkg.path)) files.add(posixPath(site.file));
    }
  }
  return vulnsForFiles(files, findings);
}

function vulnsForFiles(files: Set<string>, findings: ScanReachabilityFinding[]): ArchCardVuln[] {
  const hits: ArchCardVuln[] = [];
  const seen = new Set<string>();
  const normalised = new Set([...files].map(posixPath));
  for (const finding of findings) {
    const matches = (finding.sites ?? []).some((site) => site.file && normalised.has(posixPath(site.file)));
    if (!matches) continue;
    const key = `${finding.advisoryId}|${finding.package}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      advisoryId: finding.advisoryId,
      package: finding.package,
      tier: finding.tier as 'reachable' | 'potentially_reachable',
      ...(finding.evidence ? { evidence: finding.evidence } : {}),
    });
  }
  hits.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'reachable' ? -1 : 1));
  return hits.slice(0, MAX_VULNS_PER_CARD);
}
