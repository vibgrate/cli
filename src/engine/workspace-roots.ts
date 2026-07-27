/**
 * Pure workspace-roots helpers (Fusion Runtime / federation).
 *
 * Stream S owns the long-term pure library design; this module is the F-side
 * implementation used by federation + vgd until S lands a shared package.
 * No daemon I/O — path math only.
 *
 * @see docs/plans/coordination/FUSION-HANDOFF.md
 * @see src/runtime/federation.ts
 */

import * as path from 'node:path';
import { repositoryIdFromRoot } from '../runtime/paths.js';

export interface WorkspaceRoot {
  /** Absolute normalized path */
  root: string;
  /** Stable id (same as global store repository id) */
  id: string;
  /** Basename label */
  label: string;
}

/**
 * Normalize a list of roots (absolute or relative to `base`) into unique
 * WorkspaceRoot records. Deterministic order: sorted by absolute root path.
 */
export function normalizeWorkspaceRoots(roots: string[], base: string = process.cwd()): WorkspaceRoot[] {
  const seen = new Set<string>();
  const out: WorkspaceRoot[] = [];
  const baseAbs = path.resolve(base);
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const abs = path.resolve(baseAbs, r.trim());
    const id = repositoryIdFromRoot(abs);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      root: abs,
      id,
      label: path.basename(abs) || abs,
    });
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** True if `child` is equal to or nested under `parent` (path-safe). */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Pick the primary root: explicit `preferred` if present in the set, else the
 * first after sort (deterministic).
 */
export function selectPrimaryRoot(roots: WorkspaceRoot[], preferred?: string): WorkspaceRoot | null {
  if (!roots.length) return null;
  if (preferred?.trim()) {
    const abs = path.resolve(preferred.trim());
    const hit = roots.find((r) => r.root === abs || r.id === repositoryIdFromRoot(abs));
    if (hit) return hit;
  }
  return roots[0] ?? null;
}
