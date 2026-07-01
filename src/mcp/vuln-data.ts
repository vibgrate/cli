import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectTypeToVulnEcosystem, severityRank, type ScanArtifact, type VulnEcosystem, type VulnerabilityScanResult, type VulnSeverity } from '../core-open/index.js';
import { inventory } from '../engine/drift.js';

/**
 * Offline access to vulnerability data for the local MCP server.
 *
 * The local server never touches the network, so it surfaces whatever the last
 * `vg scan --vulns` wrote to `.vibgrate/scan_result.json`. Absent data means
 * "not scanned", never "no vulnerabilities".
 */

/** Read the most recent local scan artifact, or null if none/unreadable. */
export function readScanArtifact(root: string): ScanArtifact | null {
  try {
    const file = path.join(root, '.vibgrate', 'scan_result.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ScanArtifact;
  } catch {
    return null;
  }
}

/** The vulnerability scan result from the last scan, or null when not scanned. */
export function loadVulnerabilities(root: string): VulnerabilityScanResult | null {
  return readScanArtifact(root)?.extended?.vulnerabilities ?? null;
}

/** The drift target for a package: ecosystem + installed/latest versions. */
export interface PackageTarget {
  ecosystem: VulnEcosystem | 'unknown';
  currentVersion: string | null;
  latestVersion: string | null;
  majorsBehind: number | null;
}

/**
 * Resolve a package's version/drift target — preferring the last scan artifact
 * (richest: resolved + latest + majors behind), falling back to the offline
 * dependency inventory (installed version + ecosystem).
 */
export function resolvePackageTarget(root: string, pkg: string): PackageTarget {
  const artifact = readScanArtifact(root);
  for (const project of artifact?.projects ?? []) {
    const dep = project.dependencies?.find((d) => d.package === pkg);
    if (dep) {
      return {
        ecosystem: projectTypeToVulnEcosystem(project.type) ?? 'unknown',
        currentVersion: dep.resolvedVersion,
        latestVersion: dep.latestStable,
        majorsBehind: dep.majorsBehind,
      };
    }
  }
  const rec = inventory(root).records.find((r) => r.name === pkg);
  if (rec) {
    const ecosystem: VulnEcosystem | 'unknown' = rec.ecosystem === 'npm' ? 'npm' : rec.ecosystem === 'pypi' ? 'pypi' : 'unknown';
    return { ecosystem, currentVersion: rec.installed ?? null, latestVersion: rec.latest ?? null, majorsBehind: null };
  }
  return { ecosystem: 'unknown', currentVersion: null, latestVersion: null, majorsBehind: null };
}

/** Open advisory ids (with a published fix) for a package, from the last scan. */
export function openFixableAdvisories(root: string, pkg: string): string[] {
  const vulns = loadVulnerabilities(root);
  const match = vulns?.packages.find((p) => p.package === pkg);
  return (match?.advisories ?? []).filter((a) => a.fixedVersions.length).map((a) => a.id);
}

/** Filter a result to advisories at or above a minimum severity (packages with none are dropped). */
export function filterBySeverity(result: VulnerabilityScanResult, minSeverity?: VulnSeverity): VulnerabilityScanResult {
  if (!minSeverity || minSeverity === 'unknown') return result;
  const floor = severityRank(minSeverity);
  const packages = result.packages
    .map((p) => ({ ...p, advisories: p.advisories.filter((a) => severityRank(a.severity) >= floor) }))
    .filter((p) => p.advisories.length > 0);
  const totalAdvisories = packages.reduce((n, p) => n + p.advisories.length, 0);
  return { ...result, packages, totalAdvisories };
}
