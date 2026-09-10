/**
 * Proxy lifecycle: state file, start lock, ensure-running (spawn a daemon
 * and wait for `/health`), stop, and the per-port client markers used by
 * `vg serve status` to know who is attached. DESIGN.md §3.3.
 *
 * Files live under `contextRuntimeDir()`; everything is 0600/0700 and
 * written atomically. `token` is written only when the proxy has one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { env as knobEnv } from '../compress/config.js';
import { proxyClientsDir, proxyStartLockPath, proxyStatePath } from '../compress/paths.js';
import type { ProfileName, ProxyMode } from '../compress/types.js';

export interface ProxyState {
  pid: number;
  port: number;
  host: string;
  url: string;
  version: string;
  startedAt: number;
  mode: ProxyMode;
  profile: ProfileName;
  token?: string;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX */
  }
}

export function writeProxyState(state: ProxyState, env: NodeJS.ProcessEnv = process.env): string {
  const file = proxyStatePath(state.port, env);
  const out: ProxyState = { ...state };
  if (!out.token) delete out.token;
  atomicWrite(file, `${JSON.stringify(out, null, 2)}\n`);
  return file;
}

export function removeProxyState(port: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(proxyStatePath(port, env));
  } catch {
    /* already gone */
  }
}

export function readProxyState(port: number, env: NodeJS.ProcessEnv = process.env): ProxyState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(proxyStatePath(port, env), 'utf8')) as Partial<ProxyState>;
    if (!raw || typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.url !== 'string') return null;
    return { pid: raw.pid, port: raw.port, host: raw.host ?? '127.0.0.1', url: raw.url, version: raw.version ?? '', startedAt: raw.startedAt ?? 0, mode: raw.mode ?? 'cache', profile: raw.profile ?? 'coding', ...(raw.token ? { token: raw.token } : {}) };
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** pid alive (sync). For the `/health` probe use `probeProxy`. */
export function isProxyAlive(state: ProxyState): boolean {
  return pidAlive(state.pid);
}

export async function probeProxy(url: string, opts: { timeoutMs?: number; fetch?: typeof fetch; token?: string } = {}): Promise<{ ok: boolean; version?: string; pid?: number }> {
  const f = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1000);
  timer.unref?.();
  try {
    const headers: Record<string, string> = {};
    if (opts.token) headers['x-vg-token'] = opts.token;
    const res = await f(`${url.replace(/\/+$/, '')}/health`, { signal: controller.signal, headers });
    if (!res.ok) return { ok: false };
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (j.service !== 'vg-proxy') return { ok: false };
    return { ok: true, version: typeof j.version === 'string' ? j.version : undefined, pid: typeof j.pid === 'number' ? j.pid : undefined };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Start lock
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60_000;

/** Acquire the advisory start lock (O_EXCL). Returns a release function or null when held. */
export function acquireStartLock(port: number, env: NodeJS.ProcessEnv = process.env, now: () => number = () => Date.now()): (() => void) | null {
  const file = proxyStartLockPath(port, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tryOpen = (): number | null => {
    try {
      return fs.openSync(file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };
  let fd = tryOpen();
  if (fd === null) {
    // Break a stale lock (holder died or older than 60 s).
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; at?: number };
      const stale = !pidAlive(raw.pid ?? -1) || now() - (raw.at ?? 0) > LOCK_STALE_MS;
      if (stale) {
        fs.unlinkSync(file);
        fd = tryOpen();
      }
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      fd = tryOpen();
    }
  }
  if (fd === null) return null;
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
  fs.closeSync(fd);
  return () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
}

// ---------------------------------------------------------------------------
// Ensure running / stop
// ---------------------------------------------------------------------------

export interface EnsureOptions {
  port?: number;
  host?: string;
  timeoutMs?: number;
  /** Extra `vg serve` flags for the daemon (e.g. `--profile aggressive`). */
  spawnArgs?: string[];
  /** Environment for the daemon: upstream pins (`VG_PROXY_OPENAI_API_URL`, …) live here, not in flags. */
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  /** Injected for tests. */
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  execPath?: string;
  script?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The argv the detached listener is started with. `vg serve` is the one
 * runtime, so the daemon is `vg serve --compress-only --compress-daemon`: the
 * compression listener without a code map, kept alive until `vg serve stop`
 * (or the admin shutdown route). The bind host travels as `VG_PROXY_HOST`
 * because `--host` on `vg serve` belongs to MCP-over-HTTP, not the listener.
 *
 * Exported so the spawner and the command it spawns are tested against each
 * other: the previous form (`vg proxy --background`) outlived the verb it
 * named, and nothing caught the daemon exiting 5 before it ever bound.
 */
export function daemonArgv(port: number, extra: string[] = []): string[] {
  return ['serve', '--compress-only', '--compress-daemon', '--compress-port', String(port), '--quiet', ...extra];
}

/**
 * Start-lock → probe → spawn a detached `vg serve --compress-only
 * --compress-daemon --compress-port N` (stdio ignored) → wait for `/health`.
 * Returns the live state.
 */
export async function ensureProxyRunning(opts: EnsureOptions = {}): Promise<{ url: string; port: number; pid: number; started: boolean; state: ProxyState }> {
  const env = opts.env ?? process.env;
  const port = opts.port ?? knobEnv.int('VG_PROXY_PORT', env, { min: 1, max: 65535 });
  const host = opts.host ?? knobEnv.string('VG_PROXY_HOST', env) ?? '127.0.0.1';
  const url = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  const timeoutMs = opts.timeoutMs ?? Math.round(knobEnv.float('VG_WRAP_PROXY_TIMEOUT', env, { min: 1 }) * 1000);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const existing = readProxyState(port, env);
  const probeOpts = { fetch: opts.fetch, token: existing?.token ?? knobEnv.string('VG_PROXY_TOKEN', env) };

  const alive = async (): Promise<ProxyState | null> => {
    const state = readProxyState(port, env);
    const probe = await probeProxy(url, probeOpts);
    if (probe.ok) return state ?? { pid: probe.pid ?? 0, port, host, url, version: probe.version ?? '', startedAt: 0, mode: 'cache', profile: 'coding' };
    return null;
  };

  const live = await alive();
  if (live) return { url, port, pid: live.pid, started: false, state: live };

  const deadline = now() + timeoutMs;
  let release = acquireStartLock(port, env, now);
  while (!release) {
    // Someone else is starting it: wait for them.
    await sleep(100);
    const s = await alive();
    if (s) return { url, port, pid: s.pid, started: false, state: s };
    if (now() > deadline) throw new Error(`timed out waiting for another process to start the proxy on port ${port}`);
    release = acquireStartLock(port, env, now);
  }
  try {
    const again = await alive();
    if (again) return { url, port, pid: again.pid, started: false, state: again };
    const execPath = opts.execPath ?? process.execPath;
    const script = opts.script ?? process.argv[1];
    const args = [script, ...daemonArgv(port, opts.spawnArgs)];
    const child = (opts.spawn ?? spawn)(execPath, args, { detached: opts.detached ?? true, stdio: 'ignore', env: { ...env, VG_PROXY_HOST: host, VG_PROXY_PORT: String(port) } });
    if (opts.detached ?? true) child.unref();
    while (now() < deadline) {
      await sleep(150);
      const s = await alive();
      if (s) return { url, port, pid: s.pid || child.pid || 0, started: true, state: s };
      if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) throw new Error(`proxy exited with code ${child.exitCode} before becoming ready`);
    }
    throw new Error(`proxy on port ${port} did not become ready within ${timeoutMs} ms`);
  } finally {
    release();
  }
}

export async function stopProxy(port: number, opts: { signal?: NodeJS.Signals; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}): Promise<{ stopped: boolean; pid?: number }> {
  const env = opts.env ?? process.env;
  const state = readProxyState(port, env);
  const f = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const url = state?.url ?? `http://127.0.0.1:${port}`;
  let requested = false;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (state?.token) headers['x-vg-token'] = state.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await f(`${url}/api/proxy/shutdown`, { method: 'POST', headers, body: '{}', signal: controller.signal });
    clearTimeout(timer);
    requested = res.status === 202 || res.ok;
  } catch {
    requested = false;
  }
  const pid = state?.pid;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  if (requested) {
    while (Date.now() < deadline) {
      await sleep(100);
      if (!pid || !pidAlive(pid)) {
        removeProxyState(port, env);
        return { stopped: true, pid };
      }
    }
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, opts.signal ?? 'SIGTERM');
    } catch {
      return { stopped: false, pid };
    }
    while (Date.now() < deadline + 3000) {
      await sleep(100);
      if (!pidAlive(pid)) break;
    }
    const stopped = !pidAlive(pid);
    if (stopped) removeProxyState(port, env);
    return { stopped, pid };
  }
  if (state) removeProxyState(port, env);
  return { stopped: Boolean(state), pid };
}

// ---------------------------------------------------------------------------
// Client markers
// ---------------------------------------------------------------------------

export interface ClientMarker {
  pid: number;
  agent: string;
  cwd: string;
  since: number;
}

export function registerClient(port: number, client: { pid: number; agent: string; cwd: string }, env: NodeJS.ProcessEnv = process.env, now: () => number = () => Date.now()): string {
  const dir = proxyClientsDir(port, env);
  const file = path.join(dir, `${client.pid}.json`);
  const marker: ClientMarker = { ...client, since: now() };
  atomicWrite(file, `${JSON.stringify(marker)}\n`);
  return file;
}

export function unregisterClient(port: number, pid: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(path.join(proxyClientsDir(port, env), `${pid}.json`));
  } catch {
    /* already gone */
  }
}

export function listClients(port: number, env: NodeJS.ProcessEnv = process.env): Array<{ pid: number; agent: string; cwd: string; alive: boolean; since?: number }> {
  const dir = proxyClientsDir(port, env);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Array<{ pid: number; agent: string; cwd: string; alive: boolean; since?: number }> = [];
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Partial<ClientMarker>;
      const pid = typeof m.pid === 'number' ? m.pid : Number(n.replace(/\.json$/, ''));
      out.push({ pid, agent: m.agent ?? 'unknown', cwd: m.cwd ?? '', alive: pidAlive(pid), since: m.since });
    } catch {
      /* skip corrupt marker */
    }
  }
  return out;
}

export function pruneStaleClients(port: number, env: NodeJS.ProcessEnv = process.env): number {
  let n = 0;
  for (const c of listClients(port, env)) {
    if (!c.alive) {
      unregisterClient(port, c.pid, env);
      n++;
    }
  }
  return n;
}
