// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as semver from 'semver';
import type { BlastRadius, UpgradeImpactResult, UpgradePosture, UpgradeUsage, VulnEcosystem } from '../types.js';

/**
 * Open "what breaks if I upgrade this" analysis for a drifted package.
 *
 * Combines the version distance (majors behind + the interim major lines to
 * step through) with a bounded scan of how heavily the package is used in the
 * source tree (the blast radius), plus any open advisories an upgrade would
 * remediate. Deterministic and offline — no changelog fetching here, so a
 * missing signal is reported honestly rather than guessed.
 *
 * This is the open counterpart to the proprietary breaking-change scanner: it
 * needs no playbooks and works for any npm/PyPI package by reading the repo.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.vibgrate', 'vendor',
  '.venv', 'venv', 'env', '__pycache__', 'target', '.next', '.nuxt', 'coverage', '.cache',
]);
const MAX_FILES = 8000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 1_048_576;
const MAX_SAMPLES = 5;

const SOURCE_EXT: Partial<Record<VulnEcosystem, Set<string>>> = {
  npm: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']),
  pypi: new Set(['.py']),
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the import-detection regex for a package in a given ecosystem, or null. */
function importPattern(ecosystem: VulnEcosystem, pkg: string): RegExp | null {
  const e = escapeRegExp(pkg);
  if (ecosystem === 'npm') {
    // from '<pkg>' | from '<pkg>/sub' | require('<pkg>') | import('<pkg>')
    return new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"]${e}(?:/[^'"]*)?['"]`, 'g');
  }
  if (ecosystem === 'pypi') {
    // import <pkg> | import <pkg>.sub | from <pkg> import | from <pkg>.sub import
    return new RegExp(`^\\s*(?:import\\s+${e}(?:[.\\s]|$)|from\\s+${e}(?:[.\\s]))`, 'gm');
  }
  return null;
}

/** Bounded walk of the source tree counting import sites for the package. */
export function analyzeUsage(root: string, packageName: string, ecosystem: VulnEcosystem | 'unknown'): UpgradeUsage {
  const empty: UpgradeUsage = { importSites: 0, filesTouched: 0, sampleFiles: [] };
  if (ecosystem === 'unknown') return empty;
  const exts = SOURCE_EXT[ecosystem];
  const pattern = importPattern(ecosystem, packageName);
  if (!exts || !pattern) return empty;

  let importSites = 0;
  let filesTouched = 0;
  const samples: string[] = [];
  let filesSeen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || filesSeen >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort for deterministic sampling/order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (filesSeen >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && exts.has(path.extname(entry.name))) {
        filesSeen++;
        const full = path.join(dir, entry.name);
        let content: string;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        pattern.lastIndex = 0;
        const matches = content.match(pattern);
        if (matches && matches.length) {
          importSites += matches.length;
          filesTouched++;
          if (samples.length < MAX_SAMPLES) samples.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(root, 0);
  samples.sort();
  return { importSites, filesTouched, sampleFiles: samples };
}

/** Major-version distance + the interim major lines between current and latest. */
export function computeVersionJump(
  current: string | null,
  latest: string | null,
  knownMajorsBehind?: number | null,
): { majorsBehind: number | null; interimMajors: string[] } {
  const c = current ? semver.valid(semver.coerce(current)) : null;
  const l = latest ? semver.valid(semver.coerce(latest)) : null;
  if (!c || !l) return { majorsBehind: knownMajorsBehind ?? null, interimMajors: [] };
  const cMajor = semver.major(c);
  const lMajor = semver.major(l);
  const majorsBehind = knownMajorsBehind ?? Math.max(0, lMajor - cMajor);
  const interimMajors: string[] = [];
  for (let m = cMajor + 1; m < lMajor; m++) interimMajors.push(`${m}.x`);
  return { majorsBehind, interimMajors };
}

function assessBlast(majorsBehind: number | null, usage: UpgradeUsage): BlastRadius {
  const ft = usage.filesTouched;
  if (!majorsBehind || majorsBehind <= 0) return ft > 0 ? 'low' : 'none';
  if (ft === 0) return 'low'; // major bump but no direct source usage found
  if (ft > 20 || (majorsBehind >= 2 && ft > 5)) return 'high';
  if (ft > 5 || majorsBehind >= 2) return 'moderate';
  return 'low';
}

function recommend(majorsBehind: number | null, current: string | null, latest: string | null): UpgradePosture {
  if (majorsBehind != null && majorsBehind >= 2) return 'multi-major-plan';
  if (majorsBehind === 1) return 'single-major';
  if (current && latest && current !== latest) return 'patch-minor';
  return 'current';
}

/**
 * Compute the upgrade-impact brief for a single package.
 *
 * @param opts.fixesVulnerabilities open advisory ids an upgrade would remediate
 *   (supplied by the caller from the last vulnerability scan).
 */
export function computeUpgradeImpact(
  root: string,
  target: {
    package: string;
    ecosystem: VulnEcosystem | 'unknown';
    currentVersion: string | null;
    latestVersion: string | null;
    majorsBehind?: number | null;
  },
  opts: { fixesVulnerabilities?: string[] } = {},
): UpgradeImpactResult {
  const { majorsBehind, interimMajors } = computeVersionJump(target.currentVersion, target.latestVersion, target.majorsBehind);
  const usage = analyzeUsage(root, target.package, target.ecosystem);
  const blastRadius = assessBlast(majorsBehind, usage);
  const recommendation = recommend(majorsBehind, target.currentVersion, target.latestVersion);
  const fixesVulnerabilities = opts.fixesVulnerabilities ?? [];

  const notes: string[] = [];
  if (interimMajors.length) {
    notes.push(`Step through ${interimMajors.join(' → ')} before the latest major rather than jumping directly.`);
  }
  if (usage.filesTouched === 0 && majorsBehind && majorsBehind > 0) {
    notes.push('No direct source usage found — likely a transitive or config-only dependency; upgrade risk is mostly indirect.');
  } else if (usage.filesTouched > 0) {
    notes.push(`Used at ${usage.importSites} import site(s) across ${usage.filesTouched} file(s) — review these when upgrading.`);
  }
  if (fixesVulnerabilities.length) {
    notes.push(`Upgrading also remediates ${fixesVulnerabilities.length} open advisory(ies): ${fixesVulnerabilities.join(', ')}.`);
  }

  return {
    package: target.package,
    ecosystem: target.ecosystem,
    currentVersion: target.currentVersion,
    latestVersion: target.latestVersion,
    majorsBehind,
    interimMajors,
    usage,
    blastRadius,
    recommendation,
    fixesVulnerabilities,
    notes,
  };
}
