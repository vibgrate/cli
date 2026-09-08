/**
 * Global compression-savings ledger: one JSON line per compression event,
 * `0o600`, 30-day retention, rollups for today / 7d / 30d / all by model,
 * client and project. Numbers only — no message content ever lands here.
 *
 * "Today" is the UTC calendar day of `now` so rollups are deterministic for
 * an injected clock regardless of the machine's timezone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { savingsEventsPath } from './paths.js';

export interface SavingsEvent {
  ts: number;
  source: 'proxy' | 'mcp' | 'sdk' | 'cli';
  model: string;
  client: string;
  project?: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  usdSaved: number;
  transforms: string[];
  ccrHashes: number;
  outputTokensSaved?: number;
}

export interface SavingsBucket {
  requests: number;
  tokensSaved: number;
  usdSaved: number;
}

export interface SavingsRollup {
  window: 'today' | '7d' | '30d' | 'all';
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  usdSaved: number;
  byModel: Record<string, SavingsBucket>;
  byClient: Record<string, SavingsBucket>;
  byProject: Record<string, SavingsBucket>;
}

export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const SOURCES = new Set(['proxy', 'mcp', 'sdk', 'cli']);
const LABEL_RE = /[^A-Za-z0-9_.:@/+-]/g;

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Sanitised, bounded label (model / client / project) safe for a JSON line. */
export function sanitizeLabel(v: unknown, fallback = 'unknown'): string {
  const s = typeof v === 'string' ? v.trim().replace(LABEL_RE, '_').slice(0, 96) : '';
  return s || fallback;
}

function normalize(raw: unknown): SavingsEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ts = n(r.ts);
  if (ts <= 0) return null;
  const before = Math.max(0, Math.floor(n(r.tokensBefore)));
  const after = Math.max(0, Math.floor(n(r.tokensAfter)));
  const ev: SavingsEvent = {
    ts,
    source: SOURCES.has(String(r.source)) ? (r.source as SavingsEvent['source']) : 'cli',
    model: sanitizeLabel(r.model),
    client: sanitizeLabel(r.client),
    tokensBefore: before,
    tokensAfter: after,
    tokensSaved: Math.max(0, Math.floor(n(r.tokensSaved) || before - after)),
    usdSaved: Math.max(0, n(r.usdSaved)),
    transforms: Array.isArray(r.transforms) ? r.transforms.filter((t): t is string => typeof t === 'string').slice(0, 64) : [],
    ccrHashes: Math.max(0, Math.floor(n(r.ccrHashes))),
  };
  if (typeof r.project === 'string' && r.project) ev.project = sanitizeLabel(r.project);
  if (r.outputTokensSaved !== undefined) ev.outputTokensSaved = Math.max(0, Math.floor(n(r.outputTokensSaved)));
  return ev;
}

/** Append one event (jsonl, 0600). Never throws; returns false when nothing was written. */
export function appendSavingsEvent(ev: SavingsEvent, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = normalize(ev);
  if (!norm) return false;
  const file = savingsEventsPath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(norm)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* non-POSIX */
    }
    return true;
  } catch {
    return false;
  }
}

/** Read events (bad lines skipped), optionally only those at/after `sinceMs`; retention is enforced on read when `now` is given. */
export function readSavingsEvents(env: NodeJS.ProcessEnv = process.env, opts: { sinceMs?: number; now?: number } = {}): SavingsEvent[] {
  const file = savingsEventsPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const floor = Math.max(opts.sinceMs ?? 0, opts.now !== undefined ? opts.now - RETENTION_DAYS * DAY_MS : 0);
  const out: SavingsEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = normalize(JSON.parse(t));
      if (ev && ev.ts >= floor) out.push(ev);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Rewrite the ledger keeping only events within `retentionDays` of `now`. Returns removed count. */
export function pruneSavingsEvents(env: NodeJS.ProcessEnv | undefined, now: number, retentionDays = RETENTION_DAYS): number {
  const e = env ?? process.env;
  const file = savingsEventsPath(e);
  const all = readSavingsEvents(e);
  if (all.length === 0) return 0;
  const days = Math.max(1, Math.min(retentionDays, RETENTION_DAYS));
  const floor = now - days * DAY_MS;
  const keep = all.filter((ev) => ev.ts >= floor);
  if (keep.length === all.length) return 0;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((ev) => JSON.stringify(ev)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* non-POSIX */
    }
  } catch {
    return 0;
  }
  return all.length - keep.length;
}

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function bump(map: Record<string, SavingsBucket>, key: string, ev: SavingsEvent): void {
  const b = map[key] ?? (map[key] = { requests: 0, tokensSaved: 0, usdSaved: 0 });
  b.requests += 1;
  b.tokensSaved += ev.tokensSaved;
  b.usdSaved += ev.usdSaved;
}

function sortRecord(map: Record<string, SavingsBucket>): Record<string, SavingsBucket> {
  const entries = Object.entries(map).sort((a, b) => b[1].usdSaved - a[1].usdSaved || b[1].tokensSaved - a[1].tokensSaved || (a[0] < b[0] ? -1 : 1));
  const out: Record<string, SavingsBucket> = {};
  for (const [k, v] of entries) out[k] = { ...v, usdSaved: Math.round(v.usdSaved * 1e6) / 1e6 };
  return out;
}

function rollup(window: SavingsRollup['window'], events: SavingsEvent[]): SavingsRollup {
  const r: SavingsRollup = { window, requests: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, usdSaved: 0, byModel: {}, byClient: {}, byProject: {} };
  for (const ev of events) {
    r.requests += 1;
    r.tokensBefore += ev.tokensBefore;
    r.tokensAfter += ev.tokensAfter;
    r.tokensSaved += ev.tokensSaved;
    r.usdSaved += ev.usdSaved;
    bump(r.byModel, ev.model, ev);
    bump(r.byClient, ev.client, ev);
    bump(r.byProject, ev.project ?? 'unknown', ev);
  }
  r.usdSaved = Math.round(r.usdSaved * 1e6) / 1e6;
  r.byModel = sortRecord(r.byModel);
  r.byClient = sortRecord(r.byClient);
  r.byProject = sortRecord(r.byProject);
  return r;
}

/** Rollups for the four windows (`all` = everything retained, 30 days). */
export function rollupSavings(events: SavingsEvent[], now: number): Record<'today' | '7d' | '30d' | 'all', SavingsRollup> {
  const retained = events.filter((ev) => ev.ts >= now - RETENTION_DAYS * DAY_MS && ev.ts <= now + DAY_MS);
  const today = utcDayStart(now);
  return {
    today: rollup('today', retained.filter((ev) => ev.ts >= today)),
    '7d': rollup('7d', retained.filter((ev) => ev.ts >= now - 7 * DAY_MS)),
    '30d': rollup('30d', retained),
    all: rollup('all', retained),
  };
}

/** Delete the ledger. */
export function resetSavings(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.rmSync(savingsEventsPath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}
