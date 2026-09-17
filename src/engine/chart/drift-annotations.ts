/**
 * Join existing scan drift onto architecture cards and overview packages.
 *
 * Does not recompute DriftScore and does not invent a map-level health score.
 * A package or card paints only when at least one joined dependency is
 * actually behind (`minor-behind` / `major-behind`). `current` and `unknown`
 * are omitted — absent ≠ zero, and "all current" is not painted as healthy.
 *
 * Joins:
 * - path: `ProjectScan.path` ↔ package.path / card.file prefix (longest match)
 * - import: graph `import` / `depends_on` edges from card/package files to a
 *   drifted dependency name
 */
import type { ArchCard, ArchDriftMark, ArchOverview, ArchSlice } from './arch-types.js';
import {
  MAX_OVERLAY_PACKAGES,
  pathUnder,
  posixPath,
  type OverlayContext,
  type OverlayProjectDrift,
} from './overlay-context.js';

export function withOverviewDrift(overview: ArchOverview, ctx: OverlayContext): ArchOverview {
  if (!ctx.projects.length) return overview;
  let changed = false;
  const packages = overview.packages.map((pkg) => {
    const mark = driftForPaths([pkg.path], ctx, pkg.path);
    if (!mark) return pkg;
    changed = true;
    return { ...pkg, drift: mark };
  });
  return changed ? { ...overview, packages } : overview;
}

export function withSliceDrift(slice: ArchSlice, ctx: OverlayContext): ArchSlice {
  if (!ctx.projects.length && !ctx.graph) return slice;
  let changed = false;
  const columns = slice.columns.map((col) => {
    let colChanged = false;
    const cards = col.cards.map((card) => {
      const mark = driftForCard(card, ctx);
      if (!mark) return card;
      colChanged = true;
      return { ...card, drift: mark };
    });
    if (!colChanged) return col;
    changed = true;
    return { ...col, cards };
  });
  return changed ? { ...slice, columns } : slice;
}

function driftForCard(card: ArchCard, ctx: OverlayContext): ArchDriftMark | undefined {
  const files = [card.file, ...(card.members ?? []).map((m) => m.file)].filter(Boolean);
  return driftForPaths(files, ctx);
}

function driftForPaths(paths: string[], ctx: OverlayContext, packagePath?: string): ArchDriftMark | undefined {
  const files = paths.map(posixPath).filter(Boolean);
  const fromProjects = driftedFromProjects(files, ctx.projects, packagePath);
  const fromImports = ctx.graph ? driftedFromImports(files, ctx) : [];
  return mergeMarks([...fromProjects, ...fromImports]);
}

function driftedFromProjects(
  files: string[],
  projects: OverlayProjectDrift[],
  packagePath?: string,
): Array<{ package: string; band: 'minor' | 'major' }> {
  const project = matchProject(files, projects, packagePath);
  return project?.drifted ?? [];
}

function matchProject(
  files: string[],
  projects: OverlayProjectDrift[],
  packagePath?: string,
): OverlayProjectDrift | undefined {
  const needles = packagePath ? [posixPath(packagePath), ...files] : files;
  let best: OverlayProjectDrift | undefined;
  let bestRank = -1;
  for (const project of projects) {
    if (!project.drifted.length) continue;
    const hit = needles.some((f) => pathUnder(f, project.path) || (packagePath && pathUnder(project.path, packagePath)));
    if (!hit) continue;
    const rank = project.path === '.' ? 0 : project.path.split('/').filter(Boolean).length;
    if (rank > bestRank) {
      best = project;
      bestRank = rank;
    }
  }
  return best;
}

function driftedFromImports(
  files: string[],
  ctx: OverlayContext,
): Array<{ package: string; band: 'minor' | 'major' }> {
  const graph = ctx.graph;
  if (!graph) return [];
  const fileSet = new Set(files);
  const byName = new Map<string, 'minor' | 'major'>();
  for (const project of ctx.projects) {
    for (const dep of project.drifted) {
      const prev = byName.get(dep.package);
      if (!prev || (dep.band === 'major' && prev === 'minor')) byName.set(dep.package, dep.band);
    }
  }
  if (!byName.size) return [];

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const hits: Array<{ package: string; band: 'minor' | 'major' }> = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'import' && edge.kind !== 'depends_on' && edge.kind !== 'references') continue;
    const src = nodeById.get(edge.src);
    const dst = nodeById.get(edge.dst);
    if (!src || !dst) continue;
    if (!fileSet.has(posixPath(src.file))) continue;
    const names = [dst.name, dst.qualifiedName].filter(Boolean);
    for (const name of names) {
      const band = byName.get(name) ?? scopedBand(name, byName);
      if (!band) continue;
      const pkg = name.includes('/') ? name : (matchName(name, byName) ?? name);
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      hits.push({ package: pkg, band });
    }
  }
  return hits;
}

function scopedBand(name: string, byName: Map<string, 'minor' | 'major'>): 'minor' | 'major' | undefined {
  const matched = matchName(name, byName);
  return matched ? byName.get(matched) : undefined;
}

function matchName(name: string, byName: Map<string, 'minor' | 'major'>): string | undefined {
  if (byName.has(name)) return name;
  for (const pkg of byName.keys()) {
    if (name === pkg || name.endsWith(`/${pkg}`) || pkg.endsWith(`/${name}`)) return pkg;
  }
  return undefined;
}

function mergeMarks(rows: Array<{ package: string; band: 'minor' | 'major' }>): ArchDriftMark | undefined {
  if (!rows.length) return undefined;
  const byPkg = new Map<string, 'minor' | 'major'>();
  for (const row of rows) {
    const prev = byPkg.get(row.package);
    if (!prev || (row.band === 'major' && prev === 'minor')) byPkg.set(row.package, row.band);
  }
  const packages = [...byPkg.entries()]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'major' ? -1 : 1))
    .slice(0, MAX_OVERLAY_PACKAGES);
  if (!packages.length) return undefined;
  return {
    band: packages[0]![1],
    packages: packages.map(([name]) => name),
  };
}
