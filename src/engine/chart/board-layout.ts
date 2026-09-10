/**
 * Persisted Architecture map chrome: density, last package, dragged positions.
 * Written to `.vibgrate/board.arch.json`. Never secrets; never a classifier.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOARD_LAYOUT_MAGIC = 'vg.arch.board.v1' as const;
export const BOARD_LAYOUT_FILE = 'board.arch.json';

export type ArchDensity = 'compact' | 'expanded' | 'immersive';

export interface ArchBoardLayout {
  magic: typeof BOARD_LAYOUT_MAGIC;
  density: ArchDensity;
  zoom: 'workspace' | 'slice';
  packageId: string | null;
  view: 'job' | 'calls' | 'missing' | 'problems';
  arch: boolean;
  positions: Record<string, { x: number; y: number }>;
}

export function boardLayoutPath(root: string): string {
  return path.join(root, '.vibgrate', BOARD_LAYOUT_FILE);
}

export function defaultBoardLayout(): ArchBoardLayout {
  return {
    magic: BOARD_LAYOUT_MAGIC,
    density: 'expanded',
    zoom: 'workspace',
    packageId: null,
    view: 'job',
    arch: true,
    positions: {},
  };
}

export function parseBoardLayout(raw: unknown): ArchBoardLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.magic !== BOARD_LAYOUT_MAGIC) return null;
  const density: ArchDensity =
    o.density === 'compact' || o.density === 'immersive' ? o.density : 'expanded';
  const view =
    o.view === 'calls' || o.view === 'missing' || o.view === 'problems' ? o.view : 'job';
  const positions: Record<string, { x: number; y: number }> = {};
  if (o.positions && typeof o.positions === 'object') {
    for (const [id, pos] of Object.entries(o.positions as Record<string, unknown>)) {
      if (!id || id.length > 400) continue;
      if (!pos || typeof pos !== 'object') continue;
      const x = (pos as { x?: unknown }).x;
      const y = (pos as { y?: unknown }).y;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      positions[id] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
      if (Object.keys(positions).length >= 2000) break;
    }
  }
  return {
    magic: BOARD_LAYOUT_MAGIC,
    density,
    zoom: o.zoom === 'slice' ? 'slice' : 'workspace',
    packageId: typeof o.packageId === 'string' && o.packageId.length < 400 ? o.packageId : null,
    view,
    arch: o.arch !== false,
    positions,
  };
}

export function readBoardLayout(root: string): ArchBoardLayout | null {
  const file = boardLayoutPath(root);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > 1_000_000) return null;
    return parseBoardLayout(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeBoardLayout(root: string, layout: ArchBoardLayout): ArchBoardLayout {
  const clean = parseBoardLayout(layout) ?? defaultBoardLayout();
  const dir = path.dirname(boardLayoutPath(root));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = boardLayoutPath(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, boardLayoutPath(root));
  return clean;
}
