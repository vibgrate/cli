/**
 * `scanSessions` — run every (or the requested) scanner, filter by time and
 * project, and return a deterministically ordered list. A scanner that
 * throws is skipped (one broken transcript store never hides the others).
 */

import * as path from 'node:path';
import { aiderScanner } from './scanners/aider.js';
import { claudeScanner } from './scanners/claude.js';
import { codexScanner } from './scanners/codex.js';
import { copilotScanner } from './scanners/copilot.js';
import { cursorScanner } from './scanners/cursor.js';
import { geminiScanner } from './scanners/gemini.js';
import { grokScanner } from './scanners/grok.js';
import { opencodeScanner } from './scanners/opencode.js';
import { AGENT_IDS, isAgentId, type AgentId, type Scanner, type ScanOptions, type Session } from './types.js';

export const SCANNERS: Readonly<Record<AgentId, Scanner>> = {
  claude: claudeScanner,
  codex: codexScanner,
  gemini: geminiScanner,
  grok: grokScanner,
  opencode: opencodeScanner,
  cursor: cursorScanner,
  copilot: copilotScanner,
  aider: aiderScanner,
};

export function scannerFor(agent: string): Scanner | null {
  return isAgentId(agent) ? SCANNERS[agent] : null;
}

function normalizePath(p: string): string {
  let r = path.resolve(p).replace(/\\/g, '/');
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r.toLowerCase();
}

/** True when `sessionProject` is `root` or lies inside it. */
export function projectMatches(sessionProject: string | undefined, root: string): boolean {
  if (!sessionProject) return false;
  const a = normalizePath(sessionProject);
  const b = normalizePath(root);
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

export function compareSessions(a: Session, b: Session): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface ScanSessionsOptions extends ScanOptions {
  /** Agents to scan (default: all). Unknown names are ignored. */
  agents?: string[];
  /** Collects per-scanner failures (never thrown). */
  onError?: (agent: AgentId, error: unknown) => void;
}

export function scanSessions(opts: ScanSessionsOptions): Session[] {
  const requested = (opts.agents && opts.agents.length ? opts.agents : AGENT_IDS).filter(isAgentId);
  const agents = [...new Set(requested)];
  const out: Session[] = [];
  for (const agent of agents) {
    let sessions: Session[] = [];
    try {
      sessions = SCANNERS[agent].scan({ sinceMs: opts.sinceMs, project: opts.project, now: opts.now, env: opts.env, home: opts.home });
    } catch (e) {
      opts.onError?.(agent, e);
      continue;
    }
    for (const s of sessions) {
      if (s.turns.length === 0) continue;
      if (opts.sinceMs !== undefined && s.endedAt < opts.sinceMs) continue;
      if (opts.project !== undefined && !projectMatches(s.project, opts.project)) continue;
      out.push(s);
    }
  }
  out.sort(compareSessions);
  return out;
}

/** `7d`, `24h`, `30m`, `2w` → milliseconds; null when unparseable. */
export function parseDuration(spec: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day|days|w|wk|weeks?)?\s*$/i.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd').toLowerCase();
  const mult = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('w') ? 7 * 86_400_000 : 86_400_000;
  return Math.round(n * mult);
}
