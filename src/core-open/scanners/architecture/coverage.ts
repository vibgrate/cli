// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type {
  ArchitectureCoverage,
  ArchitectureCoverageSource,
  ArchitectureResult,
  ArchitectureUnclassifiedFolder,
  LayerClassification,
} from '../../types.js';

/**
 * Coverage instrumentation (ARCHITECTURE-ENGINE-PLAN-WAVE-2 §A0).
 *
 * `unclassified` has always been a bare count and `unclassifiedFiles` a
 * 40-path sample, so the *shape* of the classifier's miss was invisible: you
 * could not tell whether 300 unclassified files were spread thinly or sitting
 * in four folders the rule table has never heard of. This module makes the
 * miss measurable without changing a single classification.
 *
 * Pure and deterministic: same inputs → same output, stable sorts, no clock.
 */

/** Directories reported in `unclassifiedFolders`. */
export const UNCLASSIFIED_FOLDERS_CAP = 40;
/** Sample paths kept per reported directory. */
export const UNCLASSIFIED_FOLDER_SAMPLE_CAP = 5;

/** Every key is always present so the serialized shape never varies. */
export const COVERAGE_SOURCES: readonly ArchitectureCoverageSource[] = Object.freeze([
  'path',
  'suffix',
  'pascal',
  'folder-inherit',
  'graph',
  'ast',
  'declared',
]);

export function emptyBySource(): Record<ArchitectureCoverageSource, number> {
  const out = {} as Record<ArchitectureCoverageSource, number>;
  for (const s of COVERAGE_SOURCES) out[s] = 0;
  return out;
}

/**
 * 4 dp keeps the artifact byte-stable and readable. An empty denominator is
 * 0, never 1 — a project with nothing to walk has not been "fully covered".
 */
export function coverageRatio(classified: number, unclassified: number): number {
  const total = classified + unclassified;
  if (total <= 0) return 0;
  return Math.round((classified / total) * 10000) / 10000;
}

function normalizeRelPath(p: string): string {
  return (p || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/** Directory of a repo-relative file path; `.` for a root-level file. */
export function parentDirOf(filePath: string): string {
  const n = normalizeRelPath(filePath);
  const i = n.lastIndexOf('/');
  return i < 0 ? '.' : n.slice(0, i);
}

function compareRelPath(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Attribution for one classification. The stored `source` wins when the
 * classifier set one; signals are the fallback for classifications produced
 * before this field existed (and for the refine passes, which append their
 * own signals). A stage that only *agreed* — `graph-confirm`, `ast-confirm` —
 * never takes attribution away from the stage that decided.
 */
export function coverageSourceOf(c: LayerClassification): ArchitectureCoverageSource {
  if (c.source) return c.source;
  const signals = c.signals ?? [];
  if (signals.some((s) => s === 'graph-neighborhood' || s === 'graph-override')) return 'graph';
  if (signals.some((s) => s.startsWith('ast-role:'))) return 'ast';
  if (signals.some((s) => s.startsWith('folder-inherit:'))) return 'folder-inherit';
  return 'path';
}

export function buildCoverage(
  classifications: readonly LayerClassification[],
  unclassified: number,
): ArchitectureCoverage {
  const bySource = emptyBySource();
  for (const c of classifications) bySource[coverageSourceOf(c)] += 1;
  const classified = classifications.length;
  return { classified, unclassified, ratio: coverageRatio(classified, unclassified), bySource };
}

/**
 * Record that `source` rescued one previously-unclassified file. Called from
 * the graph and AST refine passes at the same sites that bump
 * `totalClassified`, so the attribution can never drift from the counters.
 */
export function creditCoverage(
  result: ArchitectureResult,
  source: ArchitectureCoverageSource,
): void {
  const coverage = result.coverage;
  if (!coverage) return;
  coverage.bySource[source] += 1;
  coverage.classified += 1;
  if (coverage.unclassified > 0) coverage.unclassified -= 1;
  coverage.ratio = coverageRatio(coverage.classified, coverage.unclassified);
}

/**
 * Move attribution when a later stage *overrides* an existing label. Keeps
 * `classified` fixed — nothing was rescued, the decision changed hands.
 */
export function reattributeCoverage(
  result: ArchitectureResult,
  from: ArchitectureCoverageSource,
  to: ArchitectureCoverageSource,
): void {
  const coverage = result.coverage;
  if (!coverage || from === to) return;
  if (coverage.bySource[from] > 0) coverage.bySource[from] -= 1;
  coverage.bySource[to] += 1;
}

/**
 * Group unclassified source by directory. Sorted by count desc then path so
 * the biggest blind spot is row one; ties break on path for determinism.
 */
export function buildUnclassifiedFolders(
  unclassifiedSource: readonly string[],
): { folders: ArchitectureUnclassifiedFolder[]; capped: boolean } {
  if (unclassifiedSource.length === 0) return { folders: [], capped: false };
  const byDir = new Map<string, string[]>();
  for (const raw of unclassifiedSource) {
    const file = normalizeRelPath(raw);
    const dir = parentDirOf(file);
    const list = byDir.get(dir);
    if (list) list.push(file);
    else byDir.set(dir, [file]);
  }
  const all: ArchitectureUnclassifiedFolder[] = [...byDir.entries()]
    .map(([path, files]) => ({
      path,
      count: files.length,
      sampleFiles: [...files].sort(compareRelPath).slice(0, UNCLASSIFIED_FOLDER_SAMPLE_CAP),
    }))
    .sort((a, b) => (b.count - a.count) || compareRelPath(a.path, b.path));
  return {
    folders: all.slice(0, UNCLASSIFIED_FOLDERS_CAP),
    capped: all.length > UNCLASSIFIED_FOLDERS_CAP,
  };
}

/**
 * Remove one rescued file from its folder row after a refine pass credited it.
 *
 * The refine passes only hold the capped `unclassifiedFiles` sample, never the
 * full unclassified population, so folder rows cannot be rebuilt there without
 * silently shrinking their counts to the sample size. Debiting the parent row
 * keeps the full-population count honest instead.
 *
 * A file whose folder never made the cap has no row to debit — that folder was
 * not published, so there is nothing to correct.
 */
export function debitUnclassifiedFolder(
  result: ArchitectureResult,
  filePath: string,
): void {
  const rows = result.unclassifiedFolders;
  if (!rows || rows.length === 0) return;
  const file = normalizeRelPath(filePath);
  const dir = parentDirOf(file);
  const row = rows.find((r) => r.path === dir);
  if (!row) return;

  row.count -= 1;
  row.sampleFiles = row.sampleFiles.filter((f) => normalizeRelPath(f) !== file);

  const remaining = rows.filter((r) => r.count > 0);
  if (remaining.length === 0) {
    delete result.unclassifiedFolders;
    delete result.unclassifiedFoldersCapped;
    return;
  }
  // Re-sort so the documented order (count desc, then path) still holds.
  remaining.sort((a, b) => (b.count - a.count) || compareRelPath(a.path, b.path));
  result.unclassifiedFolders = remaining;
}

/** Sum per-project coverage into a workspace total. */
export function mergeCoverage(
  parts: readonly (ArchitectureCoverage | undefined)[],
): ArchitectureCoverage | undefined {
  const present = parts.filter((p): p is ArchitectureCoverage => !!p);
  if (present.length === 0) return undefined;
  const bySource = emptyBySource();
  let classified = 0;
  let unclassified = 0;
  for (const p of present) {
    classified += p.classified;
    unclassified += p.unclassified;
    for (const s of COVERAGE_SOURCES) bySource[s] += p.bySource[s] ?? 0;
  }
  return { classified, unclassified, ratio: coverageRatio(classified, unclassified), bySource };
}

/**
 * Merge per-project folder rows into a workspace view. Rows already carry
 * result-relative paths, so identical paths from different projects are summed
 * rather than duplicated.
 */
export function mergeUnclassifiedFolders(
  parts: readonly (readonly ArchitectureUnclassifiedFolder[] | undefined)[],
): { folders: ArchitectureUnclassifiedFolder[]; capped: boolean } {
  const byDir = new Map<string, ArchitectureUnclassifiedFolder>();
  for (const part of parts) {
    for (const row of part ?? []) {
      const existing = byDir.get(row.path);
      if (!existing) {
        byDir.set(row.path, { path: row.path, count: row.count, sampleFiles: [...row.sampleFiles] });
        continue;
      }
      existing.count += row.count;
      existing.sampleFiles = [...new Set([...existing.sampleFiles, ...row.sampleFiles])]
        .sort(compareRelPath)
        .slice(0, UNCLASSIFIED_FOLDER_SAMPLE_CAP);
    }
  }
  const all = [...byDir.values()].sort((a, b) => (b.count - a.count) || compareRelPath(a.path, b.path));
  return {
    folders: all.slice(0, UNCLASSIFIED_FOLDERS_CAP),
    capped: all.length > UNCLASSIFIED_FOLDERS_CAP,
  };
}
