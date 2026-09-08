import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../compress/types.js';
import { TrafficLearner, keyTag } from './learner.js';
import { MemoryStore } from './store.js';

let dir: string;
let store: MemoryStore;
let clock = 1_700_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-learner-'));
  store = new MemoryStore({ cwd: dir, env: { VG_MEMORY_DIR: path.join(dir, 'mem') }, git: (_a, cwd) => cwd, now: () => clock });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function recovery(n: number): Message[] {
  return [
    { role: 'user', content: `turn ${n}: run tests` },
    { role: 'assistant', content: [{ type: 'tool_use', id: `f${n}`, name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `f${n}`, content: 'sh: npm: command not found', is_error: true }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: `s${n}`, name: 'Bash', input: { command: 'pnpm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `s${n}`, content: 'Tests 3 passed PASSED' }] },
  ];
}

describe('TrafficLearner', () => {
  it('promotes a pattern only after minEvidence distinct observations', () => {
    const learner = new TrafficLearner(store, { minEvidence: 3, now: () => clock });
    expect(learner.observe(recovery(1))).toEqual([]);
    expect(learner.observe(recovery(2))).toEqual([]);
    expect(learner.pendingPatterns().find((p) => p.text.startsWith('Command `npm test`'))).toMatchObject({ count: 2, text: 'Command `npm test` fails (command_not_found). Use `pnpm test` instead.' });
    const promoted = learner.observe(recovery(3));
    const texts = promoted.map((m) => m.text);
    expect(texts).toContain('Command `npm test` fails (command_not_found). Use `pnpm test` instead.');
    expect(texts).toContain('Working test command: `pnpm test`');
    const gotcha = promoted.find((m) => m.kind === 'gotcha');
    expect(gotcha).toMatchObject({ source: 'learned', evidence: 3, scope: 'project' });
    expect(gotcha?.tags).toContain(keyTag('error_recovery|Bash|npm test|pnpm test'));
    expect(learner.stats()).toMatchObject({ observed: 3, promoted: 2, pending: 0 });
  });

  it('re-observing the same conversation is a no-op (proxies resend history)', () => {
    const learner = new TrafficLearner(store, { minEvidence: 2 });
    const convo = recovery(1);
    learner.observe(convo);
    learner.observe(convo);
    learner.observe(convo);
    expect(store.list()).toEqual([]);
    expect(learner.pendingPatterns()[0].count).toBe(1);
    // A genuinely new observation appended to the same history counts.
    learner.observe([...convo, ...recovery(2)]);
    expect(store.list().map((m) => m.kind).sort()).toEqual(['command', 'gotcha']);
  });

  it('bumps evidence on the stored row once promoted, and hydrates from disk', () => {
    const learner = new TrafficLearner(store, { minEvidence: 1 });
    const [first] = learner.observe(recovery(1)).filter((m) => m.kind === 'gotcha');
    expect(first.evidence).toBe(1);
    const again = learner.observe(recovery(2)).find((m) => m.kind === 'gotcha');
    expect(again?.id).toBe(first.id);
    expect(again?.evidence).toBe(2);
    expect(store.list({ kinds: ['gotcha'] })).toHaveLength(1);
    // A fresh learner over the same store knows the pattern is already promoted.
    const fresh = new TrafficLearner(store, { minEvidence: 5 });
    const bumped = fresh.observe(recovery(3)).find((m) => m.kind === 'gotcha');
    expect(bumped?.id).toBe(first.id);
    expect(bumped?.evidence).toBe(3);
  });

  it('extracts user corrections with evidence and honours VG_MEMORY_MIN_EVIDENCE', () => {
    const s = new MemoryStore({ cwd: dir, env: { VG_MEMORY_DIR: path.join(dir, 'mem'), VG_MEMORY_MIN_EVIDENCE: '2' }, git: (_a, cwd) => cwd, now: () => clock });
    const learner = new TrafficLearner(s);
    expect(learner.minEvidence).toBe(2);
    learner.observe([{ role: 'user', content: "Don't use npm here, always use pnpm." }]);
    const out = learner.observe([{ role: 'user', content: 'Something else' }, { role: 'user', content: "don't use npm here, always use pnpm." }]);
    expect(out.map((m) => m.text)).toEqual(["User preference: don't use npm here, always use pnpm"]);
    expect(out[0].kind).toBe('preference');
  });

  it('drops contradictory path corrections at promotion time', () => {
    const learner = new TrafficLearner(store, { minEvidence: 1 });
    const pair = (n: number, a: string, b: string): Message[] => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `e${n}`, name: 'Read', input: { file_path: a } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `e${n}`, content: 'Error: ENOENT no such file', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `o${n}`, name: 'Read', input: { file_path: b } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `o${n}`, content: 'export {}' }] },
    ];
    const out = learner.observe([...pair(1, '/p/confg.ts', '/p/config.ts'), ...pair(2, '/p/config.ts', '/p/confg.ts')]);
    expect(out.filter((m) => m.kind === 'gotcha')).toEqual([]);
    expect(store.list({ kinds: ['gotcha'] })).toEqual([]);
  });

  it('writes to user scope when the project is unresolved', () => {
    const noProject = new MemoryStore({ cwd: dir, env: { VG_MEMORY_DIR: path.join(dir, 'mem') }, git: () => null, now: () => clock });
    const learner = new TrafficLearner(noProject, { minEvidence: 1 });
    const out = learner.observe(recovery(1));
    expect(out.every((m) => m.scope === 'user')).toBe(true);
  });
});
