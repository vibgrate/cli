import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const wrapMock = vi.fn();
const ensureProxyRunning = vi.fn();
const startProxy = vi.fn();
const stopProxy = vi.fn(async (_port: number) => ({ stopped: false }));
vi.mock('../wrap/wrap.js', () => ({ wrap: (...args: unknown[]) => wrapMock(...args) }));
vi.mock('../proxy/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proxy/lifecycle.js')>();
  return {
    ...actual,
    ensureProxyRunning: (...args: unknown[]) => ensureProxyRunning(...args),
    registerClient: vi.fn(),
    unregisterClient: vi.fn(),
    readProxyState: () => null,
    pidAlive: () => false,
    probeProxy: async () => ({ ok: false }),
    stopProxy: (...args: unknown[]) => stopProxy(...(args as [number])),
    listClients: () => [],
    pruneStaleClients: () => {},
  };
});
vi.mock('../proxy/server.js', () => ({ startProxy: (...args: unknown[]) => startProxy(...args) }));

import { registerServe } from './serve.js';
import { KNOWN_COMMANDS } from '../cli.js';
import { daemonArgv } from '../proxy/lifecycle.js';

/** Parse `argv` through a fresh program with `vg serve` registered; capture stdout. */
async function run(argv: string[]): Promise<{ stdout: string; error?: Error }> {
  const program = new Command();
  program.exitOverride();
  program.enablePositionalOptions(); // as buildProgram() does — serve relies on it for pass-through
  registerServe(program);
  let stdout = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return { stdout };
  } catch (err) {
    return { stdout, error: err as Error };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const serveCommand = (): Command => {
  const program = new Command();
  program.enablePositionalOptions();
  registerServe(program);
  return program.commands.find((x) => x.name() === 'serve') as Command;
};

describe('vg serve — the compression half', () => {
  const savedExit = process.exitCode;
  beforeEach(() => {
    wrapMock.mockReset();
    ensureProxyRunning.mockReset();
    startProxy.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = savedExit;
  });

  it('nests every compression subcommand under serve rather than adding a verb', () => {
    // FEATURE-DESIGN-PRINCIPLES P1: the everyday surface is a budget. What used
    // to be `vg proxy` / `vg compress` / `vg retrieve` / `vg memory` all hangs
    // off the one command that owns the local runtime.
    const names = serveCommand().commands.map((x) => x.name()).sort();
    expect(names).toEqual(['compress', 'config', 'memory', 'retrieve', 'status', 'stop']);
  });

  it('adds nothing to the everyday surface', () => {
    // Same guard as `vg show arch`: the capability must not reappear as a
    // top-level verb, and the verbs it hangs off must still be there.
    for (const verb of ['proxy', 'wrap', 'unwrap', 'dashboard', 'perf', 'compress', 'retrieve', 'memory', 'learn']) {
      expect(KNOWN_COMMANDS.has(verb), verb).toBe(false);
    }
    for (const verb of ['serve', 'install', 'uninstall', 'savings', 'show', 'code', 'doctor']) {
      expect(KNOWN_COMMANDS.has(verb), verb).toBe(true);
    }
  });

  it('keeps the settings verbs under `serve config`, not at the top of serve', () => {
    const config = serveCommand().commands.find((x) => x.name() === 'config') as Command;
    expect(config.commands.map((x) => x.name()).sort()).toEqual(['set', 'unset']);
  });

  it('advertises --compress as one switch, not a family of proxy flags', () => {
    const flags = serveCommand().options.map((o) => o.long);
    expect(flags).toContain('--compress');
    expect(flags).toContain('--compress-port');
    expect(flags).toContain('--compress-only');
    expect(flags).toContain('--profile');
    // The ~130 VG_* knobs are configured through settings.json, not by growing
    // the flag list until it is its own manual.
    expect(flags).not.toContain('--token');
    expect(flags).not.toContain('--budget');
    expect(flags).not.toContain('--anthropic-url');
  });

  it('does not spell the map-less mode `--no-graph`, which the global `--graph <file>` owns', () => {
    // Commander would read `--no-graph` as "unset the map path", silently
    // colliding with the global option instead of meaning what it says.
    const serve = serveCommand();
    expect(serve.options.map((o) => o.long)).not.toContain('--no-graph');
    expect(serve.options.find((o) => o.long === '--graph')?.required).not.toBe(false);
  });

  it('runs one agent session through the listener; everything after the agent name is the agent\'s, no `--` needed', async () => {
    wrapMock.mockResolvedValue({ exitCode: 0, proxyUrl: 'http://127.0.0.1:8790', applied: [] });
    const r = await run(['serve', '--compress', '--compress-port', '8790', '--profile', 'aggressive', 'claude', '--model', 'x', '-p', 'hi']);
    expect(r.error).toBeUndefined();
    expect(wrapMock).toHaveBeenCalledTimes(1);
    const [agent, opts] = wrapMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(agent).toBe('claude');
    expect(opts).toMatchObject({ args: ['--model', 'x', '-p', 'hi'], port: 8790, profile: 'aggressive' });
  });

  it('still accepts the explicit `--` separator', async () => {
    wrapMock.mockResolvedValue({ exitCode: 0, proxyUrl: 'u', applied: [] });
    const r = await run(['serve', '--compress', '--', 'claude', '--model', 'x']);
    expect(r.error).toBeUndefined();
    const [agent, opts] = wrapMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(agent).toBe('claude');
    expect(opts).toMatchObject({ args: ['--model', 'x'] });
  });

  it('propagates the agent’s exit code', async () => {
    wrapMock.mockResolvedValue({ exitCode: 3, proxyUrl: 'u', applied: [] });
    await run(['serve', '--compress', 'codex']);
    expect(process.exitCode).toBe(3);
  });

  it('rejects an agent it cannot route, naming the ones it can', async () => {
    const r = await run(['serve', '--compress', 'not-an-agent']);
    expect(r.error?.message).toMatch(/cannot run "not-an-agent"/);
    expect(r.error?.message).toMatch(/claude/);
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it('points at the right form when an agent is named without --compress', async () => {
    const r = await run(['serve', 'claude']);
    expect(r.error?.message).toContain('--compress');
    expect(r.error?.message).toContain('vg serve --compress claude');
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it('`--background` ensures a detached listener and returns, reusing a healthy one', async () => {
    ensureProxyRunning.mockResolvedValue({ url: 'http://127.0.0.1:8787', port: 8787, pid: 9, started: true, state: {} });
    const r = await run(['serve', '--compress', '--background', '--profile', 'aggressive', '--json']);
    expect(r.error).toBeUndefined();
    expect(ensureProxyRunning).toHaveBeenCalledTimes(1);
    const call = ensureProxyRunning.mock.calls[0]![0] as { port: number; spawnArgs: string[]; detached: boolean };
    expect(call).toMatchObject({ port: 8787, spawnArgs: ['--profile', 'aggressive'], detached: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ url: 'http://127.0.0.1:8787', started: true, profile: 'aggressive' });
    // Nothing is served in the foreground — no MCP transport, no listener bound here.
    expect(startProxy).not.toHaveBeenCalled();
  });

  it('`--background` does not take an agent — the one-session form starts the listener itself', async () => {
    const r = await run(['serve', '--compress', '--background', 'claude']);
    expect(r.error?.message).toContain('vg serve --compress <agent>');
    expect(ensureProxyRunning).not.toHaveBeenCalled();
  });

  it('accepts the exact argv the lifecycle spawner starts the daemon with', async () => {
    // The spawner and the command it spawns are tested against each other:
    // the daemon used to be started as `vg proxy --background`, a verb that
    // was later retired, so every auto-start exited 5 before binding.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      startProxy.mockImplementation(async (_cfg: unknown, deps: { onClosed?: () => void }) => {
        setImmediate(() => deps.onClosed?.());
        return { url: 'http://127.0.0.1:8793', port: 8793, host: '127.0.0.1', pid: 1, startedAt: 0, close: async () => {}, stats: () => ({}), context: {} };
      });
      const r = await run(daemonArgv(8793, ['--profile', 'coding']));
      // No "unknown option" from commander; the listener was bound with the
      // requested port and profile, and the process exited once it closed.
      expect(r.error?.message).toBe('exit');
      expect(startProxy).toHaveBeenCalledTimes(1);
      expect((startProxy.mock.calls[0]![0] as { port: number; profile: string }).port).toBe(8793);
      expect((startProxy.mock.calls[0]![0] as { port: number; profile: string }).profile).toBe('coding');
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('`status` and `stop` take `--compress-port` (the parent serve\'s `--port` is MCP\'s)', async () => {
    stopProxy.mockClear();
    await run(['serve', 'stop', '--compress-port', '9001', '--json']);
    expect(stopProxy).toHaveBeenCalledWith(9001);
    const r = await run(['serve', 'status', '--compress-port', '9002', '--json']);
    expect(JSON.parse(r.stdout)).toMatchObject({ port: 9002, running: false });
  });

  it('keeps the daemon flag out of --help and the listing surface', () => {
    const serve = serveCommand();
    const daemon = serve.options.find((o) => o.long === '--compress-daemon');
    expect(daemon?.hidden).toBe(true);
    expect(serve.options.find((o) => o.long === '--background')?.hidden).not.toBe(true);
  });

  it('validates the port before starting anything', async () => {
    const r = await run(['serve', '--compress', '--compress-port', '70000', 'claude']);
    expect(r.error?.message).toMatch(/--compress-port must be 1\.\.65535/);
    expect(wrapMock).not.toHaveBeenCalled();
  });
});
