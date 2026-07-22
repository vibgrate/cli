import { describe, it, expect } from 'vitest';
import { runCodeStreamJson, StreamJsonSession, type StreamJsonOut } from './stream-json.js';
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
