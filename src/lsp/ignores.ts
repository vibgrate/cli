/**
 * Per-dependency ignores for the IDE surfaces — `.vibgrate/ignore.json`.
 *
 * An enterprise cannot adopt a score it cannot annotate: an acknowledged,
 * scheduled piece of drift needs to stop shouting without being hidden. An
 * ignore is therefore **presentation-only and always visible on demand**:
 *
 *   - it never changes the DriftScore (the number stays honest);
 *   - the inline decoration stays on the line, calmed to the low band and
 *     labelled `ignored`, and the hover names the reason and expiry;
 *   - per-package diagnostics for the ignored dependency are suppressed.
 *
 * The file is user-authored and deliberately NOT in `.vibgrate/.gitignore` —
 * an ignore with a reason and an expiry is a team decision that belongs in
 * review, exactly like a lint suppression:
 *
 * ```json
 * {
 *   "version": 1,
 *   "ignores": [
 *     { "package": "moment", "reason": "migration planned Q4", "until": "2026-12-31" }
 *   ]
 * }
 * ```
 *
 * `until` is optional (RFC3339 date); an expired entry is inactive, so a
 * "temporary" ignore genuinely is one. Reads are best-effort: a missing or
 * corrupt file is an empty set, never an error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IgnoreEntry {
  package: string;
  reason?: string;
  /** RFC3339 date; the entry is inactive from the day AFTER this date. */
  until?: string;
}

export function ignoreFilePath(root: string): string {
  return path.join(root, '.vibgrate', 'ignore.json');
}

export function isActive(entry: IgnoreEntry, now = Date.now()): boolean {
  if (!entry.until) return true;
  const t = Date.parse(entry.until);
  if (!Number.isFinite(t)) return true; // unparseable expiry — treat as open-ended, visibly wrong in review
  return now <= t + 24 * 60 * 60 * 1000 - 1; // inclusive through the named day
}

/**
 * Active ignores, keyed by lowercased package name. O(file) once per scan —
 * never read in a hover/decoration hot path.
 */
export function readIgnores(root: string, now = Date.now()): Map<string, IgnoreEntry> {
  const out = new Map<string, IgnoreEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(ignoreFilePath(root), 'utf8');
  } catch {
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as { ignores?: unknown };
    if (!Array.isArray(parsed.ignores)) return out;
    for (const e of parsed.ignores) {
      const entry = e as Partial<IgnoreEntry>;
      if (typeof entry.package !== 'string' || !entry.package.trim()) continue;
      const clean: IgnoreEntry = { package: entry.package.trim() };
      if (typeof entry.reason === 'string' && entry.reason.trim()) clean.reason = entry.reason.trim();
      if (typeof entry.until === 'string' && entry.until.trim()) clean.until = entry.until.trim();
      if (isActive(clean, now)) out.set(clean.package.toLowerCase(), clean);
    }
  } catch {
    /* corrupt file — empty set; the panel still shows everything */
  }
  return out;
}
