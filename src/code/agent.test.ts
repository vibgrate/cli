import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgent, compact, type AgentEvent } from './agent.js';
import { ScriptedProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import { readModelSavings } from '../engine/savings.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, ToolCall } from './types.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null>; audit: string[] } {
  const files: Record<string, string | null> = { ...seed };
  const audit: string[] = [];
  return {
    files,
    audit,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: (line) => audit.push(line),
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({ id, name, arguments: args });

describe('runAgent — the agentic loop', () => {
  const baseFile = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';

  it('runs a full search → read → edit → run → finish session', async () => {
    // A scripted "model" that drives a realistic tool sequence.
    const provider = new ScriptedProvider('m', [
      { text: 'Let me find it.', toolCalls: [tc('search_code', { query: 'timeout' }, 't1')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 't2')] },
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't3')] },
      { toolCalls: [tc('run_command', { command: 'npm test' }, 't4')] },
      { toolCalls: [tc('finish', { summary: 'raised the timeout to 5000ms' }, 't5')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const run = vi.fn(() => ({ stdout: 'all tests passed', exitCode: 0 }));
    const events: AgentEvent[] = [];

    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the request timeout to 5000ms',
      providers: [provider],
      fsImpl,
      run,
      approve: async () => true,
      onEvent: (e) => events.push(e),
    });

    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('raised the timeout to 5000ms');
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
    expect(result.changes).toHaveLength(1);
    expect(run).toHaveBeenCalledWith('npm test');
    // the tool activity was surfaced
    expect(events.some((e) => e.type === 'tool-call' && e.name === 'search_code')).toBe(true);
    expect(events.some((e) => e.type === 'change')).toBe(true);
  });

  it('respects a declined edit — nothing is written, the loop continues', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'user declined the edit' }, 't2')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => false, // decline everything
    });
    expect(fsImpl.files['src/scan.ts']).toBe(baseFile); // unchanged
    expect(result.changes).toHaveLength(0);
    expect(result.stopped).toBe('finished');
  });

  it('stops at the step cap when the model never finishes', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'x' })] }]); // repeats forever
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 3,
    });
    expect(result.stopped).toBe('max-steps');
    expect(result.steps).toBe(3);
  });

  it('ends when the model replies with text and no tool calls', async () => {
    const provider = new ScriptedProvider('m', [{ text: 'I need more detail about which timeout.' }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
    });
    expect(result.stopped).toBe('no-tools');
    expect(result.finalText).toContain('more detail');
  });

  it('writes a secret-free audit record at the end of a run', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('run_command', { command: 'npm test' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't3')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: 'ok', exitCode: 0 }),
      approve: async () => true,
      now: () => 99,
    });
    expect(result.stopped).toBe('finished');
    expect(fsImpl.audit).toHaveLength(1);
    const rec = JSON.parse(fsImpl.audit[0]);
    expect(rec.kind).toBe('agent');
    expect(rec.stopped).toBe('finished');
    expect(rec.commands).toBe(1);
    expect(rec.files.map((f: { file: string }) => f.file)).toContain('src/scan.ts');
    // no code, no command text, no secrets in the record
    expect(JSON.stringify(rec)).not.toContain('timeout = 5000');
    expect(JSON.stringify(rec)).not.toContain('npm test');
  });

  it('stops as no-progress when the model repeats an identical non-mutating call', async () => {
    // Always the same search — never mutates, never finishes.
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'timeout' }, 'x')] }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 50,
    });
    expect(result.stopped).toBe('no-progress');
    expect(result.steps).toBeLessThanOrEqual(5); // stops well before the step cap
  });

  it('auto-verify: keeps going until the test command passes', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 1;' }, 'e1')] },
      { toolCalls: [tc('finish', { summary: 'first attempt' }, 'f1')] },
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 1;', replace: 'const timeout = 5000;' }, 'e2')] },
      { toolCalls: [tc('finish', { summary: 'fixed it' }, 'f2')] },
    ]);
    let testRuns = 0;
    const run = vi.fn(() => ({ stdout: testRuns++ === 0 ? 'FAIL: 1 test' : 'all pass', exitCode: testRuns <= 1 ? 1 : 0 }));
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run,
      approve: async () => true,
      verify: { command: 'npm test', maxRounds: 2 },
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('fixed it');
    expect(run).toHaveBeenCalledTimes(2); // failed once, then passed
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
  });

  it('accumulates token usage for the cost meter', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('finish', { summary: 'done' }, 'f')] }]);
    // ScriptedProvider reports no usage; a provider that does would surface here.
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
    });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('records per-model savings for the first graph search', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-agent-'));
    try {
      const provider = new ScriptedProvider('claude-3.5-sonnet', [
        { toolCalls: [tc('search_code', { query: 'timeout' }, 't1')] },
        { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
      ]);
      await runAgent({
        graph: fixtureGraph(),
        root,
        instruction: 'x',
        providers: [provider],
        fsImpl: memFs(),
        run: () => ({ stdout: '', exitCode: 0 }),
        approve: async () => true,
        attribution: { client: 'vg-code', provider: 'anthropic', model: 'anthropic/claude-3.5-sonnet' },
        now: () => Date.now(),
      });
      const models = readModelSavings(root, 30, Date.now());
      expect(models).toHaveLength(1);
      expect(models[0].model).toBe('anthropic/claude-3.5-sonnet');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('compact', () => {
  const head: ChatMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'context' },
    { role: 'user', content: 'task' },
  ];
  const round = (i: number): ChatMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }] },
    { role: 'tool', content: 'x'.repeat(500), toolCallId: `c${i}`, name: 'read_file' },
  ];

  it('leaves a small transcript untouched', () => {
    const msgs = [...head, ...round(1), ...round(2)];
    const r = compact(msgs, 100_000, []);
    expect(r.droppedRounds).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it('keeps the prefix + recent rounds and summarizes the middle when over budget', () => {
    const rounds = Array.from({ length: 14 }, (_, i) => round(i)).flat();
    const msgs = [...head, ...rounds];
    const r = compact(msgs, 500, [{ file: 'a.ts', before: null, after: 'x', outcomes: [], diff: '' }]);
    expect(r.droppedRounds).toBe(14 - 8); // KEEP_ROUNDS = 8
    // prefix preserved, a summary note inserted, then the last 8 rounds (16 messages)
    expect(r.messages.slice(0, 3)).toEqual(head);
    expect(r.messages[3].role).toBe('user');
    expect(r.messages[3].content).toContain('summarized');
    expect(r.messages[3].content).toContain('a.ts');
    expect(r.messages.length).toBe(3 + 1 + 8 * 2);
    // never split an assistant/tool pair — the first kept round starts with an assistant
    expect(r.messages[4].role).toBe('assistant');
  });
});
