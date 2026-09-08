import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('../proxy/lifecycle.js', () => ({
  ensureProxyRunning: vi.fn(),
  registerClient: vi.fn(),
  unregisterClient: vi.fn(),
}));

import { wrap, quietCliEnv, healDeadMarker, proxyTimeoutMs, type SpawnFn } from './wrap.js';
import { unwrap } from './unwrap.js';
import { AGENTS, applyProxyToAgent } from './agents.js';
import { wrapStatus, wrapDiagnostics } from './status.js';
import { readMarker, readOwners } from './edit.js';
import { readCaptureFile } from './capture.js';
import { wrapMarkerPath } from '../compress/paths.js';
import type { EnsureProxyFn } from './types.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-wrap-'));

/** A fake child: records what was spawned, lets the test drive exit/signals. */
class FakeChild extends EventEmitter {
  killed: NodeJS.Signals[] = [];
  kill(sig?: NodeJS.Signals): boolean {
    this.killed.push(sig ?? 'SIGTERM');
    return true;
  }
}

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  child: FakeChild;
}

function fakeSpawn(onSpawn?: (s: Spawned) => void): { spawn: SpawnFn; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    const s = { command, args, env: options.env as NodeJS.ProcessEnv, cwd: options.cwd as string | undefined, child };
    calls.push(s);
    onSpawn?.(s);
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

function harness(overrides: { ensureUrl?: string; started?: boolean } = {}) {
  const home = tmp();
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: '/bin', VG_CONTEXT_DIR: path.join(home, 'ctx') };
  const ensureCalls: unknown[] = [];
  const ensureProxy: EnsureProxyFn = async (o) => {
    ensureCalls.push(o);
    return { url: overrides.ensureUrl ?? `http://127.0.0.1:${o.port ?? 8787}`, port: o.port ?? 8787, pid: 4242, started: overrides.started ?? true };
  };
  const registry: Array<[string, number, unknown]> = [];
  const clients = {
    register: (port: number, client: { pid: number; agent: string; cwd: string }) => {
      registry.push(['register', port, client]);
      return '/x';
    },
    unregister: (port: number, pid: number) => {
      registry.push(['unregister', port, pid]);
    },
  };
  const lines: string[] = [];
  const signals = new EventEmitter();
  return { home, cwd, env, ensureProxy, ensureCalls, clients, registry, lines, log: (l: string) => lines.push(l), signals };
}

describe('wrap()', () => {
  it('spawns the agent with the routing env, inherits stdio, propagates the exit code, registers/unregisters the client', async () => {
    const h = harness();
    const { spawn, calls } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 3, null)));
    const r = await wrap('aider', {
      args: ['--model', 'gpt-5'],
      ...h,
      spawn,
      which: (b) => (b === 'aider' ? '/usr/bin/aider' : null),
      pid: 777,
      isAlive: () => true,
      portAlive: async () => false,
    });
    expect(r.exitCode).toBe(3);
    expect(r.proxyUrl).toBe('http://127.0.0.1:8787');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/bin/aider');
    expect(calls[0]!.args).toEqual(['--model', 'gpt-5']);
    expect(calls[0]!.cwd).toBe(h.cwd);
    const env = calls[0]!.env;
    expect(env.OPENAI_API_BASE).toBe('http://127.0.0.1:8787/v1');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(env.VG_WRAP_ACTIVE).toBe('1');
    expect(env.VG_PROXY_URL).toBe('http://127.0.0.1:8787');
    expect(env.VG_PROXY_PROJECT).toBe('proj');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.PYTEST_ADDOPTS).toBe('-q');
    expect(env.HOME).toBe(h.home);
    expect(h.registry).toEqual([
      ['register', 8787, { pid: 777, agent: 'aider', cwd: h.cwd }],
      ['unregister', 8787, 777],
    ]);
    expect(h.ensureCalls).toHaveLength(1);
    expect(h.ensureCalls[0]).toMatchObject({ port: 8787, host: '127.0.0.1', timeoutMs: 15000, spawnArgs: [], detached: true });
    expect(h.lines.join('\n')).toContain('vg · compressing Aider');
    expect(h.lines.join('\n')).toContain('(started)');
    expect(r.applied.filter((a) => a.kind === 'env').map((a) => (a as { name: string }).name).sort()).toEqual(['ANTHROPIC_BASE_URL', 'OPENAI_API_BASE']);
  });

  it('exit by signal → 128+signum; SIGTERM/SIGHUP are forwarded, SIGINT is not', async () => {
    const h = harness();
    let spawned: Spawned | undefined;
    const { spawn } = fakeSpawn((s) => {
      spawned = s;
    });
    const p = wrap('aider', { args: [], ...h, spawn, which: () => '/usr/bin/aider', isAlive: () => true, quiet: true });
    await new Promise((r) => setImmediate(r));
    h.signals.emit('SIGINT');
    h.signals.emit('SIGHUP');
    h.signals.emit('SIGTERM');
    expect(spawned!.child.killed).toEqual(['SIGHUP', 'SIGTERM']);
    spawned!.child.emit('exit', null, 'SIGTERM');
    const r = await p;
    expect(r.exitCode).toBe(128 + 15);
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('missing binary → exit 1 with an install hint; env-only agents need no config file', async () => {
    const h = harness();
    await expect(wrap('claude', { args: [], ...h, which: () => null, isAlive: () => true })).rejects.toThrow(/Claude Code not found on PATH.*npm install -g @anthropic-ai\/claude-code/);
    expect(h.ensureCalls).toHaveLength(0);
  });

  it('Claude: writes settings.local.json for the session and restores it byte-identically on exit', async () => {
    const h = harness();
    const settings = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    const original = '{"permissions":{"allow":["Bash(ls)"]}}\n';
    fs.writeFileSync(settings, original);
    let during = '';
    const { spawn, calls } = fakeSpawn((s) => {
      during = fs.readFileSync(settings, 'utf8');
      setImmediate(() => s.child.emit('exit', 0, null));
    });
    const r = await wrap('claude', { args: ['-p', 'hi'], ...h, spawn, which: () => '/usr/bin/claude', pid: 501, isAlive: (p) => p === 501, portAlive: async () => false });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(during)).toEqual({ permissions: { allow: ['Bash(ls)'] }, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } });
    expect(fs.readFileSync(settings, 'utf8')).toBe(original);
    expect(readMarker(settings)).toBeNull();
    expect(readOwners(settings)).toEqual({});
    const env = calls[0]!.env;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Vg-Project: proj');
    expect(calls[0]!.args).toEqual(['-p', 'hi']);
    const files = r.applied.filter((a) => a.kind === 'file') as Array<{ status: string; file: string }>;
    expect(files.map((f) => f.status)).toEqual(['applied', 'reverted']);
    expect(files[0]!.file).toBe(settings);
    expect(h.lines.join('\n')).toContain('.claude/settings.local.json');
  });

  it('config is reverted even when the child fails to spawn', async () => {
    const h = harness();
    const settings = path.join(h.cwd, '.claude', 'settings.local.json');
    const spawn: SpawnFn = () => {
      const child = new FakeChild();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as unknown as ChildProcess;
    };
    await expect(wrap('claude', { args: [], ...h, spawn, which: () => '/usr/bin/claude', pid: 502, isAlive: (p) => p === 502, portAlive: async () => false })).rejects.toThrow('ENOENT');
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(wrapMarkerPath(settings))).toBe(false);
    expect(h.registry.map((r) => r[0])).toEqual(['register', 'unregister']);
  });

  it('Codex: session-local --config overrides are prepended; config.toml is untouched', async () => {
    const h = harness();
    const codexHome = path.join(h.home, '.codex');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
    const { spawn, calls } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    await wrap('codex', { args: ['exec', 'hi'], ...h, spawn, which: () => '/usr/bin/codex', isAlive: () => true, quiet: true });
    expect(calls[0]!.args).toEqual(['--config', 'openai_base_url="http://127.0.0.1:8787/v1"', 'exec', 'hi']);
    expect(calls[0]!.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:8787/v1');
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
  });

  it('rebuilds URL-derived env and args when the proxy lands on a fallback port', async () => {
    const h = harness({ ensureUrl: 'http://127.0.0.1:8790' });
    const { spawn, calls } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    const r = await wrap('codex', { args: [], ...h, spawn, which: () => '/usr/bin/codex', isAlive: () => true, quiet: true });
    expect(r.proxyUrl).toBe('http://127.0.0.1:8790');
    expect(calls[0]!.args).toEqual(['--config', 'openai_base_url="http://127.0.0.1:8790/v1"']);
    expect(calls[0]!.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:8790/v1');
  });

  it('--dry-run prints the plan and changes nothing', async () => {
    const h = harness();
    const { spawn, calls } = fakeSpawn();
    const r = await wrap('claude', { args: ['--model', 'x'], ...h, spawn, which: () => '/usr/bin/claude', dryRun: true, isAlive: () => true });
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(h.ensureCalls).toHaveLength(0);
    expect(h.registry).toHaveLength(0);
    expect(fs.existsSync(path.join(h.cwd, '.claude'))).toBe(false);
    expect(r.plan).toMatchObject({ agent: 'claude', binary: '/usr/bin/claude', watcher: false, proxyUrl: 'http://127.0.0.1:8787', args: ['--model', 'x'], configFile: path.join(h.cwd, '.claude', 'settings.local.json') });
    expect(r.plan!.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    const text = h.lines.join('\n');
    expect(text).toContain('--dry-run');
    expect(text).toContain('env      ANTHROPIC_BASE_URL=http://127.0.0.1:8787');
    expect(text).toContain('config   .claude/settings.local.json (settings-json)');
  });

  it('quiet mode (flag or VG_WRAP_QUIET) prints no banner', async () => {
    const h = harness();
    h.env.VG_WRAP_QUIET = '1';
    const { spawn } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    await wrap('aider', { args: [], ...h, spawn, which: () => '/x', isAlive: () => true });
    expect(h.lines).toEqual([]);
  });

  it('watcher mode for GUI-configured agents: prints setup notes, waits for Ctrl+C', async () => {
    const h = harness();
    const { spawn, calls } = fakeSpawn();
    const p = wrap('cline', { args: [], ...h, spawn, which: () => null, isAlive: () => true });
    await new Promise((r) => setImmediate(r));
    expect(h.lines.join('\n')).toContain('Cline: Settings');
    expect(h.lines.join('\n')).toContain('http://127.0.0.1:8787/v1');
    expect(h.lines.join('\n')).toContain('Press Ctrl+C');
    h.signals.emit('SIGINT');
    const r = await p;
    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(h.registry.map((x) => x[0])).toEqual(['register', 'unregister']);
  });

  it('VG_PROXY_URL / --no-proxy skip the proxy start; --profile and agent upstreams become proxy args', async () => {
    const h = harness();
    h.env.VG_PROXY_URL = 'http://127.0.0.1:9000';
    const { spawn, calls } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    await wrap('grok', { args: [], ...h, spawn, which: () => '/g', isAlive: () => true, quiet: true });
    expect(h.ensureCalls).toHaveLength(0);
    expect(calls[0]!.env.GROK_MODELS_BASE_URL).toBe('http://127.0.0.1:9000/v1');
    delete h.env.VG_PROXY_URL;
    h.env.VG_WRAP_PROXY_TIMEOUT = '2.5';
    await wrap('grok', { args: [], ...h, spawn, which: () => '/g', isAlive: () => true, quiet: true, profile: 'aggressive', port: 9100 });
    expect(h.ensureCalls[0]).toMatchObject({ port: 9100, timeoutMs: 2500, spawnArgs: ['--openai-url', 'https://api.x.ai', '--profile', 'aggressive'] });
    expect((h.ensureCalls[0] as { env: NodeJS.ProcessEnv }).env.VG_PROXY_AGENT_TYPE).toBe('grok');
    await wrap('grok', { args: [], ...h, spawn, which: () => '/g', isAlive: () => true, quiet: true, noProxy: true });
    expect(h.ensureCalls).toHaveLength(1);
  });

  it('--capture writes session records (0600) and hands the file to the proxy', async () => {
    const h = harness();
    const file = path.join(h.home, 'cap.jsonl');
    const { spawn } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 2, null)));
    await wrap('aider', { args: [], ...h, spawn, which: () => '/x', isAlive: () => true, quiet: true, capture: file, now: () => 5 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const recs = readCaptureFile(file);
    expect(recs).toEqual([
      { kind: 'session', event: 'start', ts: 5, agent: 'aider', proxyUrl: 'http://127.0.0.1:8787', cwd: h.cwd },
      { kind: 'session', event: 'end', ts: 5, agent: 'aider', proxyUrl: 'http://127.0.0.1:8787', cwd: h.cwd, exitCode: 2 },
    ]);
    expect((h.ensureCalls[0] as { env: NodeJS.ProcessEnv }).env.VG_WRAP_CAPTURE_FILE).toBe(file);
  });

  it('Copilot subscription lane: device-flow login + token exchange with a fake fetch; bearer never printed', async () => {
    const h = harness();
    const seen: string[] = [];
    let polls = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/login/device/code')) return json({ verification_uri: 'https://github.com/login/device', user_code: 'ABCD-1234', device_code: 'dev', interval: 1, expires_in: 900 });
      if (url.endsWith('/login/oauth/access_token')) return ++polls < 2 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_oauthtoken' });
      if (url.endsWith('/copilot_internal/v2/token')) {
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer gho_oauthtoken');
        return json({ token: 'tid=apitoken;exp=1', expires_at: 4_000_000_000, endpoints: { api: 'https://api.business.githubcopilot.com' } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const { spawn, calls } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    const r = await wrap('copilot', { args: ['--model', 'auto', '-p', 'x'], ...h, spawn, which: () => '/c', isAlive: () => true, login: true, subscription: true, fetch: fetchFn, now: () => 1_000_000, exec: null });
    expect(r.exitCode).toBe(0);
    expect(seen[0]).toBe('POST https://github.com/login/device/code');
    const env = calls[0]!.env;
    expect(env.COPILOT_PROVIDER_BEARER_TOKEN).toBe('tid=apitoken;exp=1');
    expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://127.0.0.1:8787/v1');
    expect(env.GITHUB_COPILOT_USE_TOKEN_EXCHANGE).toBe('false');
    expect(calls[0]!.args).toEqual(['-p', 'x']);
    expect(h.ensureCalls[0]).toMatchObject({ spawnArgs: ['--openai-url', 'https://api.githubcopilot.com'] });
    const text = h.lines.join('\n');
    expect(text).toContain('Code: ABCD-1234');
    expect(text).not.toContain('gho_oauthtoken');
    expect(text).not.toContain('apitoken');
    expect(text).toContain('COPILOT_PROVIDER_BEARER_TOKEN=<redacted>');
    expect(text).toContain('GITHUB_COPILOT_USE_TOKEN_EXCHANGE=false');
    expect(fs.statSync(path.join(h.env.VG_CONTEXT_DIR!, 'copilot_auth.json')).mode & 0o777).toBe(0o600);
  });

  it('heals a dead session\'s marker before claiming the slot (port liveness is authoritative)', async () => {
    const h = harness();
    const settings = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    // Session A (pid 900) wraps and "crashes" without reverting.
    const { spawn: spawnA } = fakeSpawn((s) => setImmediate(() => s.child.emit('exit', 0, null)));
    const keep = { ...h, clients: h.clients };
    const revertless = wrap('claude', { args: [], ...keep, spawn: spawnA, which: () => '/c', pid: 900, isAlive: () => true, portAlive: async () => false, quiet: true, signals: new EventEmitter() });
    await revertless;
    // Simulate the crash by re-planting A's marker state.
    fs.writeFileSync(settings, '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8787"}}\n');
    fs.writeFileSync(wrapMarkerPath(settings), JSON.stringify({ format: 1, agent: 'claude', url: 'http://127.0.0.1:8787', version: 't', appliedAt: 1, pid: 900, port: 8787, file: settings, created: false, createdBackup: false, fields: { 'env.ANTHROPIC_BASE_URL': { present: true, value: 'https://api.anthropic.com' } } }));
    // Live port → never cleared.
    expect(await healDeadMarker(settings, 'claude', { agent: 'claude', isAlive: () => false }, async () => true)).toBe(false);
    expect(readMarker(settings)?.pid).toBe(900);
    // Dead port → restored even though the pid looks alive (recycled).
    expect(await healDeadMarker(settings, 'claude', { agent: 'claude', isAlive: () => true }, async () => false)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(readMarker(settings)).toBeNull();
  });

  it('two concurrent Claude sessions in one project never unwrap each other', async () => {
    const h = harness();
    const settings = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    const live = new Set([1001, 1002]);
    const isAlive = (p: number): boolean => live.has(p);
    const childA = { current: undefined as FakeChild | undefined };
    const childB = { current: undefined as FakeChild | undefined };
    const spawnA: SpawnFn = () => (childA.current = new FakeChild()) as unknown as ChildProcess;
    const spawnB: SpawnFn = () => (childB.current = new FakeChild()) as unknown as ChildProcess;
    const common = { args: [] as string[], ...h, which: () => '/c', portAlive: async () => true, quiet: true };
    const pA = wrap('claude', { ...common, spawn: spawnA, pid: 1001, isAlive, signals: new EventEmitter() });
    await new Promise((r) => setImmediate(r));
    const pB = wrap('claude', { ...common, spawn: spawnB, pid: 1002, isAlive, signals: new EventEmitter() });
    await new Promise((r) => setImmediate(r));
    expect(readOwners(settings)['env.ANTHROPIC_BASE_URL']!.holders.map((x) => x.pid)).toEqual([1001, 1002]);
    childA.current!.emit('exit', 0, null);
    const rA = await pA;
    live.delete(1001);
    expect((rA.applied.at(-1) as { status: string; reason?: string }).status).toBe('skipped');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    childB.current!.emit('exit', 0, null);
    await pB;
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
  });
});

describe('helpers', () => {
  it('quietCliEnv only fills absent keys and augments PYTEST_ADDOPTS', () => {
    expect(quietCliEnv({ GIT_PAGER: 'less', PYTEST_ADDOPTS: '-x' })).toEqual({ PIP_QUIET: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_progress: 'false', PYTEST_ADDOPTS: '-x -q' });
    expect(quietCliEnv({ PYTEST_ADDOPTS: '-q -x' }).PYTEST_ADDOPTS).toBeUndefined();
  });

  it('proxy timeout knob: default 15 s, clamped', () => {
    expect(proxyTimeoutMs({})).toBe(15_000);
    expect(proxyTimeoutMs({ VG_WRAP_PROXY_TIMEOUT: '0' })).toBe(1000);
    expect(proxyTimeoutMs({ VG_WRAP_PROXY_TIMEOUT: 'nope' })).toBe(15_000);
  });
});

describe('unwrap() + wrapStatus()', () => {
  it('reverts markers across session and durable files, skips live holders unless forced, reports env-only agents', async () => {
    const h = harness();
    const settings = path.join(h.cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, '{"env":{"A":"1"}}\n');
    const child = { current: undefined as FakeChild | undefined };
    const spawn: SpawnFn = () => (child.current = new FakeChild()) as unknown as ChildProcess;
    const live = new Set([2001]);
    const p = wrap('claude', { args: [], ...h, spawn, which: () => '/c', pid: 2001, isAlive: (x) => live.has(x), portAlive: async () => true, quiet: true });
    await new Promise((r) => setImmediate(r));
    const firstChild = child.current!;

    const rows = wrapStatus({ cwd: h.cwd, home: h.home, env: h.env, isAlive: (x) => live.has(x), agents: ['claude', 'aider'] });
    expect(rows).toEqual([
      { agent: 'claude', wrapped: true, file: settings, owner: '2001', since: expect.any(Number), url: 'http://127.0.0.1:8787', stale: false },
      { agent: 'aider', wrapped: false },
    ]);
    const diag = wrapDiagnostics({ ...h.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' }, { cwd: h.cwd, home: h.home, isAlive: (x) => live.has(x), agents: ['claude'] });
    expect(diag.map((d) => [d.name, d.status])).toEqual([
      ['shell env', 'pass'],
      ['routing claude', 'pass'],
    ]);

    // Live holder: skipped without --force.
    const skipped = unwrap('claude', { cwd: h.cwd, home: h.home, env: h.env, isAlive: (x) => live.has(x), pid: 9999 });
    expect(skipped.reverted).toEqual([]);
    expect(skipped.skipped[0]).toMatch(/still in use by pid 2001/);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');

    // Dry run lists without touching.
    const dry = unwrap('all', { cwd: h.cwd, home: h.home, env: h.env, isAlive: (x) => live.has(x), dryRun: true });
    expect(dry.reverted).toEqual([{ kind: 'file', agent: 'claude', file: settings, method: 'settings-json', status: 'reverted', fields: ['env.ANTHROPIC_BASE_URL'], reason: 'dry-run' }]);

    // Forced: restored.
    const forced = unwrap('claude', { cwd: h.cwd, home: h.home, env: h.env, isAlive: (x) => live.has(x), pid: 9999, force: true });
    expect(forced.reverted).toHaveLength(1);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"env":{"A":"1"}}\n');
    expect(unwrap('aider', { cwd: h.cwd, home: h.home, env: h.env }).skipped[0]).toMatch(/environment only/);

    // Same-directory conflict: a durable project install covers the session; a foreign session marker refuses.
    const projectSettings = path.join(h.cwd, '.claude', 'settings.json');
    fs.writeFileSync(projectSettings, '{}\n');
    applyProxyToAgent('claude', 'http://127.0.0.1:8787', { home: h.home, cwd: h.cwd, env: h.env, scope: 'project', ctx: { agent: 'claude', isAlive: () => false } });
    expect(readMarker(projectSettings)?.durable).toBe(true);
    expect(readMarker(settings)).toBeNull();
    const cover = wrap('claude', { args: [], ...h, spawn, which: () => '/c', pid: 2002, isAlive: () => true, portAlive: async () => true, log: h.log });
    await new Promise((r) => setImmediate(r));
    child.current!.emit('exit', 0, null);
    await cover;
    expect(h.lines.join('\n')).toContain('durable routing already installed');
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"env":{"A":"1"}}\n');
    expect(readMarker(projectSettings)?.durable).toBe(true);
    expect(() => AGENTS.claude.apply!(settings, 'u', { agent: 'codex', pid: 3 })).toThrow(/already wrapped durably/);
    expect(unwrap('claude', { cwd: h.cwd, home: h.home, env: h.env, isAlive: () => false }).reverted.map((r) => (r as { file: string }).file)).toEqual([projectSettings]);
    expect(fs.readFileSync(projectSettings, 'utf8')).toBe('{}\n');

    // Stale marker shows in status + doctor, and unwrap clears it.
    fs.writeFileSync(wrapMarkerPath(settings), JSON.stringify({ format: 1, agent: 'claude', url: 'u', version: 't', appliedAt: 7, pid: 424242, file: settings, created: false, createdBackup: false, fields: { 'env.ANTHROPIC_BASE_URL': { present: false } } }));
    const stale = wrapStatus({ cwd: h.cwd, home: h.home, env: h.env, isAlive: () => false, agents: ['claude'] })[0]!;
    expect(stale).toMatchObject({ wrapped: true, stale: true, owner: '424242', since: 7 });
    expect(wrapDiagnostics(h.env, { cwd: h.cwd, home: h.home, isAlive: () => false, agents: ['claude'] }).find((d) => d.name === 'routing claude')).toMatchObject({ status: 'warn', hint: 'run `vg uninstall claude`' });
    expect(unwrap('claude', { cwd: h.cwd, home: h.home, env: h.env, isAlive: () => false }).reverted).toHaveLength(1);
    expect(readMarker(settings)).toBeNull();

    firstChild.emit('exit', 0, null);
    await p;
  });

  it('doctor flags auth conflicts and foreign local base URLs', () => {
    const d = wrapDiagnostics({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_BASE_URL: 'http://localhost:11434/v1' }, { cwd: tmp(), home: tmp(), agents: [] });
    expect(d.map((x) => [x.name, x.status])).toEqual([
      ['shell env', 'warn'],
      ['claude auth', 'fail'],
    ]);
  });
});
