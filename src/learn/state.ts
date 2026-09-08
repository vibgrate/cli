/**
 * Learn state — last-run bookkeeping per project under `learnDir()`.
 * `<learnDir>/state.json` (0600, atomic); tolerant reader.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { learnDir } from '../compress/paths.js';

export interface LearnRun {
  lastRunAt: number;
  target: string;
  sessions: number;
  applied: boolean;
  rules: number;
  agents: string[];
}

export interface LearnState {
  version: 1;
  runs: Record<string, LearnRun>;
}

export function learnStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(learnDir(env), 'state.json');
}

export function readLearnState(env: NodeJS.ProcessEnv = process.env): LearnState {
  try {
    const parsed = JSON.parse(fs.readFileSync(learnStatePath(env), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      const runs = p.runs && typeof p.runs === 'object' && !Array.isArray(p.runs) ? (p.runs as Record<string, LearnRun>) : {};
      return { version: 1, runs };
    }
  } catch {
    /* absent or malformed */
  }
  return { version: 1, runs: {} };
}

export function recordLearnRun(projectKey: string, run: LearnRun, env: NodeJS.ProcessEnv = process.env): string {
  const state = readLearnState(env);
  state.runs[projectKey] = run;
  const file = learnStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sorted: Record<string, LearnRun> = {};
  for (const k of Object.keys(state.runs).sort()) sorted[k] = state.runs[k];
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, runs: sorted }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return file;
}

export function lastLearnRun(projectKey: string, env: NodeJS.ProcessEnv = process.env): LearnRun | null {
  return readLearnState(env).runs[projectKey] ?? null;
}
