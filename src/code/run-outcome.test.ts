import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RunOutcomeRecorder,
  RUN_OUTCOME_SCHEMA,
  classifyInstructionKind,
  classifyEditKind,
  shapeOfAction,
  newOneShotRunId,
  turnRunId,
  type RunOutcomeEvent,
} from './run-outcome.js';
import type { StreamJsonOut } from './stream-json.js';
import type { AgentResult } from './agent.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-run-outcome-'));
}

function readEvents(root: string): RunOutcomeEvent[] {
  const file = path.join(root, '.vibgrate', 'run-outcomes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunOutcomeEvent);
}

const fakeResult = (over: Partial<AgentResult> = {}): AgentResult =>
  ({
    finalText: 'done',
    changes: [],
    steps: 1,
    stopped: 'completed',
    provider: { id: 'p', model: 'm', fellBack: false },
    usage: { promptTokens: 100, completionTokens: 50 },
    ...over,
  }) as AgentResult;

describe('classifyInstructionKind', () => {
  it('recognises the routeFix upgrade template', () => {
    expect(classifyInstructionKind('Upgrade left-pad from 1.0.0 to 2.0.0: update the manifest')).toBe('upgrade');
  });
  it('recognises a CVE fix instruction', () => {
    expect(classifyInstructionKind('Patch the CVE in this dependency')).toBe('fix-vuln');
  });
  it('recognises refactor and feature keywords', () => {
    expect(classifyInstructionKind('refactor the auth module')).toBe('refactor');
    expect(classifyInstructionKind('add a new export button')).toBe('feature');
  });
  it('falls back to other', () => {
    expect(classifyInstructionKind('what does this function do')).toBe('other');
  });
  it('trusts an explicit fromFinding over the heuristic', () => {
    expect(classifyInstructionKind('do something', 'fix-vuln')).toBe('fix-vuln');
  });
});

describe('classifyEditKind', () => {
  it('classifies manifests, lockfiles, docs, tests, config, and code', () => {
    expect(classifyEditKind('package.json')).toBe('manifest');
    expect(classifyEditKind('sub/package-lock.json')).toBe('lockfile');
    expect(classifyEditKind('docs/guide.md')).toBe('docs');
    expect(classifyEditKind('src/foo.test.ts')).toBe('test');
    expect(classifyEditKind('src/__tests__/bar.ts')).toBe('test');
    expect(classifyEditKind('.eslintrc.yaml')).toBe('config');
    expect(classifyEditKind('src/index.ts')).toBe('code');
  });
});

describe('shapeOfAction', () => {
  it('counts diff lines for an edit action, excluding the +++/--- headers', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@\n-old line\n+new line 1\n+new line 2\n';
    const shape = shapeOfAction({ kind: 'edit', file: 'src/x.ts', diff });
    expect(shape).toEqual({ language: 'ts', linesAdded: 2, linesRemoved: 1, kind: 'code' });
  });
  it('returns null for run and tool actions (not file edits)', () => {
    expect(shapeOfAction({ kind: 'run', command: 'npm test' })).toBeNull();
    expect(shapeOfAction({ kind: 'tool', name: 'x', args: {} })).toBeNull();
  });
  it('aggregates a multi-file patch and falls back to code when kinds differ', () => {
    const shape = shapeOfAction({
      kind: 'patch',
      files: [
        { file: 'package.json', op: 'edit', diff: '+one\n' },
        { file: 'src/a.ts', op: 'edit', diff: '+two\n+three\n-four\n' },
      ],
    });
    expect(shape).toEqual({ language: null, linesAdded: 3, linesRemoved: 1, kind: 'code' });
  });
});

describe('RunOutcomeRecorder', () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeRecorder(auto = false) {
    let t = 1000;
    return new RunOutcomeRecorder(
      root,
      'repo-abc',
      'main',
      { provider: 'openrouter', model: 'x/y' },
      'L0',
      auto,
      () => (t += 10),
      'test-salt',
    );
  }

  it('writes a schema-tagged run_started event with a hashed, never-plaintext instruction', () => {
    const rec = makeRecorder();
    rec.beginRun('r1', 'Upgrade left-pad from 1.0.0 to 2.0.0');
    const [ev] = readEvents(root);
    expect(ev!.schema).toBe(RUN_OUTCOME_SCHEMA);
    expect(ev!.event).toBe('run_started');
    expect(JSON.stringify(ev)).not.toContain('left-pad');
    expect((ev as { instructionKind: string }).instructionKind).toBe('upgrade');
    expect((ev as { baseline: unknown }).baseline).toEqual({ driftScore: null, scoreMode: null, advisories: null });
  });

  it('records a full approve → decision → done cycle with correct tallies', () => {
    const rec = makeRecorder(false);
    rec.beginRun('r1', 'refactor things');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'edit', file: 'src/a.ts', diff: '+x\n' } } as StreamJsonOut);
    rec.noteDecision(1, true);
    rec.observe({ event: 'approve-request', id: 2, action: { kind: 'edit', file: 'src/b.ts', diff: '+y\n' } } as StreamJsonOut);
    rec.noteDecision(2, false);
    rec.observe({ event: 'event', type: 'verify', command: 'npm test', passed: true } as StreamJsonOut);
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);

    const events = readEvents(root);
    const kinds = events.map((e) => e.event);
    expect(kinds).toEqual(['run_started', 'edit_proposed', 'edit_decision', 'edit_proposed', 'edit_decision', 'run_completed']);

    const decisions = events.filter((e) => e.event === 'edit_decision') as Extract<RunOutcomeEvent, { event: 'edit_decision' }>[];
    expect(decisions[0]!.decision).toBe('approved');
    expect(decisions[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decisions[1]!.decision).toBe('rejected');

    const completed = events[events.length - 1] as Extract<RunOutcomeEvent, { event: 'run_completed' }>;
    expect(completed.outcome).toBe('done');
    expect(completed.edits).toEqual({ proposed: 2, approved: 1, rejected: 1, autoApproved: 0 });
    expect(completed.verifyOk).toBe(true);
    expect(completed.verify).toBeNull();
    expect(completed.tokens).toEqual({ input: 100, output: 50 });
  });

  it('records auto-approved edits with zero latency and no host round-trip needed', () => {
    const rec = makeRecorder(true);
    rec.beginRun('r1', 'add a feature');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'create', file: 'src/new.ts', bytes: 10 } } as StreamJsonOut);
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);

    const events = readEvents(root);
    const decision = events.find((e) => e.event === 'edit_decision') as Extract<RunOutcomeEvent, { event: 'edit_decision' }>;
    expect(decision.decision).toBe('auto-approved');
    expect(decision.latencyMs).toBe(0);
    const completed = events.find((e) => e.event === 'run_completed') as Extract<RunOutcomeEvent, { event: 'run_completed' }>;
    expect(completed.edits).toEqual({ proposed: 1, approved: 0, rejected: 0, autoApproved: 1 });
  });

  it('never emits an edit_proposed for run/tool actions', () => {
    const rec = makeRecorder(false);
    rec.beginRun('r1', 'run the tests');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'run', command: 'npm test' } } as StreamJsonOut);
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);
    const events = readEvents(root);
    expect(events.map((e) => e.event)).toEqual(['run_started', 'run_completed']);
    const completed = events[1] as Extract<RunOutcomeEvent, { event: 'run_completed' }>;
    expect(completed.edits).toEqual({ proposed: 0, approved: 0, rejected: 0, autoApproved: 0 });
  });

  it('records an error outcome with null tokens and whatever tallies accrued', () => {
    const rec = makeRecorder(false);
    rec.beginRun('r1', 'do a thing');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'edit', file: 'a.ts', diff: '+x\n' } } as StreamJsonOut);
    rec.observe({ event: 'error', message: 'model call failed' } as StreamJsonOut);
    const events = readEvents(root);
    const completed = events[events.length - 1] as Extract<RunOutcomeEvent, { event: 'run_completed' }>;
    expect(completed.outcome).toBe('error');
    expect(completed.tokens).toBeNull();
    expect(completed.edits.proposed).toBe(1);
  });

  it('cancelPending rejects any edit still awaiting a human decision', () => {
    const rec = makeRecorder(false);
    rec.beginRun('r1', 'do a thing');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'edit', file: 'a.ts', diff: '+x\n' } } as StreamJsonOut);
    rec.cancelPending();
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);
    const events = readEvents(root);
    const decision = events.find((e) => e.event === 'edit_decision') as Extract<RunOutcomeEvent, { event: 'edit_decision' }>;
    expect(decision.decision).toBe('rejected');
    const completed = events.find((e) => e.event === 'run_completed') as Extract<RunOutcomeEvent, { event: 'run_completed' }>;
    expect(completed.edits.rejected).toBe(1);
  });

  it('scopes tallies per runId so a second turn in a session starts clean', () => {
    const rec = makeRecorder(false);
    rec.beginRun(turnRunId('s1', 1), 'first task');
    rec.observe({ event: 'approve-request', id: 1, action: { kind: 'edit', file: 'a.ts', diff: '+x\n' } } as StreamJsonOut);
    rec.noteDecision(1, true);
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);

    rec.beginRun(turnRunId('s1', 2), 'second task');
    rec.observe({ event: 'done', result: fakeResult() } as StreamJsonOut);

    const events = readEvents(root);
    const completions = events.filter((e) => e.event === 'run_completed') as Extract<RunOutcomeEvent, { event: 'run_completed' }>[];
    expect(completions[0]!.runId).toBe('s1#1');
    expect(completions[0]!.edits.approved).toBe(1);
    expect(completions[1]!.runId).toBe('s1#2');
    expect(completions[1]!.edits).toEqual({ proposed: 0, approved: 0, rejected: 0, autoApproved: 0 });
  });

  it('ignores an unrecognised decision id and a decision with no active run', () => {
    const rec = makeRecorder(false);
    rec.beginRun('r1', 'do a thing');
    expect(() => rec.noteDecision(999, true)).not.toThrow();
    expect(readEvents(root)).toHaveLength(1); // only run_started
  });
});

describe('run id helpers', () => {
  it('mints distinct one-shot ids and stable turn ids', () => {
    expect(newOneShotRunId()).not.toBe(newOneShotRunId());
    expect(turnRunId('sess', 3)).toBe('sess#3');
  });
});
