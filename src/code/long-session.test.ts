/**
 * Gold gates for long-session reliability of `runAgent`.
 *
 * These fail if a productive multi-step run is treated as stuck, if a verify
 * ladder failure silently finishes, if a hosted fallback is hidden, if
 * compression corrupts a later read, if compaction breaks a later edit, or if
 * plan mode leaks a mutation. Deterministic mocks only — no network.
 */

import { describe, it, expect } from 'vitest';
import {
  runAgent,
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_NO_PROGRESS_STOP_AT,
} from './agent.js';
import { pytestLog } from '../compress/__fixtures__/samples.js';
import { BYTE_EXACT_TOOLS, shouldCompress } from './compress-tool-output.js';
import { fixtureGraph } from './graph-fixture.js';
import { ScriptedProvider } from './providers.js';
import { hostedFallbackIsFailure, pinPrimaryProvider } from './router.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, Provider, ProviderResult, ToolCall } from './types.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null> } {
  const files: Record<string, string | null> = { ...seed };
  return {
    files,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => undefined,
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({
  id,
  name,
  arguments: args,
});

const baseFile = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';

function recording(inner: ScriptedProvider): Provider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    id: inner.id,
    label: inner.label,
    local: inner.local,
    model: inner.model,
    seen,
    chat: async (messages, opts) => {
      seen.push(messages.map((m) => ({ ...m })));
      return inner.chat(messages, opts);
    },
  };
}

describe('long-session gold — productive multi-step is not no-progress', () => {
  it('search → read → edit → verify → finish does not trip no-progress', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'timeout' }, 's1')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('run_command', { command: 'npm test' }, 'v1')] },
      { toolCalls: [tc('finish', { summary: 'raised the timeout to 5000ms' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: 'all tests passed', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.stopped).not.toBe('no-progress');
    // Same step count as the identical-call cap — progress must still win.
    expect(result.steps).toBe(AGENT_NO_PROGRESS_STOP_AT);
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
    expect(result.changes).toHaveLength(1);
  });

  it('alternating different tool calls with real progress is not identical-call stuck', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'timeout' }, 's1')] },
      { toolCalls: [tc('search_code', { query: 'scanDir' }, 's2')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { toolCalls: [tc('search_code', { query: 'formatReport' }, 's3')] },
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 2500;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'raised timeout after two searches and a read' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.stopped).not.toBe('no-progress');
    expect(result.steps).toBe(6);
    expect(fsImpl.files['src/scan.ts']).toContain('2500');
  });
});

describe('long-session gold — verify-ladder repair continues', () => {
  it('after a ladder failure the loop keeps repairing instead of silent finish', async () => {
    const provider = new ScriptedProvider('m', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 1;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'first attempt' }, 'f1')] },
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 1;', replace: 'const timeout = 5000;' }, 'e2'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'repaired after ladder failure' }, 'f2')] },
    ]);
    let testRuns = 0;
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => {
        testRuns++;
        return testRuns === 1
          ? { stdout: 'FAIL: timeout still 1', exitCode: 1 }
          : { stdout: 'all pass', exitCode: 0 };
      },
      approve: async () => true,
      capsule: true,
      capsuleMode: 'compile',
      verifyLadder: true,
      testCommand: 'npm test',
      files: ['src/scan.ts'],
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('repaired after ladder failure');
    expect(testRuns).toBe(2);
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
  });
});

describe('long-session gold — max-steps names how to raise the cap', () => {
  it('the default cap is 24 and the stop text names --max-steps and maxSteps', async () => {
    expect(AGENT_DEFAULT_MAX_STEPS).toBe(24);
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'x' })] }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 2,
      noAudit: true,
    });
    expect(result.stopped).toBe('max-steps');
    expect(result.finalText).toMatch(/step limit \(2 steps\)/);
    expect(result.finalText).toMatch(/--max-steps/);
    expect(result.finalText).toMatch(/maxSteps/);
    expect(result.finalText).toMatch(/vibgrate\.config\.json/);
  });
});

describe('long-session gold — hosted fallback is sticky and treatable as failure', () => {
  it('transport failure on a Relay-shaped primary that succeeds on the local fallback sets fellBack', async () => {
    const relay: Provider = {
      id: 'vibgrate-relay',
      label: 'Vibgrate Relay',
      local: false,
      model: 'hosted-coder',
      chat: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const local = new ScriptedProvider('local-coder', [
      { toolCalls: [tc('finish', { summary: 'answered on the fallback' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [relay, local],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.provider.id).toBe('scripted');
    expect(result.provider.fellBack).toBe(true);
    expect(hostedFallbackIsFailure(result.provider)).toBe(true);
  });

  it('a later primary success does not hide an earlier fallback (sticky fellBack)', async () => {
    let relayTurns = 0;
    const relay: Provider = {
      id: 'vibgrate-relay',
      label: 'Vibgrate Relay',
      local: false,
      model: 'hosted-coder',
      async chat(): Promise<ProviderResult> {
        relayTurns++;
        if (relayTurns === 1) throw new Error('ECONNRESET');
        return {
          text: '',
          model: 'hosted-coder',
          provider: 'vibgrate-relay',
          toolCalls: [tc('finish', { summary: 'primary recovered' }, 'f1')],
        };
      },
    };
    const local = new ScriptedProvider('local-coder', [
      { toolCalls: [tc('search_code', { query: 'timeout' }, 's1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [relay, local],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.provider.id).toBe('vibgrate-relay');
    expect(result.provider.fellBack).toBe(true);
    expect(hostedFallbackIsFailure(result.provider)).toBe(true);
  });

  it('pinPrimaryProvider drops the fallback chain so a Review caller can fail closed', () => {
    const relay: Provider = {
      id: 'vibgrate-relay',
      label: 'Vibgrate Relay',
      local: false,
      model: 'hosted-coder',
      chat: async () => ({ text: '', model: 'hosted-coder', provider: 'vibgrate-relay' }),
    };
    const local = new ScriptedProvider('local-coder', [{ text: 'nope' }]);
    const pinned = pinPrimaryProvider([relay, local]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].id).toBe('vibgrate-relay');
  });
});

describe('long-session gold — compression does not corrupt a later read', () => {
  it('byte-exact tools are never compressed, even when huge', () => {
    const huge = 'x'.repeat(20_000);
    for (const tool of BYTE_EXACT_TOOLS) {
      expect(shouldCompress(tool, huge, {}, 4000), tool).toBe(false);
    }
    expect(shouldCompress('run_command', huge, {}, 4000)).toBe(true);
    expect(shouldCompress('search_code', huge, {}, 4000)).toBe(true);
  });

  it('a large successful run_command is compressed and a later read_file stays byte-exact', async () => {
    const log = pytestLog(300);
    expect(log.length).toBeGreaterThan(4000);
    const fileBody = baseFile;
    const inner = new ScriptedProvider('m', [
      { toolCalls: [tc('run_command', { command: 'npm test -- --reporter=verbose' }, 'c1')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { toolCalls: [tc('finish', { summary: 'read the file after the log' }, 'f1')] },
    ]);
    const provider = recording(inner);
    const fsImpl = memFs({ 'src/scan.ts': fileBody });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'inspect the test log then read src/scan.ts',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: log, exitCode: 0 }),
      approve: async () => true,
      compressEnv: {
        VG_CODE_COMPRESS: '1',
        VG_CCR_BACKEND: 'memory',
        VG_CONTEXT_DIR: '/tmp/vg-long-session-ccr',
      } as NodeJS.ProcessEnv,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    const afterRun = provider.seen[1] ?? [];
    const runTool = [...afterRun].reverse().find((m) => m.role === 'tool' && m.name === 'run_command');
    expect(runTool).toBeTruthy();
    expect((runTool?.content ?? '').length).toBeLessThan(log.length);
    const afterRead = provider.seen[2] ?? [];
    const readTool = [...afterRead].reverse().find((m) => m.role === 'tool' && m.name === 'read_file');
    expect(readTool?.content).toContain(fileBody);
    expect(readTool?.content).not.toMatch(/<<vg-ccr:/);
    // Header + body, not a summarised stand-in for the file.
    expect((readTool?.content ?? '').length).toBeGreaterThanOrEqual(fileBody.length);
  });
});

describe('long-session gold — compaction mid-loop stays coherent', () => {
  it('an over-budget transcript still lets the agent finish a later edit', async () => {
    const searches = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [tc('search_code', { query: `probe-${i}` }, `s${i}`)],
    }));
    const provider = new ScriptedProvider('m', [
      ...searches,
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 9000;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'edited after compaction' }, 'f1')] },
    ]);
    const events: Array<{ type: string; droppedRounds?: number }> = [];
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout after a long inspect',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      contextBudget: 80,
      onEvent: (e) => {
        if (e.type === 'compact') events.push({ type: e.type, droppedRounds: e.droppedRounds });
      },
      noAudit: true,
    });
    expect(events.some((e) => e.type === 'compact' && (e.droppedRounds ?? 0) > 0)).toBe(true);
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('edited after compaction');
    expect(fsImpl.files['src/scan.ts']).toContain('9000');
    expect(result.changes).toHaveLength(1);
  });
});

describe('long-session gold — plan mode cannot leak a mutation', () => {
  it('several steps including edit and shell leave the file unchanged', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'timeout' }, 's1')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { toolCalls: [tc('search_code', { query: 'scanDir' }, 's2')] },
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('run_command', { command: 'echo mutated' }, 'c1')] },
      { toolCalls: [tc('finish', { summary: 'Plan: raise the timeout in src/scan.ts.' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const ran: string[] = [];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'plan a timeout raise',
      providers: [provider],
      fsImpl,
      run: (cmd) => {
        ran.push(cmd);
        return { stdout: 'ran', exitCode: 0 };
      },
      approve: async () => true,
      plan: true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/scan.ts']).toBe(baseFile);
    expect(ran).toEqual([]);
  });
});
