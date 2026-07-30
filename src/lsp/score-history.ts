/**
 * Local DriftScore history for `vg lsp`.
 *
 * Feeds the two trend surfaces the IDE plan specifies: the sidebar panel's
 * 90-day sparkline (§5.6) and the status bar's drift diff (`⌁ +4`, §5.8).
 * The engine records and diffs; clients only render — no client ever computes
 * a score or a delta (plan §12).
 *
 * Lives at `.vibgrate/score-history.jsonl` — machine-local like the graph and
 * caches, but deliberately NOT under `.vibgrate/cache/`: a cache can be wiped
 * at any time, and wiping it must not erase the trend a user has accrued.
 *
 * A delta is only meaningful within one methodology: scores from different
 * methodology versions are not comparable (DRIFTSCORE-V3-SPEC version-tag
 * note), so `deltaFrom` refuses to bridge a change and the sparkline breaks
 * its line there instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';

export interface ScoreHistoryEntry {
  /** RFC3339 scan time (the artifact's timestamp, not the write time). */
  ts: string;
  score: number;
  band: string;
  mode: 'verified' | 'estimated';
  methodology: string;
}

/** Keep the file bounded; rewrite down to KEEP once it grows past MAX. */
const MAX_ENTRIES = 1000;
const KEEP_ENTRIES = 500;

function historyPath(root: string): string {
  return path.join(root, '.vibgrate', 'score-history.jsonl');
}

function parseLine(line: string): ScoreHistoryEntry | null {
  try {
    const e = JSON.parse(line) as Partial<ScoreHistoryEntry>;
    if (
      typeof e.ts === 'string' &&
      typeof e.score === 'number' &&
      typeof e.band === 'string' &&
      (e.mode === 'verified' || e.mode === 'estimated') &&
      typeof e.methodology === 'string'
    ) {
      return e as ScoreHistoryEntry;
    }
  } catch {
    /* corrupt line — skip it, keep the rest of the file usable */
  }
  return null;
}

/** Best-effort read of the full history, oldest-first. Missing file → []. */
export function readHistory(root: string): ScoreHistoryEntry[] {
  try {
    return fs
      .readFileSync(historyPath(root), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map(parseLine)
      .filter((e): e is ScoreHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

/** The most recent recorded entry, or null when there is no history yet. */
export function lastEntry(root: string): ScoreHistoryEntry | null {
  const all = readHistory(root);
  return all.length ? all[all.length - 1]! : null;
}

/**
 * Entries from the trailing `days` window, oldest-first — the sparkline's data.
 * The window is judged against `now` so a long-idle repo returns [] rather
 * than a stale-but-plausible line.
 */
export function recentHistory(root: string, days: number, now = Date.now()): ScoreHistoryEntry[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return readHistory(root).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Record a score observation. Appends only when it says something new: a
 * changed score/band/mode/methodology, or the first observation in 24 hours
 * (so a stable repo still accrues a flat-line the sparkline can draw, without
 * an entry per keystroke-triggered rescan). Best-effort: a read-only checkout
 * just means no history.
 */
export function recordScore(root: string, entry: ScoreHistoryEntry): void {
  try {
    const prev = lastEntry(root);
    if (
      prev &&
      prev.score === entry.score &&
      prev.band === entry.band &&
      prev.mode === entry.mode &&
      prev.methodology === entry.methodology
    ) {
      const prevT = Date.parse(prev.ts);
      const nextT = Date.parse(entry.ts);
      if (Number.isFinite(prevT) && Number.isFinite(nextT) && nextT - prevT < 24 * 60 * 60 * 1000) {
        return; // nothing new to say yet
      }
    }
    const file = historyPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // First writer into .vibgrate/ in this repo creates its .gitignore (create-once,
    // never overwritten) — so this file is protected even when `vg lsp` runs before
    // any `vg scan`/`vg build`/`vg install`.
    ensureVibgrateGitignore(root);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);

    // Bound the file. Rewrite is rare (every ~500 recorded changes).
    const all = readHistory(root);
    if (all.length > MAX_ENTRIES) {
      const kept = all.slice(-KEEP_ENTRIES);
      fs.writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  } catch {
    /* best-effort only */
  }
}

/**
 * Engine-side drift diff: the signed change from the previous recorded entry
 * to `current`. Undefined (absent, not zero — plan §12 / AGENTS.md rule 6)
 * when there is no previous entry or the methodology changed in between.
 */
export function deltaFrom(prev: ScoreHistoryEntry | null, current: ScoreHistoryEntry): number | undefined {
  if (!prev) return undefined;
  if (prev.methodology !== current.methodology) return undefined;
  return current.score - prev.score;
}
