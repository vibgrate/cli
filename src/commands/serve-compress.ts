import type { Command } from 'commander';
import { effectiveConfig, isProfileName, loadSettings, setSetting, KNOBS } from '../compress/config.js';
import { settingsPath } from '../compress/paths.js';
import type { ProfileName, ProxyMode } from '../compress/types.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { c, info, json } from '../util/output.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { configSummary, resolveProxyConfig, type ProxyConfig } from '../proxy/config.js';
import { startProxy } from '../proxy/server.js';
import { pidAlive, probeProxy, readProxyState, stopProxy, listClients, pruneStaleClients } from '../proxy/lifecycle.js';
import { wrapStatus } from '../wrap/status.js';
import { AGENTS } from '../wrap/agents.js';
import { copilotStatus } from '../wrap/copilot-auth.js';

/**
 * The compression half of `vg serve` (FEATURE-DESIGN-PRINCIPLES P1: no new
 * top-level verb — one local runtime, more listeners).
 *
 * `vg serve --compress` adds an Anthropic- and OpenAI-compatible listener to
 * the same process that already serves MCP, so any agent pointed at it gets
 * its tool output compressed on the wire. The subcommands registered here
 * manage that listener and the compression settings:
 *
 *   vg serve status            what is listening, and which agents are routed
 *   vg serve stop              stop a background listener
 *   vg serve config [set|unset]  settings.json and the effective knob values
 *
 * `vg serve compress` / `vg serve retrieve` (registered from their own files)
 * run the same pipeline by hand — an offline debug path, not an everyday verb.
 */
export function registerServeCompression(serve: Command): void {
  const status = serve
    .command('status')
    .description('what the local runtime is serving: compression listener, attached agents, sign-in state')
    .option('--port <n>', 'compression port to inspect')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const port = portOf(this.opts().port) ?? resolveProxyConfig().port;
      const state = readProxyState(port);
      const alive = state ? pidAlive(state.pid) : false;
      const probe = state && alive ? await probeProxy(state.url, { token: state.token }) : { ok: false };
      pruneStaleClients(port);
      const clients = listClients(port);
      const routed = wrapStatus({ cwd: global.cwd });
      const copilot = copilotStatus();
      const payload = {
        port,
        running: Boolean(state && alive && probe.ok),
        state: state ? { ...state, token: state.token ? '<set>' : undefined } : null,
        pidAlive: alive,
        healthy: probe.ok,
        version: probe.version,
        clients,
        routed: routed.filter((r) => r.wrapped),
        agents: routed,
        copilot,
      };
      if (global.json) {
        json(payload);
        return;
      }
      if (!state) info(`${c.cyan('vg serve status')} · no compression listener on port ${port} ${c.dim('(start one with `vg serve --compress`)')}`);
      else if (!alive) info(`${c.cyan('vg serve status')} · ${c.yellow('stale')} state file for pid ${state.pid} on port ${port} ${c.dim('(run `vg serve stop` to clean up)')}`);
      else if (!probe.ok) info(`${c.cyan('vg serve status')} · pid ${state.pid} alive but ${state.url}/health did not answer`);
      else info(`${c.cyan('vg serve status')} · ${c.green('compressing')} at ${state.url} ${c.dim(`(pid ${state.pid}, ${state.mode}/${state.profile}, v${state.version})`)}`);
      if (clients.length) {
        info(c.dim('  attached clients:'));
        for (const cl of clients) info(`    ${cl.agent.padEnd(12)} pid ${String(cl.pid).padEnd(7)} ${cl.alive ? c.green('alive') : c.dim('gone ')}  ${c.dim(cl.cwd)}`);
      }
      const routedRows = routed.filter((r) => r.wrapped);
      info(`  ${c.bold('routed agents')} ${c.dim('(durable config written by `vg install <agent> --compress`)')}`);
      if (!routedRows.length) info(c.dim('    none — run `vg install <agent> --compress`'));
      for (const r of routedRows) {
        const since = r.since ? new Date(r.since).toISOString() : '';
        info(`    ${r.agent.padEnd(14)} ${AGENTS[r.agent].name.padEnd(24)} ${r.file}  ${c.dim(`pid ${r.owner} · since ${since}`)}${r.stale ? c.yellow('  stale — run `vg uninstall`') : ''}`);
      }
      info(`    ${'copilot'.padEnd(14)} ${copilot.loggedIn ? `signed in (${copilot.fingerprint})` : c.dim('not signed in — `vg install copilot --compress --login`')}`);
      if (!payload.running) process.exitCode = ExitCode.NOT_FOUND;
    });
  applyGlobalOptions(status);

  const stop = serve
    .command('stop')
    .description('stop a background compression listener (graceful shutdown, then SIGTERM)')
    .option('--port <n>', 'port to stop')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const port = portOf(this.opts().port) ?? resolveProxyConfig().port;
      const r = await stopProxy(port);
      if (global.json) {
        json({ port, ...r });
        return;
      }
      if (r.stopped) info(`${c.cyan('vg serve stop')} · stopped the compression listener on port ${port}${r.pid ? c.dim(` (pid ${r.pid})`) : ''}`);
      else if (r.pid) {
        info(`${c.cyan('vg serve stop')} · ${c.yellow('failed')} to stop pid ${r.pid} on port ${port}; stop it manually`);
        process.exitCode = ExitCode.ERROR;
      } else info(`${c.cyan('vg serve stop')} · nothing listening on port ${port}`);
    });
  applyGlobalOptions(stop);

  const config = serve
    .command('config')
    .description('print settings.json and the effective compression knob values')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const cfg = resolveProxyConfig();
      const settings = loadSettings();
      if (global.json) {
        json({ file: settingsPath(), settings: redactSettings(settings), effective: effectiveConfig(cfg.env), listener: configSummary(cfg) });
        return;
      }
      info(`${c.cyan('vg serve config')} · ${c.dim(settingsPath())}`);
      const keys = Object.keys(settings).sort();
      if (!keys.length) info(c.dim('  (no settings stored; `vg serve config set KEY VALUE` to add one)'));
      for (const k of keys) info(`  ${k.padEnd(40)} ${/TOKEN|KEY|SECRET|AUTH/.test(k) ? '<redacted>' : String(settings[k])}`);
      info('');
      showConfig(cfg, false);
    });
  applyGlobalOptions(config);

  const set = config
    .command('set <key> <value>')
    .description('write a VG_* setting to settings.json (hot knobs apply on the next request)')
    .action(function (this: Command, key: string, value: string) {
      const global = readGlobal(this);
      const r = setSetting(key, value);
      if (r.problems.length) throw usageError(r.problems.join('; '));
      const hot = KNOBS.find((k) => k.name === key)?.hot === true;
      if (global.json) json({ ok: true, key, value, file: r.file, hot });
      else info(`${c.cyan('vg serve config set')} · ${key}=${value} ${c.dim(`→ ${r.file}`)}${hot ? '' : c.yellow(' (restart the listener to apply)')}`);
    });
  applyGlobalOptions(set);

  const unset = config
    .command('unset <key>')
    .description('remove a VG_* setting from settings.json')
    .action(function (this: Command, key: string) {
      const global = readGlobal(this);
      const r = setSetting(key, null);
      if (r.problems.length) throw usageError(r.problems.join('; '));
      if (global.json) json({ ok: true, key, file: r.file });
      else info(`${c.cyan('vg serve config unset')} · ${key} removed ${c.dim(`from ${r.file}`)}`);
    });
  applyGlobalOptions(unset);
}

export function portOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw usageError(`invalid port: ${String(v)}`);
  return n;
}

/** The compression flags `vg serve` accepts, mapped onto the proxy config. */
export function compressionOverrides(o: { compressPort?: string; profile?: string; compressMode?: string }): Partial<ProxyConfig> {
  const overrides: Partial<ProxyConfig> = {};
  const port = portOf(o.compressPort);
  if (port !== undefined) overrides.port = port;
  if (typeof o.profile === 'string') {
    if (!isProfileName(o.profile)) throw usageError(`--profile must be coding, balanced, aggressive or general, got ${o.profile}`);
    overrides.profile = o.profile as ProfileName;
  }
  if (typeof o.compressMode === 'string') {
    const mode = o.compressMode.toLowerCase();
    if (mode !== 'cache' && mode !== 'token') throw usageError(`--compress-mode must be cache or token, got ${o.compressMode}`);
    overrides.mode = mode as ProxyMode;
  }
  return overrides;
}

/** Env keys pinned by an explicit flag, so a hot-reload never overwrites them. */
export function pinnedKnobs(keys: string[]): string[] {
  const map: Record<string, string> = { port: 'VG_PROXY_PORT', mode: 'VG_COMPRESS_MODE', profile: 'VG_COMPRESS_PROFILE' };
  return keys.map((k) => map[k]).filter((v): v is string => Boolean(v));
}

export interface CompressionListener {
  url: string;
  port: number;
  /** Already serving when we arrived — we neither started nor own it. */
  attached: boolean;
  close(): Promise<void>;
}

/**
 * Bring up the compression listener for this `vg serve` process.
 *
 * A healthy listener already on the port is **attached to**, not fought over:
 * several assistants each spawn their own `vg serve --compress` over stdio, and
 * the second one failing with EADDRINUSE would be a worse answer than sharing
 * the one that is already compressing.
 */
export async function startCompression(
  cfg: ProxyConfig,
  opts: { stderr: boolean; pinned: string[] },
): Promise<CompressionListener> {
  const existing = readProxyState(cfg.port);
  if (existing && pidAlive(existing.pid) && (await probeProxy(existing.url, { token: existing.token })).ok) {
    return { url: existing.url, port: cfg.port, attached: true, close: async () => {} };
  }
  let running;
  try {
    running = await startProxy(cfg, { stderr: opts.stderr, pinnedKnobs: pinnedKnobs(opts.pinned) });
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `port ${cfg.port} is in use by something that is not a vg compression listener — pick another with --compress-port`
        : (err as Error).message;
    throw new CliError(msg, ExitCode.ERROR);
  }
  return { url: running.url, port: running.port, attached: false, close: () => running.close() };
}

function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(settings).sort()) out[k] = /TOKEN|KEY|SECRET|AUTH/.test(k) && settings[k] ? '<redacted>' : settings[k];
  return out;
}

export function showConfig(cfg: ProxyConfig, asJson: boolean): void {
  const rows = effectiveConfig(cfg.env);
  if (asJson) {
    json({ listener: Object.fromEntries(configSummary(cfg).map((r) => [r.key, r.value])), knobs: rows });
    return;
  }
  info(`${c.cyan('vg serve')} · effective compression configuration ${c.dim('(flag > env > settings.json > profile > default)')}`);
  for (const r of configSummary(cfg)) info(`  ${r.key.padEnd(16)} ${r.value}`);
  info('');
  info(c.bold('  knobs') + c.dim('  (● hot: applies on the next request without a restart)'));
  let scope = '';
  for (const r of rows) {
    if (r.scope !== scope) {
      scope = r.scope;
      info(c.dim(`  -- ${scope}`));
    }
    info(`  ${(r.hot ? '● ' : '  ') + r.name.padEnd(44)} ${String(r.value ?? '').padEnd(24)} ${c.dim(r.source)}`);
  }
}
