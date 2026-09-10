import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';

const applyProxyToAgent = vi.fn();
const unwrapMock = vi.fn();
const loginCopilot = vi.fn();
vi.mock('../wrap/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wrap/index.js')>();
  return {
    ...actual,
    applyProxyToAgent: (...args: unknown[]) => applyProxyToAgent(...args),
    unwrap: (...args: unknown[]) => unwrapMock(...args),
    loginCopilot: (...args: unknown[]) => loginCopilot(...args),
  };
});

const learnFromSessions = vi.fn();
vi.mock('../learn/run.js', () => ({ learnFromSessions: (...args: unknown[]) => learnFromSessions(...args) }));

const ensureBackgroundListener = vi.fn();
vi.mock('./serve-compress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serve-compress.js')>();
  return { ...actual, ensureBackgroundListener: (...args: unknown[]) => ensureBackgroundListener(...args) };
});

import { registerInstall, proxyUrlFor } from './install.js';

let repo: string;

async function run(argv: string[]): Promise<{ json: unknown; stdout: string; error?: Error }> {
  const program = new Command();
  program.exitOverride();
  registerInstall(program);
  let stdout = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync([...argv, '--cwd', repo, '--json'], { from: 'user' });
    let parsed: unknown = stdout;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      /* non-JSON output stays a string */
    }
    return { json: parsed, stdout };
  } catch (err) {
    return { json: undefined, stdout, error: err as Error };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('vg install — the compression and learning modes', () => {
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-install-'));
    applyProxyToAgent.mockReset();
    unwrapMock.mockReset();
    loginCopilot.mockReset();
    learnFromSessions.mockReset();
    ensureBackgroundListener.mockReset();
    ensureBackgroundListener.mockResolvedValue({ url: 'http://127.0.0.1:8787', port: 8787, started: true });
    delete process.env.VG_PROXY_URL;
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('routes an assistant through the local listener and reports the file it wrote', async () => {
    applyProxyToAgent.mockReturnValue({ file: '/home/u/.claude/settings.json', result: { changed: true, fields: ['env.ANTHROPIC_BASE_URL'] } });
    const r = await run(['install', 'claude', '--compress']);
    expect(r.error).toBeUndefined();
    const payload = r.json as { compress: Array<{ id: string; status: string; file: string; url: string }> };
    expect(payload.compress).toHaveLength(1);
    expect(payload.compress[0]).toMatchObject({ id: 'claude', status: 'written', file: '/home/u/.claude/settings.json' });
    expect(payload.compress[0].url).toMatch(/^http:\/\//);
  });

  it('starts (or reuses) the listener the routing points at, so one command is a working setup', async () => {
    applyProxyToAgent.mockReturnValue({ file: '/home/u/.codex/config.toml', result: { changed: true, fields: ['model_provider'] } });
    const r = await run(['install', 'codex', '--compress']);
    expect(r.error).toBeUndefined();
    expect(ensureBackgroundListener).toHaveBeenCalledTimes(1);
    expect((r.json as { listener: { url: string; started: boolean } }).listener).toEqual({ url: 'http://127.0.0.1:8787', started: true });
  });

  it('leaves a listener it does not own alone: an explicit URL or VG_PROXY_URL is someone else’s', async () => {
    applyProxyToAgent.mockReturnValue({ file: 'f', result: { changed: true, fields: [] } });
    await run(['install', 'codex', '--compress', 'http://10.0.0.5:9000']);
    process.env.VG_PROXY_URL = 'http://10.0.0.6:9000';
    await run(['install', 'codex', '--compress']);
    expect(ensureBackgroundListener).not.toHaveBeenCalled();
  });

  it('keeps the routing when the listener cannot be started, and says so', async () => {
    applyProxyToAgent.mockReturnValue({ file: 'f', result: { changed: true, fields: [] } });
    ensureBackgroundListener.mockRejectedValue(new Error('port 8787 is in use by something that is not a vg compression listener'));
    const r = await run(['install', 'codex', '--compress']);
    expect(r.error).toBeUndefined();
    const payload = r.json as { compress: Array<{ status: string }>; listener: { error: string } };
    expect(payload.compress[0].status).toBe('written');
    expect(payload.listener.error).toContain('port 8787 is in use');
  });

  it('gives Claude Code a SessionStart hook that restarts the listener, and uninstall removes it', async () => {
    applyProxyToAgent.mockReturnValue({ file: path.join(repo, '.claude', 'settings.json'), result: { changed: true, fields: ['env.ANTHROPIC_BASE_URL'] } });
    const r = await run(['install', 'claude', '--compress']);
    expect(r.error).toBeUndefined();
    const hook = (r.json as { sessionStartHook: { status: string; note?: string } }).sessionStartHook;
    // The hook needs `vg` on PATH; under the test runner the launch is `npx`,
    // so the skip is reported rather than a hook silently written.
    if (hook.status === 'written') {
      const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
      expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toContain('serve --compress --background');
      unwrapMock.mockReturnValue({ reverted: [], skipped: [] });
      await run(['uninstall', 'claude']);
      const after = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')) as { hooks?: unknown };
      expect(after.hooks).toBeUndefined();
    } else {
      expect(hook.status).toBe('skipped');
      expect(hook.note).toContain('PATH');
    }
  });

  it('never writes the SessionStart hook for a user-scope routing (it lives in the project file)', async () => {
    applyProxyToAgent.mockReturnValue({ file: '/home/u/.claude/settings.json', result: { changed: true, fields: [] } });
    const r = await run(['install', 'claude', '--compress', '--compress-scope', 'user']);
    expect((r.json as { sessionStartHook: unknown }).sessionStartHook).toBeNull();
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.json'))).toBe(false);
  });

  it('routes the agents only the routing registry knows (cline, continue, goose, …) instead of "unknown assistant"', async () => {
    applyProxyToAgent.mockReturnValue({ file: '/home/u/.continue/config.yaml', result: { changed: true, fields: ['models[0].apiBase'] } });
    const r = await run(['install', 'continue', '--compress']);
    expect(r.error).toBeUndefined();
    const payload = r.json as { results: unknown[]; compress: Array<{ id: string; status: string }> };
    expect(payload.results).toEqual([]);
    expect(payload.compress[0]).toMatchObject({ id: 'continue', status: 'written' });
    expect((applyProxyToAgent.mock.calls[0] as [string])[0]).toBe('continue');
    // Without --compress the same id is still not an assistant vg installs into.
    const plain = await run(['install', 'continue']);
    expect(plain.error?.message).toMatch(/unknown assistant "continue"/);
    // And uninstall reverts its routing without demanding an assistant entry.
    unwrapMock.mockReturnValue({ reverted: [{ kind: 'file', file: '/home/u/.continue/config.yaml', fields: [] }], skipped: [] });
    const un = await run(['uninstall', 'continue']);
    expect(un.error).toBeUndefined();
    expect((un.json as { routing: Array<{ id: string; files: string[] }> }).routing[0]).toMatchObject({ id: 'continue', files: ['/home/u/.continue/config.yaml'] });
  });

  it('writes nothing for compression unless --compress is asked for', async () => {
    await run(['install', 'claude']);
    expect(applyProxyToAgent).not.toHaveBeenCalled();
  });

  it('honours --compress-scope and rejects anything else', async () => {
    applyProxyToAgent.mockReturnValue({ file: 'f', result: { changed: true, fields: [] } });
    await run(['install', 'claude', '--compress', '--compress-scope', 'user']);
    expect((applyProxyToAgent.mock.calls[0] as [string, string, { scope: string }])[2]).toMatchObject({ scope: 'user' });
    const bad = await run(['install', 'claude', '--compress', '--compress-scope', 'sideways']);
    expect(bad.error?.message).toMatch(/--compress-scope must be project or user/);
  });

  it('explains, rather than silently skipping, an assistant with no base-URL config', async () => {
    applyProxyToAgent.mockReturnValue(null);
    const r = await run(['install', 'claude', '--compress']);
    const payload = r.json as { compress: Array<{ status: string; note: string }> };
    expect(payload.compress[0].status).toBe('unsupported');
    // The fallback it names is the per-session form, not a verb that no longer exists.
    expect(payload.compress[0].note).toContain('vg serve --compress claude');
  });

  it('never leaves a failed routing looking like a success', async () => {
    applyProxyToAgent.mockImplementation(() => {
      throw new Error('permission denied');
    });
    const r = await run(['install', 'claude', '--compress']);
    const payload = r.json as { compress: Array<{ status: string; note: string }> };
    expect(payload.compress[0]).toMatchObject({ status: 'failed' });
    expect(payload.compress[0].note).toContain('permission denied');
  });

  it('`vg uninstall` is the one revert verb — it restores the routing too', async () => {
    unwrapMock.mockReturnValue({ reverted: [{ kind: 'file', file: '.claude/settings.json', fields: ['env.ANTHROPIC_BASE_URL'] }], skipped: [] });
    const r = await run(['uninstall', 'claude']);
    expect(r.error).toBeUndefined();
    expect(unwrapMock).toHaveBeenCalledWith('claude', expect.objectContaining({ cwd: repo, force: false }));
    const payload = r.json as { results: Array<{ id: string; removed: string[] }> };
    expect(payload.results[0].removed.join(' ')).toContain('compression routing');
  });

  it('reports a config file another live session still holds instead of stealing it', async () => {
    unwrapMock.mockReturnValue({ reverted: [], skipped: ['.claude/settings.json still in use by pid 42'] });
    const r = await run(['uninstall', 'claude']);
    const payload = r.json as { routing: Array<{ skipped: string[] }> };
    expect(payload.routing[0].skipped[0]).toContain('still in use');
  });

  it('signs in before writing the routing, so a fresh machine needs one command', async () => {
    loginCopilot.mockResolvedValue({ file: '~/.vg/copilot.json', fingerprint: 'ab12', domain: 'github.com' });
    applyProxyToAgent.mockReturnValue({ file: 'f', result: { changed: true, fields: [] } });
    const r = await run(['install', 'copilot-cli', '--compress', '--login']);
    expect(r.error).toBeUndefined();
    expect(loginCopilot).toHaveBeenCalledTimes(1);
    expect(loginCopilot.mock.invocationCallOrder[0]).toBeLessThan(applyProxyToAgent.mock.invocationCallOrder[0]);
  });

  it('maps the assistant id onto the routing agent, including the ones spelled differently', async () => {
    applyProxyToAgent.mockReturnValue({ file: 'f', result: { changed: true, fields: [] } });
    // `vg install copilot-cli` routes the agent registered as `copilot`; before
    // this mapping existed it reported "no base-URL config vg can write".
    const r = await run(['install', 'copilot-cli', '--compress']);
    expect((r.json as { compress: Array<{ status: string }> }).compress[0].status).toBe('written');
    expect((applyProxyToAgent.mock.calls[0] as [string])[0]).toBe('copilot');
  });

  it('previews learned guardrails by default and only writes with --apply', async () => {
    learnFromSessions.mockResolvedValue({ sessions: 3, agents: ['claude'], rules: ['r'], block: 'b', target: 'CLAUDE.local.md', changed: true, created: false, digest: { toolCalls: 1, failures: 0, failureRate: 0, loops: [] }, scanErrors: [], analyzerError: null, verbosity: null, verbosityFile: null });
    await run(['install', 'claude', '--learn']);
    expect((learnFromSessions.mock.calls[0][0] as { apply: boolean }).apply).toBe(false);
    await run(['install', 'claude', '--learn', '--apply']);
    expect((learnFromSessions.mock.calls[1][0] as { apply: boolean }).apply).toBe(true);
  });

  it('scopes the session scan to the named assistants and this repo by default', async () => {
    learnFromSessions.mockResolvedValue({ sessions: 0, agents: [], rules: [], block: '', target: 't', changed: false, created: false, digest: { toolCalls: 0, failures: 0, failureRate: 0, loops: [] }, scanErrors: [], analyzerError: null, verbosity: null, verbosityFile: null });
    await run(['install', 'claude', '--learn', '--since', '30d', '--all-projects']);
    expect(learnFromSessions.mock.calls[0][0]).toMatchObject({ assistants: ['claude'], since: '30d', allProjects: true, root: repo });
  });

  it('does not scan sessions unless --learn is asked for', async () => {
    await run(['install', 'claude']);
    expect(learnFromSessions).not.toHaveBeenCalled();
  });
});

describe('proxyUrlFor', () => {
  it('prefers an explicit value, then VG_PROXY_URL, then the host/port knobs', () => {
    expect(proxyUrlFor('http://example:9/', {})).toBe('http://example:9');
    expect(proxyUrlFor(true, { VG_PROXY_URL: 'http://from-env:1/' } as NodeJS.ProcessEnv)).toBe('http://from-env:1');
    expect(proxyUrlFor(true, { VG_PROXY_HOST: '127.0.0.1', VG_PROXY_PORT: '9999' } as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:9999');
  });
});
