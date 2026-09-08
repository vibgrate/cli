/**
 * Audit trail for administrative / state-mutating actions: one JSON line per
 * event, keys only — values (settings contents, tokens) are never written.
 * Appended to `<logDir>/audit.jsonl` (0600) when `VG_PROXY_AUDIT` is on;
 * always kept in a small in-memory ring for the dashboard. Never throws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logDir } from '../compress/paths.js';

export interface AuditEvent {
  event: 'vg_admin_audit';
  action: string;
  method: string;
  path: string;
  sourceIp: string;
  statusCode: number;
  ts: string;
  details?: Record<string, unknown>;
}

const ADMIN_PREFIXES = ['/api/settings', '/api/proxy/', '/api/ccr/', '/api/cache/', '/api/stats/reset'];

export function isAuditablePath(p: string): boolean {
  return ADMIN_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

export class AuditLog {
  readonly recent: AuditEvent[] = [];
  private readonly file: string;
  constructor(
    env: NodeJS.ProcessEnv,
    private readonly opts: { enabled: () => boolean; stateless?: boolean; now?: () => number } = { enabled: () => false },
  ) {
    this.file = path.join(logDir(env), 'audit.jsonl');
  }

  record(ev: Omit<AuditEvent, 'event' | 'ts'>): void {
    try {
      const full: AuditEvent = { event: 'vg_admin_audit', ts: new Date((this.opts.now ?? (() => Date.now()))()).toISOString(), ...ev };
      if (full.details) full.details = keysOnly(full.details);
      this.recent.push(full);
      while (this.recent.length > 100) this.recent.shift();
      if (!this.opts.enabled() || this.opts.stateless) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    } catch {
      /* auditing never breaks a request */
    }
  }
}

/** Details may name keys and counts, never values. */
function keysOnly(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? x : typeof x));
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 64 ? `${v.slice(0, 64)}…` : v;
    else if (v && typeof v === 'object') out[k] = Object.keys(v as Record<string, unknown>).sort();
  }
  return out;
}
