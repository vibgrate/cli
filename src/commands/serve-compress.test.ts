import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const wrapMock = vi.fn();
vi.mock('../wrap/wrap.js', () => ({ wrap: (...args: unknown[]) => wrapMock(...args) }));
vi.mock('../proxy/lifecycle.js', () => ({
  ensureProxyRunning: vi.fn(),
  registerClient: vi.fn(),
  unregisterClient: vi.fn(),
  readProxyState: () => null,
  pidAlive: () => false,
  probeProxy: async () => ({ ok: false }),
  stopProxy: async () => ({ stopped: false }),
  listClients: () => [],
  pruneStaleClients: () => {},
}));

import { registerServe } from './serve.js';
import { KNOWN_COMMANDS } from '../cli.js';

/** Parse `argv` through a fresh program with `vg serve` registered; capture stdout. */
async function run(argv: string[]): Promise<{ stdout: string; error?: Error }> {
  const program = new Command();
  program.exitOverride();
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
  registerServe(program);
  return program.commands.find((x) => x.name() === 'serve') as Command;
};

describe('vg serve — the compression half', () => {
  const savedExit = process.exitCode;
  beforeEach(() => {
    wrapMock.mockReset();
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
    // Same guard as `vg show chart`: the capability must not reappear as a
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

  it('runs one agent session through the listener and passes everything after `--` on', async () => {
    wrapMock.mockResolvedValue({ exitCode: 0, proxyUrl: 'http://127.0.0.1:8790', applied: [] });
    const r = await run(['serve', '--compress', '--compress-port', '8790', '--profile', 'aggressive', '--', 'claude', '--model', 'x', '-p', 'hi']);
    expect(r.error).toBeUndefined();
    expect(wrapMock).toHaveBeenCalledTimes(1);
    const [agent, opts] = wrapMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(agent).toBe('claude');
    expect(opts).toMatchObject({ args: ['--model', 'x', '-p', 'hi'], port: 8790, profile: 'aggressive' });
  });

  it('propagates the agent’s exit code', async () => {
    wrapMock.mockResolvedValue({ exitCode: 3, proxyUrl: 'u', applied: [] });
    await run(['serve', '--compress', '--', 'codex']);
    expect(process.exitCode).toBe(3);
  });

  it('rejects an agent it cannot route, naming the ones it can', async () => {
    const r = await run(['serve', '--compress', '--', 'not-an-agent']);
    expect(r.error?.message).toMatch(/cannot run "not-an-agent"/);
    expect(r.error?.message).toMatch(/claude/);
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it('points at the right form when an agent is named without --compress', async () => {
    const r = await run(['serve', '--', 'claude']);
    expect(r.error?.message).toContain('--compress');
    expect(r.error?.message).toContain('vg serve --compress -- claude');
    expect(wrapMock).not.toHaveBeenCalled();
  });

  it('validates the port before starting anything', async () => {
    const r = await run(['serve', '--compress', '--compress-port', '70000', '--', 'claude']);
    expect(r.error?.message).toMatch(/--compress-port must be 1\.\.65535/);
    expect(wrapMock).not.toHaveBeenCalled();
  });
});
