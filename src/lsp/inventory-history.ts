/**
 * Previous-scan drifted-dependency snapshot — powers the per-dependency
 * "new since the previous scan" marker (coverage plan §6 P2-9, first step).
 *
 * The status bar's `⌁ +4` says the number moved; this says *which lines*
 * moved it. Snapshot semantics follow the score history's rules:
 *
 *   - machine-local (`.vibgrate/inline-inventory.json`, gitignored) — like
 *     `score-history.jsonl`, it is one machine's memory, not team state;
 *   - a comparison is only meaningful within one methodology — a methodology
 *     change yields no markers rather than wrong ones;
 *   - only drifted dependencies are stored (`project.path::package` keys), so
 *     the file stays small on any repo.
 *
 * Everything is O(drifted deps) once per scan. Reads/writes are best-effort;
 * a missing or corrupt snapshot means "no markers this round", never an error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';

export interface InventorySnapshot {
  /** RFC3339 scan time (the artifact's timestamp). */
  ts: string;
  methodology: string;
  /** `project.path::package` for every drifted dependency in that scan. */
  drifted: string[];
}

export function inventoryPath(root: string): string {
  return path.join(root, '.vibgrate', 'inline-inventory.json');
}

export function inventoryKey(projectPath: string, pkg: string): string {
  return `${projectPath}::${pkg}`;
}

export function readInventory(root: string): InventorySnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(inventoryPath(root), 'utf8')) as Partial<InventorySnapshot>;
    if (
      typeof parsed.ts === 'string' &&
      typeof parsed.methodology === 'string' &&
      Array.isArray(parsed.drifted) &&
      parsed.drifted.every((d) => typeof d === 'string')
    ) {
      return parsed as InventorySnapshot;
    }
  } catch {
    /* missing or corrupt — no baseline this round */
  }
  return null;
}

export function recordInventory(root: string, snap: InventorySnapshot): void {
  try {
    ensureVibgrateGitignore(root);
    fs.writeFileSync(inventoryPath(root), `${JSON.stringify(snap)}\n`);
  } catch {
    /* best-effort — a read-only workspace just gets no markers next scan */
  }
}

/**
 * Keys drifted now that were not drifted in the previous snapshot. Empty when
 * there is no previous snapshot, when it is the same scan (same timestamp), or
 * when the methodology changed — no markers beats wrong markers.
 */
export function newlyDrifted(prev: InventorySnapshot | null, current: InventorySnapshot): Set<string> {
  const out = new Set<string>();
  if (!prev || prev.methodology !== current.methodology || prev.ts === current.ts) return out;
  const before = new Set(prev.drifted);
  for (const key of current.drifted) {
    if (!before.has(key)) out.add(key);
  }
  return out;
}
