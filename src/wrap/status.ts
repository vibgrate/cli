/**
 * `vg serve status` and the `vg doctor` checks: which agents are currently
 * routed through the proxy by a marker-tracked config edit, who holds it,
 * and whether the holder is still alive.
 */

import * as os from 'node:os';
import { AGENTS } from './agents.js';
import { identityMismatch, pidAlive, procIdentity, readMarker, readOwners } from './edit.js';
import { candidateFiles } from './unwrap.js';
import { WRAP_AGENTS, type WrapAgent, type WrapStatusRow } from './types.js';

export interface StatusOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  agents?: WrapAgent[];
}

export function wrapStatus(opts: StatusOptions = {}): WrapStatusRow[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const isAlive = opts.isAlive ?? pidAlive;
  const rows: WrapStatusRow[] = [];
  for (const agent of opts.agents ?? WRAP_AGENTS) {
    const spec = AGENTS[agent];
    let row: WrapStatusRow = { agent, wrapped: false };
    if (spec.supportsUnwrap) {
      for (const file of candidateFiles(agent, home, cwd, env)) {
        const marker = readMarker(file);
        if (!marker || marker.agent !== agent) continue;
        const owners = readOwners(file);
        const holders = new Set<string>();
        for (const entry of Object.values(owners)) {
          for (const h of entry.holders) {
            if (h.durable) holders.add('durable');
            else if (isAlive(h.pid) && !identityMismatch(h, procIdentity(h.pid))) holders.add(String(h.pid));
          }
        }
        const markerAlive = marker.durable === true || (isAlive(marker.pid) && !identityMismatch(marker, procIdentity(marker.pid)));
        row = {
          agent,
          wrapped: true,
          file,
          owner: holders.size ? [...holders].sort().join(',') : marker.durable ? 'durable' : String(marker.pid),
          since: marker.appliedAt,
          url: marker.url,
          stale: !markerAlive && holders.size === 0,
        };
        break;
      }
    }
    rows.push(row);
  }
  return rows;
}

export interface WrapDiagnostic {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  hint?: string;
}

/** Shell-env + marker checks for `vg doctor` (proxy port from `VG_PROXY_PORT` / `VG_PROXY_URL`). */
export function wrapDiagnostics(env: NodeJS.ProcessEnv = process.env, opts: StatusOptions = {}): WrapDiagnostic[] {
  const out: WrapDiagnostic[] = [];
  const url = env.VG_PROXY_URL?.trim() || `http://${env.VG_PROXY_HOST?.trim() || '127.0.0.1'}:${env.VG_PROXY_PORT?.trim() || '8787'}`;
  const shellKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];
  const routed = shellKeys.filter((k) => (env[k] ?? '').startsWith(url));
  if (env.VG_WRAP_ACTIVE) out.push({ name: 'session', status: 'pass', summary: 'inside a one-session compression run' });
  if (routed.length) out.push({ name: 'shell env', status: 'pass', summary: `routed via ${routed.join(', ')}` });
  else {
    const foreign = shellKeys.filter((k) => /127\.0\.0\.1|localhost/.test(env[k] ?? ''));
    if (foreign.length) out.push({ name: 'shell env', status: 'warn', summary: `${foreign.join(', ')} points at a local port that is not the vg compression listener (${url})`, hint: `unset ${foreign[0]} or set VG_PROXY_URL` });
    else out.push({ name: 'shell env', status: 'pass', summary: 'this shell is not routed through compression (use `vg install <agent> --compress`)' });
  }
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    out.push({ name: 'claude auth', status: 'fail', summary: 'both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set', hint: 'unset one of them — Claude Code refuses to start with both' });
  }
  for (const row of wrapStatus({ ...opts, env })) {
    if (!row.wrapped) continue;
    if (row.stale) out.push({ name: `routing ${row.agent}`, status: 'warn', summary: `stale marker at ${row.file} (pid ${row.owner} is gone)`, hint: `run \`vg uninstall ${row.agent}\`` });
    else out.push({ name: `routing ${row.agent}`, status: 'pass', summary: `${row.file} routed to ${row.url} (pid ${row.owner})` });
  }
  return out;
}
