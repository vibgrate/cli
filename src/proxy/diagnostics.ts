/**
 * `proxyDiagnostics(env)` — the rows `vg doctor` can print for the proxy:
 * running state, version drift, shell routing, token/bind posture, budget,
 * settings validity. Read-only; never prints, never touches the network
 * except the loopback `/health` probe when `probe` is on.
 */

import { validateEnv, env as knobEnv, loadSettings } from '../compress/config.js';
import { settingsPath, proxyStatePath } from '../compress/paths.js';
import { VERSION } from '../version.js';
import { isLoopbackBind } from './config.js';
import { pidAlive, probeProxy, readProxyState } from './lifecycle.js';

export interface ProxyDiagnosis {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  summary: string;
  hint?: string;
}

export async function proxyDiagnostics(env: NodeJS.ProcessEnv = process.env, opts: { probe?: boolean; fetch?: typeof fetch } = {}): Promise<ProxyDiagnosis[]> {
  const rows: ProxyDiagnosis[] = [];
  const port = knobEnv.int('VG_PROXY_PORT', env, { min: 1, max: 65535 });
  const host = knobEnv.string('VG_PROXY_HOST', env) ?? '127.0.0.1';
  const state = readProxyState(port, env);
  if (!state) rows.push({ name: 'proxy', status: 'info', summary: `not running on port ${port} (no state file at ${proxyStatePath(port, env)})`, hint: 'start it with `vg serve --compress --background` (or `vg install <agent> --compress`, which starts it for you)' });
  else if (!pidAlive(state.pid)) rows.push({ name: 'proxy', status: 'warn', summary: `stale state file for pid ${state.pid} on port ${port}`, hint: 'run `vg serve stop` to clean up, then `vg serve --compress --background`' });
  else {
    let live = true;
    if (opts.probe !== false) live = (await probeProxy(state.url, { fetch: opts.fetch, token: state.token })).ok;
    rows.push({ name: 'proxy', status: live ? 'ok' : 'warn', summary: live ? `running at ${state.url} (pid ${state.pid}, ${state.mode}/${state.profile}, v${state.version})` : `pid ${state.pid} alive but ${state.url}/health did not answer` });
    if (state.version && state.version !== VERSION) rows.push({ name: 'proxy-version', status: 'warn', summary: `proxy v${state.version} differs from installed v${VERSION}`, hint: 'restart the proxy to pick up the new version' });
  }
  if (!isLoopbackBind(host)) {
    const token = knobEnv.string('VG_PROXY_TOKEN', env);
    rows.push({ name: 'proxy-bind', status: token ? 'warn' : 'fail', summary: token ? `non-loopback bind ${host} with token auth` : `non-loopback bind ${host} without VG_PROXY_TOKEN — the proxy will refuse to start`, hint: token ? undefined : 'set VG_PROXY_TOKEN or bind 127.0.0.1' });
  }
  const url = state?.url ?? `http://127.0.0.1:${port}`;
  const shellVars = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'].filter((v) => (env[v] ?? '').trim());
  const routed = shellVars.filter((v) => (env[v] ?? '').replace(/\/+$/, '').startsWith(url));
  if (routed.length) rows.push({ name: 'shell-route', status: 'ok', summary: `this shell routes via ${routed.join(', ')}` });
  else if (shellVars.length) rows.push({ name: 'shell-route', status: 'warn', summary: `${shellVars.join(', ')} set but not pointing at ${url}`, hint: 'this shell bypasses compression; use `vg install <agent> --compress` or export the base URL' });
  else rows.push({ name: 'shell-route', status: 'info', summary: 'no base-URL override in this shell', hint: 'use `vg install <agent> --compress` to route an agent through it' });
  const budget = knobEnv.float('VG_PROXY_BUDGET', env, { min: 0 });
  rows.push(budget > 0 ? { name: 'proxy-budget', status: 'ok', summary: `$${budget} per ${knobEnv.enum('VG_PROXY_BUDGET_PERIOD', env)}` } : { name: 'proxy-budget', status: 'info', summary: 'no spend cap', hint: 'set VG_PROXY_BUDGET (USD per period) to enforce one' });
  const settings = loadSettings(env);
  const problems = validateEnv(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v === null ? '' : String(v)])));
  rows.push(problems.length ? { name: 'proxy-settings', status: 'fail', summary: `${settingsPath(env)}: ${problems.join('; ')}`, hint: 'fix with `vg serve config set KEY VALUE` / `vg serve config unset KEY`' } : { name: 'proxy-settings', status: 'ok', summary: `${Object.keys(settings).length} setting(s) in ${settingsPath(env)}` });
  const envProblems = validateEnv(env);
  if (envProblems.length) rows.push({ name: 'proxy-env', status: 'warn', summary: envProblems.join('; ') });
  return rows;
}
