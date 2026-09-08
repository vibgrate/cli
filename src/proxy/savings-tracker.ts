/**
 * Durable proxy savings (`proxy-savings.json`, 0600, atomic, flushed every
 * 25 requests) plus the per-event ledger hand-off (`appendSavingsEvent`).
 *
 * Keeps lifetime totals, a display session (rolled over after 60 min idle),
 * cumulative history snapshots (bounded), and per-model / per-client /
 * per-project rows (bounded, smallest evicted into `other`). Non-finite
 * numbers are rejected at the boundary — NaN is absorbing under `+=`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { proxySavingsPath } from '../compress/paths.js';
import type { ProxyDeps, SavingsEventLike } from './deps.js';

export const SAVINGS_SCHEMA_VERSION = 1;
export const SAVINGS_FLUSH_EVERY = 25;
export const MAX_HISTORY_POINTS = 5000;
export const MAX_PROJECTS = 50;
export const MAX_MODELS = 200;
export const DISPLAY_SESSION_INACTIVITY_MS = 60 * 60_000;

interface Totals {
  requests: number;
  tokensBefore: number;
  tokensSaved: number;
  deferredTokens: number;
  outputTokensSaved: number;
  cacheReadTokens: number;
  inputTokens: number;
  usd: number;
  usdSaved: number;
}

function totals(): Totals {
  return { requests: 0, tokensBefore: 0, tokensSaved: 0, deferredTokens: 0, outputTokensSaved: 0, cacheReadTokens: 0, inputTokens: 0, usd: 0, usdSaved: 0 };
}

function fin(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function coerceTotals(v: unknown): Totals {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const t = totals();
  for (const k of Object.keys(t) as Array<keyof Totals>) t[k] = fin(o[k]);
  return t;
}

export interface HistoryPoint {
  ts: number;
  requests: number;
  tokensSaved: number;
  usdSaved: number;
  inputTokens: number;
  outputTokensSaved: number;
}

export interface SavingsState {
  schemaVersion: number;
  lifetime: Totals;
  session: Totals & { startedAt: number; lastActivityAt: number };
  history: HistoryPoint[];
  byModel: Record<string, Totals>;
  byClient: Record<string, Totals>;
  byProject: Record<string, Totals & { lastActivityAt: number }>;
  persistence: { healthy: boolean; error?: string; lastSavedAt?: number };
}

export interface SavingsRecordInput {
  model: string;
  client: string;
  project?: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  deferredTokens: number;
  outputTokensSaved: number;
  cacheReadTokens: number;
  usd: number;
  usdSaved: number;
  transforms: string[];
  ccrHashes: number;
}

export class SavingsTracker {
  state: SavingsState;
  private pending = 0;
  private readonly file: string;

  constructor(
    private readonly deps: Pick<ProxyDeps, 'appendSavingsEvent'>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly opts: { stateless?: boolean; now?: () => number; flushEvery?: number } = {},
  ) {
    this.file = proxySavingsPath(env);
    this.state = this.load();
  }

  private now(): number {
    return (this.opts.now ?? (() => Date.now()))();
  }

  private fresh(now: number): SavingsState {
    return { schemaVersion: SAVINGS_SCHEMA_VERSION, lifetime: totals(), session: { ...totals(), startedAt: now, lastActivityAt: now }, history: [], byModel: {}, byClient: {}, byProject: {}, persistence: { healthy: true } };
  }

  private load(): SavingsState {
    const now = this.now();
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.fresh(now);
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('root is not an object');
      const s = this.fresh(now);
      s.lifetime = coerceTotals(parsed.lifetime);
      const sess = (parsed.session && typeof parsed.session === 'object' ? parsed.session : {}) as Record<string, unknown>;
      s.session = { ...coerceTotals(sess), startedAt: fin(sess.startedAt) || now, lastActivityAt: fin(sess.lastActivityAt) || now };
      s.history = Array.isArray(parsed.history) ? (parsed.history as HistoryPoint[]).filter((p) => p && Number.isFinite(p.ts)).slice(-MAX_HISTORY_POINTS) : [];
      const rows = (v: unknown): Record<string, Totals> => {
        const out: Record<string, Totals> = {};
        if (v && typeof v === 'object') for (const [k, t] of Object.entries(v as Record<string, unknown>)) out[k] = coerceTotals(t);
        return out;
      };
      s.byModel = rows(parsed.byModel);
      s.byClient = rows(parsed.byClient);
      const projects = rows(parsed.byProject);
      for (const [k, t] of Object.entries(projects)) s.byProject[k] = { ...t, lastActivityAt: fin(((parsed.byProject as Record<string, Record<string, unknown>>)[k] ?? {}).lastActivityAt) };
      return s;
    } catch (err) {
      const corrupt = `${this.file}.corrupt-${new Date(now).toISOString().replace(/[:]/g, '-')}`;
      try {
        fs.renameSync(this.file, corrupt);
      } catch {
        /* ignore */
      }
      const s = this.fresh(now);
      s.persistence = { healthy: false, error: `corrupt savings file moved to ${path.basename(corrupt)}: ${(err as Error).message}` };
      return s;
    }
  }

  record(input: SavingsRecordInput): void {
    const now = this.now();
    const s = this.state;
    if (now - s.session.lastActivityAt > DISPLAY_SESSION_INACTIVITY_MS) s.session = { ...totals(), startedAt: now, lastActivityAt: now };
    const apply = (t: Totals): void => {
      t.requests++;
      t.tokensBefore += fin(input.tokensBefore);
      t.tokensSaved += fin(input.tokensSaved);
      t.deferredTokens += fin(input.deferredTokens);
      t.outputTokensSaved += fin(input.outputTokensSaved);
      t.cacheReadTokens += fin(input.cacheReadTokens);
      t.inputTokens += fin(input.tokensAfter);
      t.usd += fin(input.usd);
      t.usdSaved += fin(input.usdSaved);
    };
    apply(s.lifetime);
    apply(s.session);
    s.session.lastActivityAt = now;
    apply(bucket(s.byModel, input.model || 'unknown', MAX_MODELS));
    apply(bucket(s.byClient, input.client || 'unknown', MAX_MODELS));
    if (input.project) {
      const row = bucket(s.byProject, input.project, MAX_PROJECTS) as Totals & { lastActivityAt: number };
      apply(row);
      row.lastActivityAt = now;
    }
    if (input.tokensSaved > 0 || input.cacheReadTokens > 0 || input.outputTokensSaved > 0 || input.deferredTokens > 0) {
      s.history.push({ ts: now, requests: s.lifetime.requests, tokensSaved: s.lifetime.tokensSaved + s.lifetime.deferredTokens, usdSaved: s.lifetime.usdSaved, inputTokens: s.lifetime.inputTokens, outputTokensSaved: s.lifetime.outputTokensSaved });
      while (s.history.length > MAX_HISTORY_POINTS) s.history.shift();
    }
    const headline = fin(input.tokensSaved) + fin(input.deferredTokens);
    if (headline > 0 || fin(input.outputTokensSaved) > 0) {
      const ev: SavingsEventLike = { ts: now, source: 'proxy', model: input.model, client: input.client, project: input.project, tokensBefore: fin(input.tokensBefore) + fin(input.deferredTokens), tokensAfter: fin(input.tokensAfter), tokensSaved: headline, usdSaved: fin(input.usdSaved), transforms: input.transforms, ccrHashes: input.ccrHashes, outputTokensSaved: fin(input.outputTokensSaved) || undefined };
      if (!this.opts.stateless) this.deps.appendSavingsEvent(ev, this.env);
    }
    this.pending++;
    if (this.pending >= (this.opts.flushEvery ?? SAVINGS_FLUSH_EVERY)) this.flush();
  }

  flush(): void {
    this.pending = 0;
    if (this.opts.stateless) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      this.state.persistence.lastSavedAt = this.now();
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* non-POSIX */
      }
      this.state.persistence.healthy = true;
    } catch (err) {
      this.state.persistence = { healthy: false, error: (err as Error).message };
    }
  }

  reset(): void {
    this.state = this.fresh(this.now());
    this.flush();
  }

  /** Dashboard view with derived percentages (null for a zero denominator). */
  view(): Record<string, unknown> {
    const pct = (t: Totals): number | null => {
      const before = t.tokensBefore + t.deferredTokens;
      return before > 0 ? ((t.tokensSaved + t.deferredTokens) / before) * 100 : null;
    };
    const withPct = (t: Totals): Record<string, unknown> => ({ ...t, headlineTokensSaved: t.tokensSaved + t.deferredTokens, savingsPercent: pct(t) });
    const rows = (m: Record<string, Totals>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(m).sort()) out[k] = withPct(m[k]);
      return out;
    };
    return { schemaVersion: this.state.schemaVersion, lifetime: withPct(this.state.lifetime), session: { ...withPct(this.state.session), startedAt: this.state.session.startedAt, lastActivityAt: this.state.session.lastActivityAt }, history: this.state.history.slice(-500), byModel: rows(this.state.byModel), byClient: rows(this.state.byClient), byProject: rows(this.state.byProject), persistence: this.state.persistence, path: this.file };
  }
}

function bucket<T extends Totals>(map: Record<string, T>, key: string, max: number): T {
  if (map[key]) return map[key];
  if (Object.keys(map).length >= max) {
    if (!map.other) map.other = totals() as T;
    // Evict the smallest row into `other` to make room.
    let smallest: string | null = null;
    for (const [k, t] of Object.entries(map)) {
      if (k === 'other') continue;
      if (smallest === null || t.tokensSaved < map[smallest].tokensSaved) smallest = k;
    }
    if (smallest) {
      const t = map[smallest];
      for (const f of Object.keys(totals()) as Array<keyof Totals>) map.other[f] += t[f];
      delete map[smallest];
    }
  }
  map[key] = totals() as T;
  return map[key];
}
