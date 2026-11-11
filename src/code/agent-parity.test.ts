/**
 * Parity behaviour of the native loop (reference-agent / Grok Build parity spec,
 * Phases 0, 1 and 3): final metrics, the quiet v6 transcript (activity lines +
 * Changes card), the finish incentive and proportional verification.
 */
import { describe, it, expect } from 'vitest';
import { runAgent, AGENT_FINISH_NUDGE, instructionAsksForTests, instructionRequiresMutation, type AgentEvent } from './agent.js';
import { AGENT_SYSTEM_PROMPT } from './prompt.js';
import { ScriptedProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import { visibleTranscript } from './host-transcript.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, Provider, ToolCall } from './types.js';

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
    appendAudit: () => {},
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({ id, name, arguments: args });
const SCAN = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';
const EDIT = tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 30;' }, 'e1');

/** Wrap a scripted provider so every call's transcript is captured. */
function recording(scripted: ScriptedProvider): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    id: scripted.id,
    label: scripted.label,
    local: scripted.local,
    model: scripted.model,
    calls,
    async chat(messages, opts) {
      calls.push(messages.map((m) => ({ ...m })));
      return scripted.chat(messages, opts);
    },
  };
}

describe('Phase 0 — final metrics', () => {
  it('the terminal metrics event carries steps, stopReason, wallMs, toolCalls, changes', async () => {
    const events: AgentEvent[] = [];
    let clock = 1_000;
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { toolCalls: [EDIT] },
      { toolCalls: [tc('finish', { summary: 'Set the timeout to 30.' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => {
        clock += 250;
        events.push(e);
      },
      wallClock: () => clock,
      noAudit: true,
    });
    const metricsEvents = events.filter((e) => e.type === 'metrics');
    expect(metricsEvents).toHaveLength(1);
    const m = (metricsEvents[0] as Extract<AgentEvent, { type: 'metrics' }>).metrics;
    expect(m.steps).toBe(3);
    expect(m.stopReason).toBe('finished');
    expect(m.toolCalls).toBe(3);
    expect(m.changes).toBe(1);
    expect(m.activityGroups).toBe(1);
    expect(m.wallMs).toBeGreaterThan(0);
    expect(result.metrics).toEqual(m);
  });
});

describe('Phase 1 — quiet transcript (activity + Changes card)', () => {
  it('a simple edit renders as ≤ 2 activity lines + 1 Changes card + the final answer', async () => {
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'scanDir timeout' }, 's1'), tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { toolCalls: [EDIT] },
      { toolCalls: [tc('finish', { summary: 'Raised the scan timeout to 30.' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');

    // Raw tool events still flow (additive protocol)…
    expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(4);
    // …and the aggregated view is quiet.
    const view = visibleTranscript([
      ...events.map((e) => ({ event: 'event', ...e }) as Record<string, unknown>),
      { event: 'done', result },
    ]);
    expect(view.activityLines).toBeLessThanOrEqual(2);
    expect(view.changesCards).toBe(1);
    expect(view.items.map((i) => i.kind)).toEqual(['activity', 'changes', 'answer']);
    expect(view.items[0].text).toBe('Explored 2 items · Edited 1 file · +1 −1');

    const card = events.find((e) => e.type === 'changes-summary') as Extract<AgentEvent, { type: 'changes-summary' }>;
    expect(card.files).toEqual([{ path: 'src/scan.ts', added: 1, removed: 1, status: 'modified' }]);
    // Ordering: final activity frame → Changes card → metrics.
    const order = events.map((e) => e.type).filter((t) => t === 'activity' || t === 'changes-summary' || t === 'metrics');
    expect(order.slice(-3)).toEqual(['activity', 'changes-summary', 'metrics']);
    const lastActivity = [...events].reverse().find((e) => e.type === 'activity') as Extract<AgentEvent, { type: 'activity' }>;
    expect(lastActivity.final).toBe(true);
  });

  it('a Q&A turn (no writes) emits no Changes card', async () => {
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'scanDir' }, 's1')] },
      { toolCalls: [tc('finish', { summary: 'scanDir lives in src/scan.ts.' }, 'f1')] },
    ]);
    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'where is scanDir?',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(events.some((e) => e.type === 'changes-summary')).toBe(false);
    expect(events.filter((e) => e.type === 'activity' && e.final)).toHaveLength(1);
  });

  it('assistant prose between tool bursts closes the line above the prose', async () => {
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
      { text: 'Found it — the timeout is hard-coded to 0. Editing now.', toolCalls: [EDIT] },
      { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] },
    ]);
    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    const iProse = events.findIndex((e) => e.type === 'assistant');
    const before = events.slice(0, iProse).filter((e) => e.type === 'activity');
    expect(before.at(-1)).toMatchObject({ group: 1, final: true, explored: 1 });
    const after = events.slice(iProse).filter((e) => e.type === 'activity');
    expect(after.at(-1)).toMatchObject({ group: 2, final: true, edited: 1 });
  });
});

describe('Phase 3 — finish incentives', () => {
  it('the agent system prompt carries the finish incentives', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(
      'Once the requested change is complete, verified, and the files are consistent, call finish immediately.',
    );
    expect(AGENT_SYSTEM_PROMPT).toContain('Do not continue exploring after a successful edit unless the user asked for more.');
    expect(AGENT_SYSTEM_PROMPT).toContain('Prefer the smallest number of tool calls that solves the task.');
  });

  it('a simple edit finishes in ≤ 4 steps and is not forced through extra steps', async () => {
    const provider = recording(
      new ScriptedProvider('m', [
        { toolCalls: [EDIT] },
        { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] },
        // Would only be reached if the loop forced another step.
        { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'never')] },
      ]),
    );
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.steps).toBe(2);
    expect(result.steps).toBeLessThanOrEqual(4);
    expect(provider.calls).toHaveLength(2);
    // The nudge is never sent when the model concludes on its own.
    expect(provider.calls.flat().some((m) => m.content === AGENT_FINISH_NUDGE)).toBe(false);
  });

  it('explore-after-edit gets exactly one soft nudge, then the run concludes', async () => {
    const provider = recording(
      new ScriptedProvider('m', [
        { toolCalls: [EDIT] },
        { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
        { toolCalls: [tc('search_code', { query: 'timeout' }, 's2')] },
        { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] },
      ]),
    );
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.steps).toBeLessThanOrEqual(4);
    // Step 3's transcript ends on the nudge (after step 2's read result).
    const step3 = provider.calls[2];
    expect(step3.at(-1)).toEqual({ role: 'user', content: AGENT_FINISH_NUDGE });
    // Once per turn.
    const nudges = provider.calls.at(-1)!.filter((m) => m.content === AGENT_FINISH_NUDGE);
    expect(nudges).toHaveLength(1);
  });

  it('aggressiveFinish:false, plan mode and a mid-turn steer all suppress the nudge', async () => {
    const script = () =>
      recording(
        new ScriptedProvider('m', [
          { toolCalls: [EDIT] },
          { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 'r1')] },
          { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] },
        ]),
      );
    const base = {
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set the scanDir timeout to 30 in src/scan.ts',
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    };
    const off = script();
    await runAgent({ ...base, providers: [off], aggressiveFinish: false });
    expect(off.calls.flat().some((m) => m.content === AGENT_FINISH_NUDGE)).toBe(false);

    const steered = script();
    let sent = false;
    await runAgent({
      ...base,
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      providers: [steered],
      takeInjected: () => {
        if (sent) return null;
        sent = true;
        return 'also keep the old default in a comment';
      },
    });
    expect(steered.calls.flat().some((m) => m.content === AGENT_FINISH_NUDGE)).toBe(false);

    const planned = script();
    await runAgent({ ...base, fsImpl: memFs({ 'src/scan.ts': SCAN }), providers: [planned], plan: true });
    expect(planned.calls.flat().some((m) => m.content === AGENT_FINISH_NUDGE)).toBe(false);
  });

  it('proportional verification: a one-file edit skips the test command unless tests were asked for', async () => {
    const runFor = async (instruction: string): Promise<string[]> => {
      const ran: string[] = [];
      const provider = new ScriptedProvider('m', [{ toolCalls: [EDIT] }, { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] }]);
      const result = await runAgent({
        graph: fixtureGraph(),
        root: '/repo',
        instruction,
        providers: [provider],
        // Every file the fixture graph maps exists, so the ladder's syntax rung
        // passes whatever the ranking puts in the capsule (it is fail-fast, and
        // a missing file would stop it before the command rung).
        fsImpl: memFs({ 'src/scan.ts': SCAN, 'src/report.ts': 'export function report() {}\n' }),
        run: (cmd) => {
          ran.push(cmd);
          return { stdout: 'ok', exitCode: 0 };
        },
        approve: async () => true,
        capsule: true,
        capsuleMode: 'compile',
        testCommand: 'npm test',
        noAudit: true,
      });
      expect(result.stopped).toBe('finished');
      return ran;
    };
    expect(await runFor('set the scanDir timeout to 30 in src/scan.ts')).toEqual([]);
    expect(await runFor('set the scanDir timeout to 30 in src/scan.ts and run the tests')).toEqual(['npm test']);
  });

  it('instructionAsksForTests recognises explicit test asks only', () => {
    expect(instructionAsksForTests('fix the guard and add a unit test')).toBe(true);
    expect(instructionAsksForTests('make sure lint passes')).toBe(true);
    expect(instructionAsksForTests('add a --timeout flag to the scan command')).toBe(false);
    expect(instructionAsksForTests('update the latest docs')).toBe(false);
  });
});

describe('plan-mode conclusions (regressions found by the parity harness)', () => {
  it('a negated edit ask is not an edit ask', () => {
    expect(instructionRequiresMutation('Plan a safe worktree support for non-git folders. Do not edit yet.')).toBe(false);
    expect(instructionRequiresMutation("Explain the loader; don't change any files")).toBe(false);
    expect(instructionRequiresMutation('without modifying the code, list the entry points')).toBe(false);
    // Still an edit ask when a real one remains next to the negation.
    expect(instructionRequiresMutation('Do not edit the tests; fix the bug in src/a.ts')).toBe(true);
    expect(instructionRequiresMutation('edit src/a.ts to raise the timeout')).toBe(true);
  });

  it('plan mode: finishing without writes is a clean finish, even for an edit-shaped ask', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('search_code', { query: 'timeout' }, 's1')] },
      { toolCalls: [tc('finish', { summary: 'Plan: change the timeout in src/scan.ts, then add a test.' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit src/scan.ts to raise the timeout',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': SCAN }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      plan: true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toMatch(/^Plan:/);
    expect(result.metrics?.trajectory.solved).toBe(true);
  });
});
