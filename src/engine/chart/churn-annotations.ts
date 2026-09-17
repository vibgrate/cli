/**
 * Bounded git churn rollup for architecture overlays.
 *
 * One `git log --name-only` (capped) — never per-file `fileCommits`.
 * Paths with no history are omitted (absent ≠ zero). Heat is relative
 * among paths that actually have commits on this map.
 */
import type { ArchCard, ArchChurnMark, ArchOverview, ArchSlice } from './arch-types.js';
import { heatOf, pathUnder, posixPath, type OverlayContext } from './overlay-context.js';

export function withOverviewChurn(overview: ArchOverview, ctx: OverlayContext): ArchOverview {
  if (!ctx.churn) return overview;
  const counts = overview.packages.map((pkg) => churnCountForPrefix(pkg.path, ctx.churn!));
  const positives = counts.filter((n) => n > 0);
  let changed = false;
  const packages = overview.packages.map((pkg, i) => {
    const mark = markFromCount(counts[i] ?? 0, positives);
    if (!mark) return pkg;
    changed = true;
    return { ...pkg, churn: mark };
  });
  return changed ? { ...overview, packages } : overview;
}

export function withSliceChurn(slice: ArchSlice, ctx: OverlayContext): ArchSlice {
  if (!ctx.churn) return slice;
  const cardFiles = slice.columns.flatMap((col) => col.cards.map((card) => cardFilesOf(card)));
  const counts = cardFiles.map((files) => files.reduce((n, f) => n + (ctx.churn!.get(f) ?? 0), 0));
  const positives = counts.filter((n) => n > 0);
  let changed = false;
  let i = 0;
  const columns = slice.columns.map((col) => {
    let colChanged = false;
    const cards = col.cards.map((card) => {
      const mark = markFromCount(counts[i] ?? 0, positives);
      i += 1;
      if (!mark) return card;
      colChanged = true;
      return { ...card, churn: mark };
    });
    if (!colChanged) return col;
    changed = true;
    return { ...col, cards };
  });
  return changed ? { ...slice, columns } : slice;
}

function cardFilesOf(card: ArchCard): string[] {
  return [card.file, ...(card.members ?? []).map((m) => m.file)].filter(Boolean).map(posixPath);
}

function churnCountForPrefix(dir: string, churn: Map<string, number>): number {
  const prefix = posixPath(dir);
  let n = 0;
  for (const [file, count] of churn) {
    if (pathUnder(file, prefix)) n += count;
  }
  return n;
}

function markFromCount(count: number, positives: number[]): ArchChurnMark | undefined {
  const heat = heatOf(count, positives);
  if (!heat) return undefined;
  return { heat, commits: count };
}
