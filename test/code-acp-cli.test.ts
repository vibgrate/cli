/**
 * End-to-end: `vg code --provider grok-build` as a host drives it — a real
 * `vg` process (tsx from source) talking ACP to the scripted fake agent, with
 * NDJSON on stdout and decisions on stdin. Covers the CLI wiring the unit
 * tests cannot: flag resolution, map auto-build, the stream-json one-shot and
 * session paths, plan mode over the host protocol, --profile, and errors.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'src/cli.ts');
const tsxLoader = pathToFileURL(path.join(pkgRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const fake = path.join(pkgRoot, 'test/__fixtures__/acp/fake-acp-agent.mjs');
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function repo(): { dir: string; scenario: (s: unknown) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-acp-cli-'));
  roots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const timeout = 0;\n');
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return {
    dir,
    scenario: (s) => {
      const f = path.join(root, `scenario-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(f, JSON.stringify(s));
      return `"${process.execPath}" "${fake}" "${f}"`;
    },
  };
}

const ENV: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', VIBGRATE_NO_KERNEL: '1', VIBGRATE_DSN: '' };

/** Run vg; `onLine` may answer on stdin. Resolves with every NDJSON line, stderr and the exit code. */
function vg(
  cwd: string,
  args: string[],
  onLine?: (line: Record<string, unknown>, write: (msg: unknown) => void) => void,
): Promise<{ lines: Record<string, unknown>[]; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, cli, ...args], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: Record<string, unknown>[] = [];
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.stdin.on('error', () => {});
    const write = (msg: unknown): void => {
      child.stdin.write(JSON.stringify(msg) + '\n');
    };
    createInterface({ input: child.stdout }).on('line', (raw) => {
      try {
        const line = JSON.parse(raw) as Record<string, unknown>;
        lines.push(line);
        onLine?.(line, write);
      } catch {
        /* non-JSON */
      }
    });
    if (!onLine) child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 100_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ lines, stderr, code });
    });
  });
}

const EDIT = {
  turns: [
    {
      steps: [
        { type: 'read', id: 'r1', path: 'src/a.ts' },
        { type: 'edit', id: 'e1', path: 'src/a.ts', search: 'timeout = 0', replace: 'timeout = 30' },
        { type: 'message', text: 'Set the timeout to 30.' },
      ],
    },
  ],
};

const types = (lines: Record<string, unknown>[]): string[] =>
  lines.map((l) => (l.event === 'event' ? String(l.type) : String(l.event)));

describe('vg code --provider grok-build (ACP backend, end to end)', () => {
  it('one-shot stream-json: activity + Changes card + done, the file is edited, --profile prints the line', async () => {
    const { dir, scenario } = repo();
    const res = await vg(dir, ['code', '--provider', 'grok-build', '--acp-command', scenario(EDIT), '--no-acp-mcp', '--stream-json', '--auto', '--profile', 'set the timeout to 30']);
    expect(res.code).toBe(0);
    const t = types(res.lines);
    expect(t).toContain('approve-request');
    expect(t).toContain('activity');
    expect(t).toContain('changes-summary');
    expect(t.at(-1)).toBe('done');
    const done = res.lines.at(-1) as { result: { stopped: string; finalText: string; provider: { id: string } } };
    expect(done.result).toMatchObject({ stopped: 'finished', finalText: 'Set the timeout to 30.' });
    expect(done.result.provider.id).toBe('grok-build');
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 30;\n');
    expect(res.stderr).toMatch(/profile: steps=\d+ stop=finished wall=[\d.]+s tools=2 changes=1 activity=1 cards=1 .*backend=grok-build/);
  }, 120_000);

  it('session mode: protocol v6 session-start, plan turn writes nothing and announces plan-ready, then a normal turn edits', async () => {
    const { dir, scenario } = repo();
    const cmd = scenario({ turns: [{ steps: [{ type: 'edit', id: 'e1', path: 'src/a.ts', search: 'timeout = 0', replace: 'timeout = 9', permission: false }, { type: 'message', text: 'Plan ready.' }] }, EDIT.turns[0]] });
    let idles = 0;
    const res = await vg(dir, ['code', '--provider', 'grok-build', '--acp-command', cmd, '--no-acp-mcp', '--stream-json', '--session'], (line, write) => {
      if (line.event === 'session-start') write({ submit: 'plan the timeout change', agentMode: 'plan' });
      if (line.event === 'approve-request') write({ approveId: line.id, approve: true });
      if (line.event === 'idle') {
        idles++;
        if (idles === 1) {
          // The plan turn must not have written.
          expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 0;\n');
          write({ submit: 'now set it to 30' });
        } else write({ end: true });
      }
    });
    expect(res.code).toBe(0);
    const start = res.lines.find((l) => l.event === 'session-start') as Record<string, unknown>;
    expect(start).toMatchObject({ protocolVersion: 6, provider: 'grok-build', model: expect.stringMatching(/^fake-acp-agent/) });
    const t = types(res.lines);
    expect(t.filter((x) => x === 'plan-ready')).toHaveLength(1);
    expect(t.filter((x) => x === 'idle')).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 30;\n');
    // The session is filed for History like a native one.
    const sessions = fs.readdirSync(path.join(dir, '.vibgrate'), { recursive: true }).map(String);
    expect(sessions.some((f) => /sessions/.test(f))).toBe(true);
  }, 120_000);

  it('a missing agent binary is an actionable error frame, not a hang', async () => {
    const { dir } = repo();
    const res = await vg(dir, ['code', '--provider', 'grok-build', '--acp-command', 'vg-no-such-agent-binary agent stdio', '--no-acp-mcp', '--stream-json', 'x']);
    const err = res.lines.find((l) => l.event === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/not found on PATH/);
    expect(res.code).not.toBe(0);
  }, 120_000);

  it('without a TTY, --auto or --stream-json the ACP backend refuses (approvals need a human)', async () => {
    const { dir, scenario } = repo();
    const res = await vg(dir, ['code', '--provider', 'grok-build', '--acp-command', scenario(EDIT), '--no-acp-mcp', 'x']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/asks before each edit\/command/);
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 0;\n');
  }, 120_000);
});

/** Start the scripted OpenAI-compatible server; resolves its base URL and a stop function. */
function fakeOpenAi(script: unknown): Promise<{ url: string; stop: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-native-cli-'));
  roots.push(root);
  const file = path.join(root, 'script.json');
  fs.writeFileSync(file, JSON.stringify(script));
  const server = spawn(process.execPath, [path.join(pkgRoot, 'test/__fixtures__/openai/fake-openai-server.mjs'), file, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve({ url: `http://127.0.0.1:${m[1]}/v1`, stop: () => server.kill() });
    });
    server.on('exit', () => reject(new Error('fake server exited')));
  });
}

describe('vg code native loop (scripted OpenAI-compatible model, end to end)', () => {
  it('stream-json session: v6 activity + Changes card, --profile line, a plan turn concludes cleanly, end exits', async () => {
    const { dir } = repo();
    const server = await fakeOpenAi({
      byPrompt: [
        {
          match: 'Plan',
          steps: [
            { tool_calls: [{ name: 'search_code', arguments: { query: 'timeout' } }] },
            { tool_calls: [{ name: 'finish', arguments: { summary: 'Plan: raise the timeout in src/a.ts.' } }] },
          ],
        },
        {
          match: 'timeout',
          steps: [
            { tool_calls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] },
            { tool_calls: [{ name: 'edit_file', arguments: { path: 'src/a.ts', search: 'timeout = 0', replace: 'timeout = 30' } }] },
            { tool_calls: [{ name: 'finish', arguments: { summary: 'Set the timeout to 30.' } }] },
          ],
        },
      ],
    });
    try {
      const prev = ENV.LMSTUDIO_BASE_URL;
      ENV.LMSTUDIO_BASE_URL = server.url;
      let idles = 0;
      const res = await vg(dir, ['code', '--provider', 'lmstudio', '--model', 'fake-model', '--stream-json', '--session', '--profile'], (line, write) => {
        if (line.event === 'session-start') write({ submit: 'Plan the timeout change. Do not edit yet.', agentMode: 'plan' });
        if (line.event === 'approve-request') write({ approveId: line.id, approve: true });
        if (line.event === 'idle') {
          idles++;
          if (idles === 1) write({ submit: 'set the timeout to 30' });
          else write({ end: true });
        }
      });
      if (prev === undefined) delete ENV.LMSTUDIO_BASE_URL;
      else ENV.LMSTUDIO_BASE_URL = prev;
      // `end` alone exits the process (stdin is released).
      expect(res.code).toBe(0);
      const start = res.lines.find((l) => l.event === 'session-start') as Record<string, unknown>;
      expect(start.protocolVersion).toBe(6);
      const dones = res.lines.filter((l) => l.event === 'done') as Array<{ result: { stopped: string; finalText: string } }>;
      expect(dones.map((d) => d.result.stopped)).toEqual(['finished', 'finished']);
      expect(dones[0].result.finalText).toMatch(/^Plan:/);
      const t = types(res.lines);
      expect(t.filter((x) => x === 'changes-summary')).toHaveLength(1);
      expect(t).toContain('activity');
      expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 30;\n');
      const profiles = res.stderr.split('\n').filter((l) => l.startsWith('profile: '));
      expect(profiles).toHaveLength(2);
      expect(profiles[0]).toMatch(/stop=finished .*changes=0 activity=1 cards=0 .*clean=yes backend=native/);
      expect(profiles[1]).toMatch(/stop=finished .*changes=1 activity=1 cards=1 .*clean=yes backend=native/);
    } finally {
      server.stop();
    }
  }, 120_000);
});
