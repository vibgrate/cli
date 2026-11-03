/**
 * ACP hybrid backend (parity spec Phase 2). Drives the scripted fake agent in
 * test/__fixtures__/acp/fake-acp-agent.mjs as a REAL child process, so spawn,
 * line framing, the JSON-RPC peer and every mapping are exercised end to end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpSession, runAcpSession, splitCommandLine, toolNameForKind, workspaceRelative } from './acp-client.js';
import { StreamJsonSession, type StreamJsonOut } from './stream-json.js';
import { visibleTranscript } from './host-transcript.js';
import type { AgentEvent } from './agent.js';
import type { MutatingAction } from './tools.js';

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/__fixtures__/acp/fake-acp-agent.mjs');
const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-acp-'));
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

/** Write a scenario and return the ACP command line that runs the fake agent with it. */
function agent(dir: string, scenario: Record<string, unknown>): string {
  const file = path.join(dir, '.scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  return `"${process.execPath}" "${FAKE}" "${file}"`;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SRC = 'export const timeout = 0;\n';
const editTurn = (extra: Record<string, unknown> = {}) => ({
  turns: [
    {
      steps: [
        { type: 'thought', text: 'Find the timeout.' },
        { type: 'search', id: 's1', title: 'grep timeout', output: 'src/a.ts:1' },
        { type: 'read', id: 'r1', path: 'src/a.ts' },
        { type: 'edit', id: 'e1', path: 'src/a.ts', search: 'timeout = 0', replace: 'timeout = 30', ...extra },
        { type: 'message', text: 'Set the timeout to 30 in src/a.ts.' },
      ],
    },
  ],
});

describe('splitCommandLine / helpers', () => {
  it('splits with quotes and escapes, no expansion', () => {
    expect(splitCommandLine('grok agent stdio')).toEqual(['grok', 'agent', 'stdio']);
    expect(splitCommandLine(`"/opt/my tools/grok" agent 'std io' a\\ b $HOME`)).toEqual([
      '/opt/my tools/grok',
      'agent',
      'std io',
      'a b',
      '$HOME',
    ]);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('maps ACP tool kinds onto VG Code tool names', () => {
    expect(toolNameForKind('read')).toBe('read_file');
    expect(toolNameForKind('search')).toBe('search_code');
    expect(toolNameForKind('edit')).toBe('edit_file');
    expect(toolNameForKind('execute')).toBe('run_command');
    expect(toolNameForKind('other')).toBe('acp_tool');
  });

  it('workspaceRelative confines paths to the root', () => {
    expect(workspaceRelative('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
    expect(workspaceRelative('/repo', 'src/a.ts')).toBe('src/a.ts');
    expect(workspaceRelative('/repo', '/etc/passwd')).toBeNull();
    expect(workspaceRelative('/repo', '/repo/../etc/passwd')).toBeNull();
    expect(workspaceRelative('/repo', '/repo')).toBeNull();
  });
});

describe('runAcpSession against a fake Grok-Build-shaped agent', () => {
  it('tool call + permission → tool-call, approve, change, activity, Changes card, metrics', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const events: AgentEvent[] = [];
    const approvals: MutatingAction[] = [];
    const result = await runAcpSession({
      command: agent(dir, editTurn()),
      cwd: dir,
      providerId: 'grok-build',
      label: 'Grok Build',
      instruction: 'set the timeout to 30',
      onEvent: (e) => events.push(e),
      approve: async (a) => {
        approvals.push(a);
        return true;
      },
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('Set the timeout to 30 in src/a.ts.');
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const timeout = 30;\n');

    // One approval for the edit (the fs write is covered by it — no second card).
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'edit', file: 'src/a.ts' });
    expect((approvals[0] as { diff: string }).diff).toContain('+export const timeout = 30;');

    const calls = events.filter((e) => e.type === 'tool-call') as Extract<AgentEvent, { type: 'tool-call' }>[];
    expect(calls.map((c) => c.name)).toEqual(['search_code', 'read_file', 'edit_file']);
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(3);
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
    // The diff seen in tool_call + tool_call_update + the fs write is ONE change.
    expect(events.filter((e) => e.type === 'change')).toHaveLength(1);
    const card = events.find((e) => e.type === 'changes-summary') as Extract<AgentEvent, { type: 'changes-summary' }>;
    expect(card.files).toEqual([{ path: 'src/a.ts', added: 1, removed: 1, status: 'modified' }]);
    const metrics = (events.find((e) => e.type === 'metrics') as Extract<AgentEvent, { type: 'metrics' }>).metrics;
    expect(metrics).toMatchObject({ stopReason: 'finished', toolCalls: 3, changes: 1, activityGroups: 1 });
    expect(metrics.steps).toBeGreaterThanOrEqual(1);
    expect(metrics.trajectory.discoveryToolCalls).toBe(2);

    const view = visibleTranscript([...events.map((e) => ({ event: 'event', ...e })), { event: 'done', result }]);
    expect(view.activityLines).toBeLessThanOrEqual(2);
    expect(view.changesCards).toBe(1);
    expect(view.items.map((i) => i.kind)).toEqual(['activity', 'answer', 'changes']);
    expect(view.answer).toBe('Set the timeout to 30 in src/a.ts.');
  });

  it('a rejected permission writes nothing and shows no Changes card', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const events: AgentEvent[] = [];
    const result = await runAcpSession({
      command: agent(dir, editTurn()),
      cwd: dir,
      instruction: 'set the timeout to 30',
      onEvent: (e) => events.push(e),
      approve: async () => false,
    });
    expect(result.stopped).toBe('finished');
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe(SRC);
    expect(events.some((e) => e.type === 'changes-summary')).toBe(false);
    const edit = events.filter((e) => e.type === 'tool-result').at(-1) as Extract<AgentEvent, { type: 'tool-result' }>;
    expect(edit).toMatchObject({ name: 'edit_file', failed: true, mutated: false });
  });

  it('plan mode denies engine-side: the host is never asked and nothing is written', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    let asked = 0;
    const result = await runAcpSession({
      command: agent(dir, editTurn({ permission: false })),
      cwd: dir,
      instruction: 'plan the change',
      plan: true,
      approve: async () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(0);
    expect(result.changes).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe(SRC);
  });

  it('plan mode switches an agent that advertises a plan mode, prefixes the prompt, and restores the mode', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const record = path.join(dir, '.record.ndjson');
    process.env.FAKE_ACP_RECORD = record;
    try {
      await runAcpSession({
        command: agent(dir, {
          modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
          turns: [{ steps: [{ type: 'message', text: 'Plan: …' }] }],
        }),
        cwd: dir,
        instruction: 'plan worktree support',
        plan: true,
        approve: async () => true,
      });
    } finally {
      delete process.env.FAKE_ACP_RECORD;
    }
    const sent = fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const methods = sent.map((m) => m.method).filter(Boolean);
    expect(methods).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt', 'session/set_mode']);
    expect(sent.filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId)).toEqual(['plan', 'default']);
    const prompt = sent.find((m) => m.method === 'session/prompt');
    expect(prompt.params.prompt[0].text).toMatch(/^\[Plan mode — read-only\./);
  });

  it('a write the agent never asked permission for goes through the gate itself', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const approvals: MutatingAction[] = [];
    await runAcpSession({
      command: agent(dir, editTurn({ permission: false })),
      cwd: dir,
      instruction: 'set the timeout to 30',
      approve: async (a) => {
        approvals.push(a);
        return false;
      },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'edit', file: 'src/a.ts' });
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe(SRC);
  });

  it('an agent that writes by itself still produces one change from its diff content', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const result = await runAcpSession({
      command: agent(dir, editTurn({ via: 'diff' })),
      cwd: dir,
      instruction: 'set the timeout to 30',
      approve: async () => true,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ file: 'src/a.ts', before: SRC, after: 'export const timeout = 30;\n' });
  });

  it('autonomous mode blocks a dangerous command without asking; read-only commands skip the card', async () => {
    const dir = workspace();
    const events: AgentEvent[] = [];
    const asked: MutatingAction[] = [];
    await runAcpSession({
      command: agent(dir, {
        turns: [
          {
            steps: [
              { type: 'execute', id: 'x1', command: 'rm -rf /', output: '' },
              { type: 'execute', id: 'x2', command: 'git status', output: 'clean' },
              { type: 'execute', id: 'x3', command: 'npm test', output: 'ok' },
            ],
          },
        ],
      }),
      cwd: dir,
      instruction: 'clean up',
      auto: true,
      onEvent: (e) => events.push(e),
      approve: async (a) => {
        asked.push(a);
        return true;
      },
    });
    expect(asked).toEqual([{ kind: 'run', command: 'npm test' }]);
    expect(events.some((e) => e.type === 'notice' && /dangerous-command denylist/.test(e.text))).toBe(true);
    const results = events.filter((e) => e.type === 'tool-result') as Extract<AgentEvent, { type: 'tool-result' }>[];
    expect(results.map((r) => !!r.failed)).toEqual([true, false, false]);
  });

  it('x.ai/ask_user_question round-trips through askUser; vendor rail updates map the same', async () => {
    const dir = workspace();
    const questions: string[] = [];
    const result = await runAcpSession({
      command: agent(dir, {
        vendorRail: true,
        turns: [{ steps: [{ type: 'ask', question: 'Which flag name?', options: ['--timeout', '--deadline'] }, { type: 'message', text: 'Done.' }] }],
      }),
      cwd: dir,
      instruction: 'add a flag',
      askUser: async (q) => {
        questions.push(`${q.question} [${q.options?.join('|')}]`);
        return '--timeout';
      },
      approve: async () => true,
    });
    expect(questions).toEqual(['Which flag name? [--timeout|--deadline]']);
    expect(result.finalText).toBe('You said: --timeout. Done.');
  });

  it('in-band authentication is completed; a terminal login yields an actionable error', async () => {
    const dir = workspace();
    const ok = await runAcpSession({
      command: agent(dir, { requireAuth: true, authMethods: [{ id: 'cached', name: 'Cached login', type: 'agent' }], turns: [{ steps: [{ type: 'message', text: 'hi' }] }] }),
      cwd: dir,
      instruction: 'hi',
      approve: async () => true,
    });
    expect(ok.finalText).toBe('hi');

    const dir2 = workspace();
    await expect(
      runAcpSession({
        command: agent(dir2, { requireAuth: true, authMethods: [{ id: 'login', name: 'Login', type: 'terminal', args: ['grok', 'login'] }], turns: [] }),
        cwd: dir2,
        label: 'Grok Build',
        instruction: 'hi',
        approve: async () => true,
      }),
    ).rejects.toThrow(/Grok Build is not signed in\. Run `grok login`/);
  });

  it('a missing binary names the install + login steps', async () => {
    const dir = workspace();
    await expect(
      runAcpSession({ command: 'vg-definitely-not-installed-acp agent stdio', cwd: dir, label: 'Grok Build', instruction: 'x', approve: async () => true }),
    ).rejects.toThrow(/not found on PATH.*grok login/);
  });

  it('an agent crash mid-turn ends the turn as error with the reason, not a hang', async () => {
    const dir = workspace();
    const result = await runAcpSession({
      command: agent(dir, { exitOnPrompt: true, turns: [] }),
      cwd: dir,
      label: 'Grok Build',
      instruction: 'x',
      approve: async () => true,
    });
    expect(result.stopped).toBe('error');
    expect(result.finalText).toMatch(/Grok Build exited unexpectedly \(code 3\)/);
    expect(result.finalText).toMatch(/simulated crash/);
  });

  it('cancel stops the turn cooperatively and settles a pending approval as denied', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const signal = { aborted: false };
    const result = await runAcpSession({
      command: agent(dir, editTurn()),
      cwd: dir,
      instruction: 'set the timeout to 30',
      signal,
      // The host never answers: cancel must unblock the card.
      approve: () => {
        signal.aborted = true;
        return new Promise<boolean>(() => {});
      },
    });
    expect(result.stopped).toBe('cancelled');
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe(SRC);
  });

  it('fs reads outside the workspace are refused', async () => {
    const dir = workspace();
    const events: AgentEvent[] = [];
    await runAcpSession({
      command: agent(dir, { turns: [{ steps: [{ type: 'read', id: 'r1', path: '../../etc/passwd' }] }] }),
      cwd: dir,
      instruction: 'x',
      onEvent: (e) => events.push(e),
      approve: async () => true,
    });
    const r = events.find((e) => e.type === 'tool-result') as Extract<AgentEvent, { type: 'tool-result' }>;
    expect(r).toMatchObject({ failed: true });
    expect(r.content).toMatch(/outside the workspace/);
  });

  it('steer: vendor interject when configured, otherwise a follow-up prompt before the turn ends', async () => {
    const dir = workspace();
    const scenario = { turns: [{ steps: [{ type: 'sleep', ms: 300 }, { type: 'message', text: 'Working.' }] }] };
    let given = false;
    const take = () => {
      if (given) return null;
      given = true;
      return 'use 45 instead';
    };
    const vendor = await runAcpSession({
      command: agent(dir, scenario),
      cwd: dir,
      steerMethod: '_x.ai/interject',
      instruction: 'x',
      takeInjected: take,
      approve: async () => true,
    });
    expect(vendor.finalText).toMatch(/steer applied: use 45 instead/);

    given = false;
    const events: AgentEvent[] = [];
    const queued = await runAcpSession({
      command: agent(dir, scenario),
      cwd: dir,
      instruction: 'x',
      takeInjected: take,
      onEvent: (e) => events.push(e),
      approve: async () => true,
    });
    expect(events.some((e) => e.type === 'injected' && e.text === 'use 45 instead')).toBe(true);
    expect(queued.finalText).toBe('Follow-up noted.');
  });

  it('a session survives across turns (warm agent process)', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const session = new AcpSession({
      command: agent(dir, { turns: [{ steps: [{ type: 'message', text: 'one' }] }, { steps: [{ type: 'message', text: 'two' }] }] }),
      cwd: dir,
    });
    await session.start();
    try {
      expect((await session.prompt({ instruction: 'a', approve: async () => true })).finalText).toBe('one');
      expect((await session.prompt({ instruction: 'b', approve: async () => true })).finalText).toBe('two');
    } finally {
      await session.close();
    }
  });
});

describe('ACP through the stream-json protocol (host relay)', () => {
  it('the host sees tool-call, approve-request, activity and changes-summary frames; its decision lands', async () => {
    const dir = workspace({ 'src/a.ts': SRC });
    const lines: StreamJsonOut[] = [];
    let session!: StreamJsonSession;
    const emit = (line: StreamJsonOut): void => {
      lines.push(line);
      // The host clicks Approve on the card.
      if (line.event === 'approve-request') queueMicrotask(() => session.submitDecision(line.id, true));
    };
    session = new StreamJsonSession(emit, false);
    const result = await runAcpSession({
      command: agent(dir, editTurn()),
      cwd: dir,
      instruction: 'set the timeout to 30',
      onEvent: session.onEvent,
      approve: session.approve,
      askUser: session.askUser,
    });
    emit({ event: 'done', result });
    const kinds = lines.map((l) => (l.event === 'event' ? `event:${(l as { type: string }).type}` : l.event));
    expect(kinds).toContain('event:tool-call');
    expect(kinds).toContain('approve-request');
    expect(kinds).toContain('event:activity');
    expect(kinds).toContain('event:changes-summary');
    expect(kinds.at(-1)).toBe('done');
    const card = lines.find((l) => l.event === 'approve-request') as Extract<StreamJsonOut, { event: 'approve-request' }>;
    expect(card.action).toMatchObject({ kind: 'edit', file: 'src/a.ts' });
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toContain('timeout = 30');
  });
});
