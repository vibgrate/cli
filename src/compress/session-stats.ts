/**
 * Cross-process MCP session stats: every `vg serve` process appends a row per
 * compression; readers aggregate rows inside a 2-hour window and prune older
 * rows on read. Failures never surface (stats must not break compression).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionStatsPath } from './paths.js';

export const SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface SessionStatRow {
  ts: number;
  pid: number;
  tokensSaved: number;
  requests: number;
}

export interface SessionStatsSummary {
  tokensSaved: number;
  requests: number;
  processes: number;
  /** Rows from other processes only (sub-agents). */
  others: { tokensSaved: number; requests: number; processes: number };
}

function readRows(file: string): SessionStatRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: SessionStatRow[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as Record<string, unknown>;
      if (typeof r.ts === 'number' && typeof r.pid === 'number') out.push({ ts: r.ts, pid: r.pid, tokensSaved: typeof r.tokensSaved === 'number' ? r.tokensSaved : 0, requests: typeof r.requests === 'number' ? r.requests : 0 });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function recordSessionStat(row: { ts: number; pid: number; tokensSaved: number; requests: number }, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = sessionStatsPath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ ts: row.ts, pid: row.pid, tokensSaved: Math.max(0, Math.floor(row.tokensSaved)), requests: Math.max(0, Math.floor(row.requests)) })}\n`, { mode: 0o600 });
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

/** Aggregate rows within the window ending at `now`; prunes older rows from the file. */
export function readSessionStats(now: number, env: NodeJS.ProcessEnv = process.env, opts: { selfPid?: number } = {}): SessionStatsSummary {
  const file = sessionStatsPath(env);
  const rows = readRows(file);
  const floor = now - SESSION_WINDOW_MS;
  const kept = rows.filter((r) => r.ts >= floor && r.ts <= now + 60_000);
  if (kept.length !== rows.length) {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* best effort */
    }
  }
  const self = opts.selfPid ?? process.pid;
  const summary: SessionStatsSummary = { tokensSaved: 0, requests: 0, processes: 0, others: { tokensSaved: 0, requests: 0, processes: 0 } };
  const pids = new Set<number>();
  const otherPids = new Set<number>();
  for (const r of kept) {
    summary.tokensSaved += r.tokensSaved;
    summary.requests += r.requests;
    pids.add(r.pid);
    if (r.pid !== self) {
      summary.others.tokensSaved += r.tokensSaved;
      summary.others.requests += r.requests;
      otherPids.add(r.pid);
    }
  }
  summary.processes = pids.size;
  summary.others.processes = otherPids.size;
  return summary;
}
