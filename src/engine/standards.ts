import fs from 'node:fs';
import path from 'node:path';
import type { DepRecord } from './drift.js';

/**
 * Enterprise standards gate (VG-LIB-SUPERSET-PLAN §8/§9 S5 / D9) — the LOCAL, committable half
 * of enterprise sovereignty that complements the hosted `enterprise_strict` rerank (S5.1).
 *
 * A team commits a `.vibgrate/standards.json` policy of BANNED packages, each pointing at the
 * APPROVED alternative + a reason. `vg drift --fail-on standards` checks the project's resolved
 * inventory against it and exits non-zero with remediation on any planted violation — so the
 * banned-→-approved rule is enforced in CI, offline, no key, no platform call.
 *
 * Pure + offline: a tolerant loader (sync fs) + a deterministic checker over the drift inventory.
 */

export interface StandardRule {
  /** Optional ecosystem scope (npm|pypi|…). When set, only that ecosystem matches. */
  ecosystem?: string;
  /** Banned package name (exact, case-insensitive). */
  name: string;
  /** The approved alternative — the remediation surfaced to the developer. */
  use?: string;
  /** Why it's banned. */
  reason?: string;
}

export interface StandardsPolicy {
  banned: StandardRule[];
}

export interface StandardViolation {
  ecosystem: string;
  name: string;
  installed: string | null;
  use: string | null;
  reason: string | null;
}

/** Where a committed policy lives, in precedence order. */
export const STANDARDS_FILES = ['.vibgrate/standards.json', 'vibgrate.standards.json'];

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Tolerant parse: accepts `{ banned: [...] }` or a bare array; drops malformed rules (need a name). */
export function normalizeStandards(raw: unknown): StandardsPolicy {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { banned?: unknown })?.banned) ? (raw as { banned: unknown[] }).banned : [];
  const seen = new Set<string>();
  const banned: StandardRule[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = asString(r.name);
    if (!name) continue;
    const ecosystem = asString(r.ecosystem)?.toLowerCase();
    const key = `${ecosystem ?? '*'}\0${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    banned.push({ name, ...(ecosystem ? { ecosystem } : {}), ...(asString(r.use) ? { use: asString(r.use) } : {}), ...(asString(r.reason) ? { reason: asString(r.reason) } : {}) });
  }
  return { banned };
}

/** Find + load the nearest committed standards policy from `root`. Returns null if none/invalid. */
export function loadStandards(root: string): { policy: StandardsPolicy | null; path: string | null } {
  for (const rel of STANDARDS_FILES) {
    const p = path.join(root, rel);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    try {
      return { policy: normalizeStandards(JSON.parse(text)), path: p };
    } catch {
      // present but malformed JSON — surface it as a usage problem at the call site
      return { policy: null, path: p };
    }
  }
  return { policy: null, path: null };
}

/** Deterministic check of the inventory against the policy. One violation per matched dependency. */
export function checkStandards(policy: StandardsPolicy, records: DepRecord[]): StandardViolation[] {
  const out: StandardViolation[] = [];
  for (const r of records) {
    const rule = policy.banned.find((b) => b.name.toLowerCase() === r.name.toLowerCase() && (!b.ecosystem || b.ecosystem === r.ecosystem));
    if (rule) out.push({ ecosystem: r.ecosystem, name: r.name, installed: r.installed ?? null, use: rule.use ?? null, reason: rule.reason ?? null });
  }
  return out.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
}
