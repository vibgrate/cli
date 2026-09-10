/**
 * One agent session through the local compression listener: make sure the
 * listener is up, point the
 * agent at it (environment, session args, or a marker-tracked config edit),
 * register this process as a proxy client, run the agent with inherited
 * stdio, forward termination signals, propagate its exit code, and undo
 * every edit on the way out.
 *
 * Everything with a side effect outside this process — the proxy lifecycle,
 * `spawn`, PATH lookup, the signal source — is injectable for tests.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { env as knobs } from '../compress/config.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info } from '../util/output.js';
import { whichOnPath } from '../util/cli-invocation.js';
import { ensureProxyRunning, registerClient, unregisterClient } from '../proxy/lifecycle.js';
import { AGENTS, PROJECT_ENV, projectNameFromCwd, stripAutoModelArgs } from './agents.js';
import { CaptureWriter } from './capture.js';
import { loginCopilot, resolveCopilotBearer, type AuthDeps } from './copilot-auth.js';
import { identityMismatch, markerConflict, pidAlive, procIdentity, readMarker } from './edit.js';
import type { AppliedChange, EditContext, EnsureProxyFn, WrapAgent, WrapPlan } from './types.js';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface WrapOptions {
  args: string[];
  port?: number;
  host?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  ensureProxy?: EnsureProxyFn;
  spawn?: SpawnFn;
  quiet?: boolean;
  dryRun?: boolean;
  now?: () => number;
  /** Savings profile forwarded to the proxy (`--profile`). */
  profile?: string;
  /** JSONL capture file (`--capture`). */
  capture?: string;
  /** Reuse a running proxy; never start one. */
  noProxy?: boolean;
  /** Copilot: sign in with the device flow first (`--login`). */
  login?: boolean;
  /** Copilot: subscription lane (exchange the OAuth token and hand Copilot a bearer). */
  subscription?: boolean;
  /** PATH lookup (tests). */
  which?: (cmd: string) => string | null;
  /** Where SIGINT/SIGTERM/SIGHUP arrive (default `process`). */
  signals?: EventEmitter;
  /** Proxy client registry (tests). */
  clients?: { register: typeof registerClient; unregister: typeof unregisterClient };
  /** TCP liveness probe for stale-marker healing (tests). */
  portAlive?: (port: number) => Promise<boolean>;
  /** Copilot device-flow deps (tests). */
  fetch?: typeof fetch;
  /** `gh auth token` runner for Copilot discovery (tests pass `null` to skip it). */
  exec?: AuthDeps['exec'] | null;
  /** Line printer for the banner (default stderr). */
  log?: (line: string) => void;
  pid?: number;
  /** Liveness oracle for owner/marker checks (tests). */
  isAlive?: (pid: number) => boolean;
}

export interface WrapResult {
  exitCode: number;
  proxyUrl: string;
  applied: AppliedChange[];
  plan?: WrapPlan;
}

const QUIET_CLI_ENV: Record<string, string> = {
  GIT_PAGER: 'cat',
  PIP_QUIET: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_progress: 'false',
};

/** Reduce-at-source noise in the wrapped agent's subprocesses; only absent keys are filled. */
export function quietCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(QUIET_CLI_ENV)) if (env[k] === undefined) out[k] = v;
  const addopts = env.PYTEST_ADDOPTS ?? '';
  if (!/(^|\s)-q(\s|$)/.test(addopts)) out.PYTEST_ADDOPTS = addopts ? `${addopts} -q` : '-q';
  return out;
}

/** Alive on the first successful connect; dead only after every attempt fails. */
export async function tcpPortAlive(port: number, host = '127.0.0.1', opts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean): void => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(opts.timeoutMs ?? 1000, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (ok) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 250));
  }
  return false;
}

function signalNumber(sig: NodeJS.Signals | null): number {
  if (!sig) return 1;
  const n = (os.constants.signals as Record<string, number>)[sig];
  return n ? 128 + n : 1;
}

/** Spawn the agent, forward SIGTERM/SIGHUP, ignore SIGINT (the terminal already delivered it to the child). */
export function runChild(spawnFn: SpawnFn, command: string, args: string[], env: NodeJS.ProcessEnv, signals: EventEmitter, cwd: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: 'inherit', env, cwd });
    const forward = (sig: NodeJS.Signals) => (): void => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = [
      ['SIGTERM', forward('SIGTERM')],
      ['SIGHUP', forward('SIGHUP')],
      ['SIGINT', () => undefined],
    ];
    for (const [s, h] of handlers) signals.on(s, h);
    const cleanup = (): void => {
      for (const [s, h] of handlers) signals.off(s, h);
    };
    child.once('error', (err) => {
      cleanup();
      reject(err);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? signalNumber(signal));
    });
  });
}

/** Watcher mode: keep the proxy attached until SIGINT/SIGTERM/SIGHUP. */
export function waitForSignal(signals: EventEmitter): Promise<number> {
  return new Promise<number>((resolve) => {
    const handlers: Array<[NodeJS.Signals, () => void]> = [];
    const done = (code: number): void => {
      for (const [s, h] of handlers) signals.off(s, h);
      resolve(code);
    };
    handlers.push(['SIGINT', () => done(0)], ['SIGTERM', () => done(128 + 15)], ['SIGHUP', () => done(128 + 1)]);
    for (const [s, h] of handlers) signals.on(s, h);
  });
}

export function proxyTimeoutMs(env: NodeJS.ProcessEnv): number {
  return Math.max(1, knobs.float('VG_WRAP_PROXY_TIMEOUT', env, { min: 1, max: 3600 })) * 1000;
}

function rel(file: string, cwd: string, home: string): string {
  if (file.startsWith(`${cwd}${path.sep}`)) return path.relative(cwd, file);
  if (file.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, file)}`;
  return file;
}

function banner(name: string): string[] {
  const title = ` vg · compressing ${name} `;
  const width = Math.max(47, title.length + 2);
  const pad = width - title.length;
  const left = Math.floor(pad / 2);
  return [`┌${'─'.repeat(width)}┐`, `│${' '.repeat(left)}${title}${' '.repeat(pad - left)}│`, `└${'─'.repeat(width)}┘`];
}

/** Banner/plan values: credentials are shown as `<redacted>`, URLs and switches verbatim. */
function redactValue(name: string, value: string): string {
  return /(_TOKEN|_KEY|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name) ? '<redacted>' : value;
}

/**
 * Heal a marker left by a dead session before this one claims the slot: port
 * liveness is authoritative (a reboot recycles PIDs), a responding port is a
 * live session and is never cleared; without a port, PID staleness decides.
 */
export async function healDeadMarker(file: string, agent: WrapAgent, ctx: EditContext, portAlive: (port: number) => Promise<boolean>): Promise<boolean> {
  const marker = readMarker(file);
  if (!marker || marker.durable) return false;
  const isAlive = ctx.isAlive ?? pidAlive;
  const identity = ctx.identity ?? procIdentity;
  if (typeof marker.port === 'number') {
    if (await portAlive(marker.port)) return false;
  } else if (isAlive(marker.pid) && !identityMismatch(marker, identity(marker.pid))) {
    return false;
  }
  const spec = AGENTS[agent];
  if (!spec.revert) return false;
  const r = spec.revert(file, { ...ctx, pid: marker.pid, force: false });
  return r.status === 'reverted';
}

export async function wrap(agent: WrapAgent, opts: WrapOptions): Promise<WrapResult> {
  const spec = AGENTS[agent];
  if (!spec) throw new CliError(`unknown agent "${agent}"; known: ${Object.keys(AGENTS).join(', ')}`, ExitCode.USAGE_ERROR);
  const env = opts.env ?? process.env;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const quiet = opts.quiet ?? knobs.bool('VG_WRAP_QUIET', env);
  const log = opts.log ?? ((line: string) => info(line));
  const say = quiet ? (): void => undefined : log;
  const which = opts.which ?? whichOnPath;
  const signals = opts.signals ?? process;
  const clients = opts.clients ?? { register: registerClient, unregister: unregisterClient };
  const ensureProxy = opts.ensureProxy ?? ensureProxyRunning;
  const portAlive = opts.portAlive ?? ((p: number) => tcpPortAlive(p, opts.host ?? knobs.string('VG_PROXY_HOST', env) ?? '127.0.0.1'));
  const launchCtx = { home, cwd, env };

  if (agent === 'copilot' && opts.login) {
    await loginCopilot({ env, fetch: opts.fetch, now, log });
  }

  // Binary (or watcher mode for GUI-configured agents).
  let binary: string | null = null;
  for (const b of spec.binary) {
    const found = which(b);
    if (found) {
      binary = found;
      break;
    }
  }
  const watcher = binary === null;
  if (watcher && !spec.notes) {
    const hint = spec.install ? ` Install it: \`${spec.install}\`.` : '';
    throw new CliError(`${spec.name} not found on PATH (looked for ${spec.binary.join(', ')}).${hint}`, ExitCode.ERROR);
  }

  // Proxy.
  const host = opts.host ?? knobs.string('VG_PROXY_HOST', env) ?? '127.0.0.1';
  let port = opts.port ?? knobs.int('VG_PROXY_PORT', env, { min: 1, max: 65535 });
  const profile = opts.profile ?? (knobs.isSet('VG_COMPRESS_PROFILE', env) ? knobs.string('VG_COMPRESS_PROFILE', env) : undefined);
  const proxyArgs = profile ? ['--profile', profile] : [];
  // Upstream pins for a listener this run starts. A listener that is already
  // running keeps its own configuration — one shared listener, one upstream.
  const pins = spec.proxyEnv?.(env) ?? {};
  const proxyEnv: NodeJS.ProcessEnv = { ...env, ...pins, VG_PROXY_AGENT_TYPE: env.VG_PROXY_AGENT_TYPE ?? agent };
  if (opts.capture) proxyEnv.VG_WRAP_CAPTURE_FILE = path.resolve(cwd, opts.capture);
  const explicitUrl = env.VG_PROXY_URL?.trim();
  let proxyUrl = explicitUrl || `http://${host}:${port}`;
  let started = false;

  // Copilot subscription lane: resolve a bearer before anything durable happens.
  let token: string | undefined;
  if (agent === 'copilot' && opts.subscription && !opts.dryRun) {
    const bearer = await resolveCopilotBearer({ env, fetch: opts.fetch, now, home, exec: opts.exec === null ? null : opts.exec } as AuthDeps);
    if (!bearer) throw new CliError('no GitHub Copilot token found — run `vg install copilot-cli --compress --login` (or set GITHUB_COPILOT_TOKEN).', ExitCode.ERROR);
    token = bearer.token;
    say(`  copilot  ${bearer.source} (${bearer.fingerprint})`);
  }

  const unset = spec.unsetEnv?.(proxyUrl, token, launchCtx) ?? [];
  const agentEnv = spec.env(proxyUrl, token, launchCtx);
  const userArgs = agent === 'copilot' && token ? stripAutoModelArgs(opts.args) : opts.args;
  const launchArgs = spec.launchArgs ? spec.launchArgs(proxyUrl, userArgs, launchCtx) : [];
  const configFile = spec.apply && spec.sessionEdits !== false ? spec.configFile?.(home, cwd, env) : undefined;

  const plan: WrapPlan = {
    agent,
    name: spec.name,
    binary,
    watcher,
    proxyUrl,
    env: Object.fromEntries(Object.entries(agentEnv).map(([k, v]) => [k, redactValue(k, v)])),
    unset,
    args: [...launchArgs, ...userArgs],
    configFile,
    proxyArgs,
    proxyEnv: pins,
  };

  if (opts.dryRun) {
    say(`vg serve --compress ${agent} --dry-run (nothing started, nothing written)`);
    say(`  binary   ${binary ?? `(none — watcher mode; ${spec.notes ?? ''})`}`);
    say(`  proxy    ${proxyUrl}${proxyArgs.length ? `  (vg serve --compress ${proxyArgs.join(' ')})` : ''}`);
    for (const [k, v] of Object.entries(pins)) say(`  upstream ${k}=${v}`);
    for (const [k, v] of Object.entries(plan.env)) say(`  env      ${k}=${v}`);
    for (const k of unset) say(`  unset    ${k}`);
    if (configFile) say(`  config   ${rel(configFile, cwd, home)} (${spec.method})`);
    if (plan.args.length) say(`  args     ${plan.args.join(' ')}`);
    return { exitCode: ExitCode.OK, proxyUrl, applied: [], plan };
  }

  if (!opts.noProxy && !explicitUrl) {
    const r = await ensureProxy({ port, host, timeoutMs: proxyTimeoutMs(env), spawnArgs: proxyArgs, env: proxyEnv, detached: true });
    proxyUrl = r.url;
    port = r.port;
    started = r.started;
  }
  // Rebuild everything URL-derived in case the port moved.
  const finalEnv = spec.env(proxyUrl, token, launchCtx);
  const finalArgs = spec.launchArgs ? spec.launchArgs(proxyUrl, userArgs, launchCtx) : [];
  const applied: AppliedChange[] = [];
  const editCtx: EditContext = { agent, env, pid, port, now, isAlive: opts.isAlive };

  let capture: CaptureWriter | undefined;
  if (opts.capture) {
    capture = new CaptureWriter(path.resolve(cwd, opts.capture));
    capture.session('start', { ts: now(), agent, proxyUrl, cwd });
  }

  // Config edits owned by this session. Durable routing for the same agent in
  // the same directory (`vg install <agent> --compress`) already covers it.
  let sessionFile = configFile;
  const conflict = configFile ? markerConflict(configFile) : null;
  if (conflict && conflict.durable && conflict.agent === agent) {
    say(`  config   ${rel(conflict.file, cwd, home)} ${c.dim('(durable routing already installed — leaving it)')}`);
    sessionFile = undefined;
  }
  if (sessionFile && spec.apply) {
    await healDeadMarker(sessionFile, agent, editCtx, portAlive);
    const r = spec.apply(sessionFile, proxyUrl, editCtx);
    applied.push({ kind: 'file', agent, file: sessionFile, method: spec.method, status: r.status, backup: r.backup, fields: r.fields });
  }
  for (const name of unset) applied.push({ kind: 'unset', name });
  for (const [name, value] of Object.entries(finalEnv)) applied.push({ kind: 'env', name, value });
  if (finalArgs.length) applied.push({ kind: 'args', args: finalArgs });

  let registered = false;
  try {
    clients.register(port, { pid, agent, cwd }, env);
    registered = true;
  } catch {
    /* a read-only runtime dir must not block the launch */
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const k of unset) delete childEnv[k];
  Object.assign(childEnv, quietCliEnv(childEnv), finalEnv, { VG_WRAP_ACTIVE: '1', VG_PROXY_URL: proxyUrl, [PROJECT_ENV]: env[PROJECT_ENV] ?? projectNameFromCwd(cwd) });

  for (const line of banner(spec.name)) say(c.cyan(line));
  say(`  proxy    ${proxyUrl}  ${c.dim(started ? '(started)' : '(reused)')}`);
  for (const [k, v] of Object.entries(finalEnv)) say(`  env      ${k}=${redactValue(k, v)}`);
  if (sessionFile) say(`  config   ${rel(sessionFile, cwd, home)} ${c.dim('(reverted on exit)')}`);
  if (finalArgs.length) say(`  args     ${finalArgs.join(' ')}`);
  if (spec.notes) say(`  note     ${spec.notes.replace(/<proxy>/g, proxyUrl)}`);
  say(`  savings  ${c.dim('vg savings · vg show savings')} ${proxyUrl}/`);
  if (watcher) say(`  ${c.dim('Press Ctrl+C to stop.')}`);
  say('');

  let exitCode: number = ExitCode.ERROR;
  try {
    if (watcher) exitCode = await waitForSignal(signals);
    else exitCode = await runChild(opts.spawn ?? (nodeSpawn as SpawnFn), binary!, [...finalArgs, ...userArgs], childEnv, signals, cwd);
  } finally {
    if (sessionFile && spec.revert) {
      try {
        const r = spec.revert(sessionFile, editCtx);
        applied.push({ kind: 'file', agent, file: sessionFile, method: spec.method, status: r.status, fields: r.fields, reason: r.reason });
      } catch (err) {
        log(`warning: could not revert ${sessionFile}: ${(err as Error).message} — run \`vg uninstall ${agent}\``);
      }
    }
    if (registered) {
      try {
        clients.unregister(port, pid, env);
      } catch {
        /* best effort */
      }
    }
    capture?.session('end', { ts: now(), agent, proxyUrl, cwd, exitCode });
  }
  return { exitCode, proxyUrl, applied, plan };
}
