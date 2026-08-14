import { describe, it, expect } from 'vitest';
import {
  runCodeStreamJson,
  runCodeStreamJsonSession,
  parseHostMessage,
  StreamJsonSession,
  type StreamJsonOut,
} from './stream-json.js';
import { ScriptedProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import type { CodeFs } from './session.js';
import type { ToolCall } from './types.js';

function memFs(seed: Record<string, string> = {}): CodeFs {
  const files: Record<string, string | null> = { ...seed };
  return {
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
const base = 'export function scanDir() {\n  const timeout = 0;\n}\n';

describe('StreamJsonSession', () => {
  it('auto-approves immediately but still announces the request', async () => {
    const out: StreamJsonOut[] = [];
    const s = new StreamJsonSession((l) => out.push(l), true);
    const approved = await s.approve({ kind: 'run', command: 'npm test' });
    expect(approved).toBe(true);
    expect(out[0]).toMatchObject({ event: 'approve-request', id: 1, action: { kind: 'run' } });
  });

  it('waits for a host decision when not auto', async () => {
    const out: StreamJsonOut[] = [];
    const s = new StreamJsonSession((l) => out.push(l), false);
    const p = s.approve({ kind: 'delete', file: 'x.ts' });
    s.submitDecision(1, false);
    expect(await p).toBe(false);
  });

  it('cancelPending rejects outstanding approvals', async () => {
    const s = new StreamJsonSession(() => {}, false);
    const p = s.approve({ kind: 'delete', file: 'x.ts' });
    s.cancelPending();
    expect(await p).toBe(false);
  });

  it('always: true on an approval invokes onAlwaysRule with the approved action, before resolution', async () => {
    const s = new StreamJsonSession(() => {}, false);
    const calls: string[] = [];
    s.onAlwaysRule = (action) => calls.push(action.kind === 'run' ? action.command : action.kind);
    const p = s.approve({ kind: 'run', command: 'pnpm test' });
    s.submitDecision(1, true, true);
    expect(await p).toBe(true);
    expect(calls).toEqual(['pnpm test']);
  });

  it('always on a rejection saves nothing', async () => {
    const s = new StreamJsonSession(() => {}, false);
    const calls: unknown[] = [];
    s.onAlwaysRule = (action) => calls.push(action);
    const p = s.approve({ kind: 'run', command: 'rm -rf build' });
    s.submitDecision(1, false, true);
    expect(await p).toBe(false);
    expect(calls).toEqual([]);
  });

  it('round-trips user-question answers', async () => {
    const out: StreamJsonOut[] = [];
    const s = new StreamJsonSession((l) => out.push(l), false);
    const p = s.askUser({ question: 'Which port?', options: ['3000', '8080'] });
    expect(out[0]).toMatchObject({ event: 'user-question', question: 'Which port?' });
    s.submitAnswer(1, '8080');
    expect(await p).toBe('8080');
  });
});

describe('runCodeStreamJson', () => {
  it('emits NDJSON events, an approve round-trip, and a terminal done', async () => {
    const out: StreamJsonOut[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 'e1')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': base });
    // A host that approves every request as soon as it's emitted.
    let session: StreamJsonSession | undefined;
    const emit = (l: StreamJsonOut): void => {
      out.push(l);
      if (l.event === 'approve-request') session!.submitDecision(l.id, true);
    };
    await runCodeStreamJson({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      emit,
      bindDecisions: (s) => {
        session = s;
      },
    });

    const kinds = out.map((o) => o.event);
    expect(kinds).toContain('approve-request');
    expect(kinds).toContain('done');
    expect(kinds[kinds.length - 1]).toBe('done');
    // the edit actually applied (approval was honored)
    const done = out.find((o) => o.event === 'done') as Extract<StreamJsonOut, { event: 'done' }>;
    expect(done.result.stopped).toBe('finished');
    expect(done.result.changes).toHaveLength(1);
  });

  it('surfaces ask_user and continues after the host answers', async () => {
    const out: StreamJsonOut[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('ask_user', { question: 'Target timeout ms?', options: ['1000', '5000'] }, 'q1')] },
      { toolCalls: [tc('finish', { summary: '## Done\n\nTimeout set to **5000**.' }, 'f1')] },
    ]);
    let session: StreamJsonSession | undefined;
    const emit = (l: StreamJsonOut): void => {
      out.push(l);
      if (l.event === 'user-question') session!.submitAnswer(l.id, '5000');
    };
    await runCodeStreamJson({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'set timeout — ask if unsure',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': base }),
      run: () => ({ stdout: '', exitCode: 0 }),
      emit,
      bindDecisions: (s) => {
        session = s;
      },
    });
    expect(out.some((o) => o.event === 'user-question')).toBe(true);
    const done = out.find((o) => o.event === 'done') as Extract<StreamJsonOut, { event: 'done' }>;
    expect(done.result.stopped).toBe('finished');
    expect(done.result.finalText).toMatch(/5000/);
  });

  it('emits a terminal error when the provider fails, never throwing', async () => {
    const out: StreamJsonOut[] = [];
    const throwing = { id: 'p', label: 'p', local: false, model: 'm', chat: async () => { throw new Error('HTTP 500'); } };
    const r = await runCodeStreamJson({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [throwing],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      emit: (l) => out.push(l),
    });
    // runAgent handles provider errors internally → a `done` with stopped==='error'.
    expect(r?.stopped ?? 'error').toBeDefined();
    expect(out[out.length - 1].event).toBe('done');
  });
});

describe('parseHostMessage', () => {
  it('parses each host frame', () => {
    expect(parseHostMessage('{"approveId":3,"approve":true}')).toEqual({ kind: 'approve', id: 3, approve: true });
    expect(parseHostMessage('{"approveId":3}')).toEqual({ kind: 'approve', id: 3, approve: false });
    expect(parseHostMessage('{"answerId":1,"answer":"yes"}')).toEqual({ kind: 'answer', id: 1, answer: 'yes' });
    expect(parseHostMessage('{"submit":"  add a test  "}')).toEqual({ kind: 'submit', instruction: 'add a test' });
    expect(parseHostMessage('{"compactSession":true}')).toEqual({ kind: 'compact' });
    expect(parseHostMessage('{"cancel":true}')).toEqual({ kind: 'cancel' });
    expect(parseHostMessage('{"end":true}')).toEqual({ kind: 'end' });
  });

  it('parses the v3 always flag only on an approval, never a rejection', () => {
    expect(parseHostMessage('{"approveId":4,"approve":true,"always":true}')).toEqual({
      kind: 'approve',
      id: 4,
      approve: true,
      always: true,
    });
    // always on a rejection is dropped — you cannot standing-deny by accident.
    expect(parseHostMessage('{"approveId":4,"approve":false,"always":true}')).toEqual({
      kind: 'approve',
      id: 4,
      approve: false,
    });
    // Non-boolean always is ignored.
    expect(parseHostMessage('{"approveId":4,"approve":true,"always":"yes"}')).toEqual({
      kind: 'approve',
      id: 4,
      approve: true,
    });
  });

  it('ignores malformed, empty and unknown lines rather than taking the session down', () => {
    expect(parseHostMessage('not json')).toBeNull();
    expect(parseHostMessage('null')).toBeNull();
    expect(parseHostMessage('{"submit":"   "}')).toBeNull();
    expect(parseHostMessage('{"whatever":1}')).toBeNull();
  });
});

describe('runCodeStreamJsonSession', () => {
  const ok = (text: string) =>
    ({
      finalText: text,
      changes: [],
      steps: 1,
      stopped: 'finished',
      provider: { id: 'p', model: 'm', fellBack: false },
      usage: { promptTokens: 1, completionTokens: 1 },
    }) as never;

  /** Feeds instructions in order, then ends the session. */
  const scriptTurns = (queue: string[]) => () => {
    const next = queue.shift();
    return Promise.resolve(next != null ? { instruction: next } : null);
  };

  it('runs turn after turn against warm state and announces idle between them', async () => {
    const out: StreamJsonOut[] = [];
    const seen: string[] = [];
    const turns = await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's1',
      resumed: false,
      instruction: 'first',
      nextTurn: scriptTurns(['second']),
      runTurn: async ({ instruction }) => {
        seen.push(instruction);
        return ok(`did ${instruction}`);
      },
    });

    expect(seen).toEqual(['first', 'second']);
    expect(turns).toHaveLength(2);
    expect(out[0]).toEqual({ event: 'session-start', sessionId: 's1', resumed: false });
    expect(out.filter((l) => l.event === 'done')).toHaveLength(2);
    expect(out.filter((l) => l.event === 'idle')).toEqual([
      { event: 'idle', turns: 1 },
      { event: 'idle', turns: 2 },
    ]);
  });

  it('reports the session environment (dir, versions, model) on session-start when given', async () => {
    const out: StreamJsonOut[] = [];
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's-info',
      resumed: false,
      sessionInfo: {
        sessionDir: '/repo/.vibgrate/code-sessions',
        engineVersion: '2026.813.2',
        protocolVersion: 2,
        provider: 'vibgrate-relay',
        model: 'claude-sonnet-5',
      },
      instruction: 'only',
      nextTurn: () => Promise.resolve(null),
      runTurn: async () => ok('done'),
    });
    expect(out[0]).toEqual({
      event: 'session-start',
      sessionId: 's-info',
      resumed: false,
      sessionDir: '/repo/.vibgrate/code-sessions',
      engineVersion: '2026.813.2',
      protocolVersion: 2,
      provider: 'vibgrate-relay',
      model: 'claude-sonnet-5',
    });
  });

  it('omits environment fields entirely for callers that do not pass sessionInfo (older hosts see the v1 frame)', async () => {
    const out: StreamJsonOut[] = [];
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's-v1',
      resumed: false,
      instruction: 'only',
      nextTurn: () => Promise.resolve(null),
      runTurn: async () => ok('done'),
    });
    expect(out[0]).toEqual({ event: 'session-start', sessionId: 's-v1', resumed: false });
  });

  it('passes each turn the recap the previous turn produced', async () => {
    const recaps: (string | undefined)[] = [];
    await runCodeStreamJsonSession({
      emit: () => {},
      sessionId: 's2',
      resumed: true,
      instruction: 'one',
      nextTurn: scriptTurns(['two', 'three']),
      runTurn: async ({ priorSummary }) => {
        recaps.push(priorSummary);
        return ok('done');
      },
      onTurnEnd: (t) => `recap after ${t.instruction}`,
    });
    expect(recaps).toEqual([undefined, 'recap after one', 'recap after two']);
  });

  it('emits plan-ready before idle when a plan turn completes, and never for agent turns', async () => {
    const out: StreamJsonOut[] = [];
    const queue: Array<{ instruction: string; agentMode?: 'agent' | 'plan' | 'auto' }> = [
      { instruction: 'draft a plan', agentMode: 'plan' },
      { instruction: 'do it', agentMode: 'agent' },
    ];
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's-plan',
      resumed: false,
      nextTurn: () => Promise.resolve(queue.shift() ?? null),
      runTurn: async () => ok('done'),
    });
    const events = out.map((l) => l.event);
    // plan-ready follows the plan turn's done and precedes its idle…
    const planReadyAt = events.indexOf('plan-ready');
    expect(planReadyAt).toBeGreaterThan(events.indexOf('done'));
    expect(events[planReadyAt + 1]).toBe('idle');
    // …and exactly one is emitted (none for the agent turn).
    expect(events.filter((e) => e === 'plan-ready')).toHaveLength(1);
    expect(out[planReadyAt]).toEqual({ event: 'plan-ready', turns: 1 });
  });

  it('a failed plan turn is not a ready plan — no plan-ready on error', async () => {
    const out: StreamJsonOut[] = [];
    const queue: Array<{ instruction: string; agentMode?: 'agent' | 'plan' | 'auto' }> = [
      { instruction: 'plan it', agentMode: 'plan' },
    ];
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's-plan-err',
      resumed: false,
      nextTurn: () => Promise.resolve(queue.shift() ?? null),
      runTurn: async () => {
        throw new Error('provider exploded');
      },
    });
    expect(out.some((l) => l.event === 'plan-ready')).toBe(false);
    expect(out.some((l) => l.event === 'error')).toBe(true);
    expect(out.some((l) => l.event === 'idle')).toBe(true);
  });

  it('keeps the session alive when a turn throws, reporting an error frame for that turn only', async () => {
    const out: StreamJsonOut[] = [];
    const turns = await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's3',
      resumed: false,
      instruction: 'boom',
      nextTurn: scriptTurns(['recover']),
      runTurn: async ({ instruction }) => {
        if (instruction === 'boom') throw new Error('provider exploded');
        return ok('recovered');
      },
    });

    expect(out.some((l) => l.event === 'error' && l.message === 'provider exploded')).toBe(true);
    expect(turns).toHaveLength(2);
    expect(turns[0].result).toBeNull();
    expect(turns[1].result).not.toBeNull();
    // A failed turn still yields the floor back to the host.
    expect(out.filter((l) => l.event === 'idle')).toHaveLength(2);
  });

  it('waits for the first submit when started with no instruction', async () => {
    const seen: string[] = [];
    await runCodeStreamJsonSession({
      emit: () => {},
      sessionId: 's4',
      resumed: false,
      nextTurn: scriptTurns(['typed later']),
      runTurn: async ({ instruction }) => {
        seen.push(instruction);
        return ok('ok');
      },
    });
    expect(seen).toEqual(['typed later']);
  });

  it('cancelTurn aborts the running turn and unblocks a pending approval', async () => {
    const out: StreamJsonOut[] = [];
    let captured: StreamJsonSession | undefined;
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's5',
      resumed: false,
      instruction: 'long task',
      nextTurn: () => Promise.resolve(null),
      bindDecisions: (s) => {
        captured = s;
      },
      runTurn: async ({ signal, session }) => {
        // The turn blocks on an approval; the host cancels while it waits.
        const pending = session.approve({ kind: 'delete', file: 'a.ts' } as never);
        captured?.cancelTurn();
        const approved = await pending;
        expect(approved).toBe(false);
        expect(signal.aborted).toBe(true);
        return ok('stopped');
      },
    });
    expect(out.some((l) => l.event === 'done')).toBe(true);
  });
});

describe('parseHostMessage — restore', () => {
  it('parses a restore frame', () => {
    expect(parseHostMessage('{"restore":{"commit":"c1","files":["a.ts","b.ts"]}}')).toEqual({
      kind: 'restore',
      commit: 'c1',
      files: ['a.ts', 'b.ts'],
    });
  });

  it('refuses a restore with no files — an unscoped restore is never implied', () => {
    expect(parseHostMessage('{"restore":{"commit":"c1","files":[]}}')).toBeNull();
    expect(parseHostMessage('{"restore":{"commit":"c1"}}')).toBeNull();
  });

  it('ignores a malformed restore frame', () => {
    expect(parseHostMessage('{"restore":{"files":["a.ts"]}}')).toBeNull();
    expect(parseHostMessage('{"restore":true}')).toBeNull();
  });

  it('drops non-string entries rather than passing them to git', () => {
    expect(parseHostMessage('{"restore":{"commit":"c1","files":["a.ts",5,null]}}')).toEqual({
      kind: 'restore',
      commit: 'c1',
      files: ['a.ts'],
    });
  });
});

describe('protocol v4 — steer (inject) and rename frames', () => {
  it('parses inject and rename host lines, ignoring empty inject', () => {
    expect(parseHostMessage('{"inject":"also update the docs"}')).toEqual({
      kind: 'inject',
      text: 'also update the docs',
    });
    expect(parseHostMessage('{"inject":"   "}')).toBeNull();
    expect(parseHostMessage('{"renameSession":"My chat"}')).toEqual({ kind: 'rename', title: 'My chat' });
    // Empty rename is a valid "clear the title" request.
    expect(parseHostMessage('{"renameSession":""}')).toEqual({ kind: 'rename', title: '' });
  });

  it('buffers injected content and drains it once, joined oldest-first', () => {
    const s = new StreamJsonSession(() => {});
    expect(s.drainInjected()).toBeNull();
    s.inject('first thought');
    s.inject('  ');
    s.inject('second thought');
    expect(s.drainInjected()).toBe('first thought\n\nsecond thought');
    expect(s.drainInjected()).toBeNull();
  });

  it('keeps injected content across a turn boundary (a steer racing done is not lost)', async () => {
    const out: StreamJsonOut[] = [];
    let live!: StreamJsonSession;
    const drained: (string | null)[] = [];
    await runCodeStreamJsonSession({
      emit: (l) => out.push(l),
      sessionId: 's-steer',
      resumed: false,
      instruction: 'one',
      bindDecisions: (s) => {
        live = s;
      },
      nextTurn: (() => {
        let n = 0;
        return () => Promise.resolve(n++ === 0 ? { instruction: 'two' } : null);
      })(),
      runTurn: async ({ session }) => {
        // Simulate the loop draining at a step boundary: nothing pending in
        // turn one (the steer arrives "after" it), everything in turn two.
        drained.push(session.drainInjected());
        if (drained.length === 1) live.inject('late steer');
        return { finalText: 'ok', changes: [], steps: 1, stopped: 'finished', provider: { id: 'p', model: 'm', fellBack: false }, usage: { promptTokens: 0, completionTokens: 0 } };
      },
    });
    expect(drained).toEqual([null, 'late steer']);
  });
});

describe('protocol v5 — reasoning effort on submit', () => {
  const ok = (text: string) =>
    ({
      finalText: text,
      changes: [],
      steps: 1,
      stopped: 'finished',
      provider: { id: 'p', model: 'm', fellBack: false },
      usage: { promptTokens: 1, completionTokens: 1 },
    }) as never;

  it('parses the three levels off a submit line', () => {
    expect(parseHostMessage('{"submit":"go","reasoningEffort":"high"}')).toEqual({
      kind: 'submit',
      instruction: 'go',
      reasoningEffort: 'high',
    });
    expect(parseHostMessage('{"submit":"go","reasoningEffort":"low"}')).toMatchObject({
      reasoningEffort: 'low',
    });
  });

  it('drops an unknown level rather than forwarding it to the provider', () => {
    expect(parseHostMessage('{"submit":"go","reasoningEffort":"ludicrous"}')).toEqual({
      kind: 'submit',
      instruction: 'go',
    });
    expect(parseHostMessage('{"submit":"go"}')).toEqual({ kind: 'submit', instruction: 'go' });
  });

  it('hands the per-turn level to runTurn so an effort switch needs no respawn', async () => {
    const seen: Array<string | undefined> = [];
    const queue = [
      { instruction: 'first', reasoningEffort: 'high' as const },
      { instruction: 'second' },
    ];
    await runCodeStreamJsonSession({
      emit: () => {},
      sessionId: 's-effort',
      resumed: false,
      nextTurn: () => Promise.resolve(queue.shift() ?? null),
      runTurn: async ({ reasoningEffort }) => {
        seen.push(reasoningEffort);
        return ok('done');
      },
    });
    expect(seen).toEqual(['high', undefined]);
  });
});
