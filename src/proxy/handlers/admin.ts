/**
 * Loopback-only admin routes: settings (GET/POST), shutdown, attached
 * clients, a stored CCR entry by hash. Every mutation is audited (keys only).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { KNOBS, loadSettings, setSetting, validateEnv } from '../../compress/config.js';
import { settingsPath } from '../../compress/paths.js';
import type { ProxyContext } from '../context.js';
import { peerIp, requestIsSameOrigin } from '../guards.js';
import { parseJsonBody, sendJson } from '../http.js';
import { listClients, pruneStaleClients } from '../lifecycle.js';
import { RuntimeEnv } from '../runtime-env.js';

const SECRET_KNOB = /TOKEN|KEY|SECRET|AUTH/;

export function settingsView(ctx: ProxyContext): Record<string, unknown> {
  const stored = loadSettings(ctx.config.env);
  const settings: Record<string, unknown> = {};
  for (const k of Object.keys(stored).sort()) settings[k] = SECRET_KNOB.test(k) && stored[k] ? '<redacted>' : stored[k];
  const hot = RuntimeEnv.hotKnobNames();
  const knobs = KNOBS.filter((k) => !k.internal).map((k) => ({ name: k.name, type: k.type, scope: k.scope, default: k.default, values: k.values, description: k.description, hot: k.hot === true }));
  const effective = ctx.runtime.hotValues();
  for (const k of Object.keys(effective)) if (SECRET_KNOB.test(k) && effective[k]) effective[k] = '<redacted>';
  return { path: settingsPath(ctx.config.env), settings, effective, hot, knobs };
}

export function handleSettingsGet(ctx: ProxyContext, res: ServerResponse): void {
  sendJson(res, 200, settingsView(ctx));
}

export function handleSettingsPost(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if (!requestIsSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin settings update refused' });
    return;
  }
  const body = parseJsonBody(rawBody);
  const values = body && body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : null;
  if (!values) {
    sendJson(res, 400, { error: 'expected {values: {VG_...: value | null}}' });
    return;
  }
  const known = new Set(KNOBS.filter((k) => !k.internal).map((k) => k.name));
  const unknownKeys = Object.keys(values).filter((k) => !known.has(k));
  if (unknownKeys.length) {
    sendJson(res, 400, { error: 'unknown settings', unknown_keys: unknownKeys.sort() });
    return;
  }
  const fieldErrors: Record<string, string> = {};
  const staged: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === '') {
      staged[k] = null;
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      fieldErrors[k] = 'expected a string, number, boolean or null';
      continue;
    }
    const text = String(v);
    const problems = validateEnv({ [k]: text });
    if (problems.length) fieldErrors[k] = problems[0].replace(`${k}: `, '');
    else staged[k] = text;
  }
  if (Object.keys(fieldErrors).length) {
    sendJson(res, 422, { error: 'invalid settings', field_errors: fieldErrors });
    return;
  }
  const changed: string[] = [];
  for (const [k, v] of Object.entries(staged)) {
    const r = setSetting(k, v, ctx.config.env);
    if (!r.problems.length) changed.push(k);
  }
  const hot = new Set(RuntimeEnv.hotKnobNames());
  const needsRestart = changed.filter((k) => !hot.has(k)).sort();
  ctx.runtime.refresh();
  ctx.audit.record({ action: 'settings_update', method: 'POST', path: '/api/settings', sourceIp: peerIp(req), statusCode: 200, details: { changed_keys: changed.sort() } });
  sendJson(res, 200, { ok: true, changed_keys: changed.sort(), needs_restart: needsRestart, effective: ctx.runtime.hotValues() });
}

export function handleShutdown(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse): void {
  if (!requestIsSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin shutdown refused' });
    return;
  }
  ctx.audit.record({ action: 'shutdown', method: 'POST', path: '/api/proxy/shutdown', sourceIp: peerIp(req), statusCode: 202 });
  sendJson(res, 202, { ok: true, pid: ctx.pid, message: 'shutting down' });
  res.on('finish', () => ctx.requestShutdown());
}

export function handleClients(ctx: ProxyContext, res: ServerResponse): void {
  pruneStaleClients(ctx.config.port, ctx.config.env);
  sendJson(res, 200, { port: ctx.config.port, clients: listClients(ctx.config.port, ctx.config.env) });
}

export function handleCcrEntry(ctx: ProxyContext, res: ServerResponse, hash: string): void {
  const h = hash.trim().toLowerCase();
  if (!/^[a-f0-9]{12,24}$/.test(h)) {
    sendJson(res, 400, { error: 'hash must be 12–24 hex characters' });
    return;
  }
  const entry = ctx.deps.store?.get(h) ?? null;
  if (!entry) {
    sendJson(res, 404, { error: 'not found or expired', hash: h });
    return;
  }
  sendJson(res, 200, entry);
}

export function handleCacheClear(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse): void {
  if (!requestIsSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin cache clear refused' });
    return;
  }
  const cleared = ctx.semanticCache.clear();
  ctx.sessions.clear();
  ctx.audit.record({ action: 'cache_clear', method: 'POST', path: '/api/cache/clear', sourceIp: peerIp(req), statusCode: 200, details: { cleared } });
  sendJson(res, 200, { status: 'cleared', entries: cleared });
}

export function handleStatsReset(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse): void {
  if (!requestIsSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin stats reset refused' });
    return;
  }
  ctx.metrics.reset();
  ctx.cost.reset();
  ctx.audit.record({ action: 'stats_reset', method: 'POST', path: '/api/stats/reset', sourceIp: peerIp(req), statusCode: 200 });
  sendJson(res, 200, { status: 'reset' });
}
