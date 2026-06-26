import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheDir } from './cache.js';

/**
 * Usage-savings tracking (VG-DEVELOPMENT-PLAN §5) — local, privacy-safe, and
 * **opt-in** (no telemetry by default, per GUARDRAILS). We record *counts only*
 * — never code, never the question text — comparing the context tokens vg
 * returned against a grep/read baseline estimate. `vg savings` reports it with
 * the assumptions shown; figures are labelled estimates, never a hero number.
 */

const LEDGER = 'savings.jsonl';
// A conservative, documented estimate: tokens an agent reads per file it opens.
export const PER_FILE_TOKENS = 400;

export interface SavingEntry {
  ts: number; // epoch ms (runtime ledger state, not part of any artifact)
  tool: string;
  vgTokens: number;
  baselineTokens: number;
}

function ledgerPath(root: string): string {
  return path.join(cacheDir(root), LEDGER);
}

/** Whether a savings ledger exists for this repo (i.e. `vg serve --savings` has recorded). */
export function savingsRecorded(root: string): boolean {
  return fs.existsSync(ledgerPath(root));
}

export function recordSaving(root: string, entry: Omit<SavingEntry, 'ts'>, now: number): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    const line = JSON.stringify({ ts: now, ...entry });
    fs.appendFileSync(ledgerPath(root), line + '\n');
  } catch {
    /* never let telemetry break a tool call */
  }
}

export interface SavingsReport {
  enabled: boolean;
  days: number;
  queries: number;
  vgTokens: number;
  baselineTokens: number;
  ratio: number;
  estCostVg: number;
  estCostBaseline: number;
  saved: number;
  rateLabel: string;
}

// Published-style input rate ($/1M tokens), shipped with the CLI. Labelled
// estimate; the user can pass their own model rate.
const DEFAULT_RATE_PER_M = 3.0; // e.g. a mid-tier model input rate
const DEFAULT_RATE_LABEL = 'input @ $3/1M';

export function readSavings(root: string, days: number, now: number, ratePerM = DEFAULT_RATE_PER_M): SavingsReport {
  const file = ledgerPath(root);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let queries = 0;
  let vgTokens = 0;
  let baselineTokens = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SavingEntry;
        if (e.ts < cutoff) continue;
        queries++;
        vgTokens += e.vgTokens;
        baselineTokens += e.baselineTokens;
      } catch {
        /* skip corrupt line */
      }
    }
  }
  const estCostVg = (vgTokens / 1e6) * ratePerM;
  const estCostBaseline = (baselineTokens / 1e6) * ratePerM;
  return {
    enabled: savingsRecorded(root),
    days,
    queries,
    vgTokens,
    baselineTokens,
    ratio: vgTokens > 0 ? Math.round((baselineTokens / vgTokens) * 100) / 100 : 0,
    estCostVg: round2(estCostVg),
    estCostBaseline: round2(estCostBaseline),
    saved: round2(estCostBaseline - estCostVg),
    rateLabel: DEFAULT_RATE_LABEL,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
