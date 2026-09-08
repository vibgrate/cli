/**
 * Put every marker-tracked config edit back — the
 * session file a crashed one-shot run left behind, and the durable wiring
 * written by `vg install <agent> --compress`. Files still held by another live session
 * are skipped (reported) unless `force`.
 */

import * as os from 'node:os';
import { AGENTS } from './agents.js';
import { readMarker } from './edit.js';
import type { AppliedChange, EditContext, WrapAgent } from './types.js';
import { WRAP_AGENTS } from './types.js';

export interface UnwrapOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  force?: boolean;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface UnwrapResult {
  reverted: AppliedChange[];
  skipped: string[];
}

/** Every config file an agent may have been wired through, deduplicated. */
export function candidateFiles(agent: WrapAgent, home: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  const spec = AGENTS[agent];
  const files = new Set<string>();
  if (spec.configFile) files.add(spec.configFile(home, cwd, env));
  if (spec.durableFile) {
    files.add(spec.durableFile(home, cwd, 'user', env));
    files.add(spec.durableFile(home, cwd, 'project', env));
  }
  return [...files];
}

export function unwrap(agent: WrapAgent | 'all', opts: UnwrapOptions = {}): UnwrapResult {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const agents: WrapAgent[] = agent === 'all' ? [...WRAP_AGENTS] : [agent];
  const reverted: AppliedChange[] = [];
  const skipped: string[] = [];
  for (const id of agents) {
    const spec = AGENTS[id];
    if (!spec.supportsUnwrap || !spec.revert) {
      if (agent !== 'all') skipped.push(`${id}: routed through the environment only — nothing durable to undo`);
      continue;
    }
    for (const file of candidateFiles(id, home, cwd, env)) {
      const marker = readMarker(file);
      if (!marker) continue;
      if (marker.agent !== id) continue;
      if (opts.dryRun) {
        reverted.push({ kind: 'file', agent: id, file, method: spec.method, status: 'reverted', fields: Object.keys(marker.fields).sort(), reason: 'dry-run' });
        continue;
      }
      const ctx: EditContext = { agent: id, env, pid: opts.pid, force: opts.force, releaseDurable: true, isAlive: opts.isAlive, now: opts.now };
      try {
        const r = spec.revert(file, ctx);
        if (r.status === 'reverted') reverted.push({ kind: 'file', agent: id, file, method: spec.method, status: r.status, fields: r.fields });
        else skipped.push(`${id}: ${file} — ${r.reason ?? r.status}`);
      } catch (err) {
        skipped.push(`${id}: ${file} — ${(err as Error).message}`);
      }
    }
  }
  return { reverted, skipped };
}
