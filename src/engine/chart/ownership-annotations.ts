/**
 * CODEOWNERS → path owners for architecture overlays.
 *
 * Ownership only: a team on a path is never a layer, role, or policy column.
 * Last matching rule wins (GitHub). Omit the mark when no rule matches.
 */
import type { ArchCard, ArchOverview, ArchOwnershipMark, ArchSlice } from './arch-types.js';
import { ownerTone, ownersForPath, posixPath, type OverlayContext } from './overlay-context.js';

export function withOverviewOwnership(overview: ArchOverview, ctx: OverlayContext): ArchOverview {
  if (!ctx.owners?.length) return overview;
  let changed = false;
  const packages = overview.packages.map((pkg) => {
    const mark = markForPaths([pkg.path, `${posixPath(pkg.path)}/`], ctx);
    if (!mark) return pkg;
    changed = true;
    return { ...pkg, owners: mark };
  });
  return changed ? { ...overview, packages } : overview;
}

export function withSliceOwnership(slice: ArchSlice, ctx: OverlayContext): ArchSlice {
  if (!ctx.owners?.length) return slice;
  let changed = false;
  const columns = slice.columns.map((col) => {
    let colChanged = false;
    const cards = col.cards.map((card) => {
      const mark = markForCard(card, ctx);
      if (!mark) return card;
      colChanged = true;
      return { ...card, owners: mark };
    });
    if (!colChanged) return col;
    changed = true;
    return { ...col, cards };
  });
  return changed ? { ...slice, columns } : slice;
}

function markForCard(card: ArchCard, ctx: OverlayContext): ArchOwnershipMark | undefined {
  return markForPaths([card.file, ...(card.members ?? []).map((m) => m.file)], ctx);
}

function markForPaths(paths: string[], ctx: OverlayContext): ArchOwnershipMark | undefined {
  if (!ctx.owners?.length) return undefined;
  const teams = new Set<string>();
  for (const raw of paths) {
    if (!raw) continue;
    const owners = ownersForPath(ctx.owners, raw);
    if (owners) for (const t of owners) teams.add(t);
  }
  if (!teams.size) return undefined;
  const list = [...teams].sort((a, b) => a.localeCompare(b));
  return { teams: list, tone: ownerTone(list[0]!) };
}
