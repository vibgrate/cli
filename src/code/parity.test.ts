import { describe, it, expect } from 'vitest';
import { median, PARITY_PROMPTS, renderParityMarkdown, summarizeParity, type ParityArm, type ParityRun } from './parity.js';

const arms: ParityArm[] = [
  { name: 'baseline', args: [] },
  { name: 'grok', args: ['--provider', 'grok-build'] },
];

function run(arm: string, promptId: string, over: Partial<ParityRun> = {}): ParityRun {
  const edit = promptId !== 'plan-worktree';
  return {
    arm,
    promptId,
    run: 1,
    ok: true,
    turnMs: 10_000,
    startupMs: 1_000,
    timeToFirstTokenMs: 800,
    steps: 4,
    toolCalls: 5,
    stopReason: 'finished',
    activityLines: 1,
    changesCards: edit ? 1 : 0,
    permissionCards: 0,
    concludedCleanly: true,
    filesChanged: edit ? ['src/a.ts'] : [],
    planViolation: false,
    error: null,
    exitCode: 0,
    ...over,
  };
}

const allPrompts = (arm: string, over: Partial<ParityRun> = {}): ParityRun[] => PARITY_PROMPTS.map((p) => run(arm, p.id, over));

describe('parity verdict', () => {
  it('the spec prompt set is the four prompts, the last plan-only', () => {
    expect(PARITY_PROMPTS.map((p) => p.id)).toEqual(['timeout-flag', 'extract-gate', 'no-progress-retry', 'plan-worktree']);
    expect(PARITY_PROMPTS[3]).toMatchObject({ mode: 'plan', expectsEdit: false });
  });

  it('median handles even/odd/absent', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([null, null])).toBeNull();
  });

  it('an arm within 20% latency, same conclusion rate and no noisier passes', () => {
    const s = summarizeParity([...allPrompts('baseline'), ...allPrompts('grok', { turnMs: 11_900 })], arms, 'baseline');
    expect(s.comparisons[0]).toMatchObject({ arm: 'grok', latencyPass: true, conclusionPass: true, quietPass: true, shapePass: true, pass: true });
    expect(s.comparisons[0].turnRatio).toBeCloseTo(1.19, 2);
    expect(s.pass).toBe(true);
  });

  it('more than 20% slower fails latency', () => {
    const s = summarizeParity([...allPrompts('baseline'), ...allPrompts('grok', { turnMs: 12_100 })], arms, 'baseline');
    expect(s.comparisons[0]).toMatchObject({ latencyPass: false, pass: false });
    expect(s.pass).toBe(false);
  });

  it('a lower clean-conclusion rate beyond 20 points fails conclusion', () => {
    const grok = allPrompts('grok');
    grok[0] = { ...grok[0], concludedCleanly: false, stopReason: 'max-steps' };
    grok[1] = { ...grok[1], concludedCleanly: false, stopReason: 'no-progress' };
    const s = summarizeParity([...allPrompts('baseline'), ...grok], arms, 'baseline');
    expect(s.comparisons[0].cleanRateDelta).toBeCloseTo(-0.5);
    expect(s.comparisons[0].conclusionPass).toBe(false);
  });

  it('more activity lines than the baseline fails quietness; > 2 lines on an edit is a shape violation', () => {
    const s = summarizeParity([...allPrompts('baseline'), ...allPrompts('grok', { activityLines: 3 })], arms, 'baseline');
    expect(s.comparisons[0]).toMatchObject({ quietPass: false, shapePass: false, pass: false });
    expect(s.arms[1].shapeViolations[0]).toMatch(/timeout-flag#1: 3 activity lines/);
  });

  it('a missing Changes card on an edit, or a plan prompt that writes, fails shape', () => {
    const grok = allPrompts('grok');
    grok[0] = { ...grok[0], changesCards: 0 };
    grok[3] = { ...grok[3], filesChanged: ['x.ts'], planViolation: true };
    const s = summarizeParity([...allPrompts('baseline'), ...grok], arms, 'baseline');
    expect(s.arms[1].planViolations).toBe(1);
    expect(s.arms[1].shapeViolations.some((v) => /0 Changes cards/.test(v))).toBe(true);
    expect(s.comparisons[0].shapePass).toBe(false);
  });

  it('no baseline runs → no pass', () => {
    const s = summarizeParity(allPrompts('grok'), arms, 'baseline');
    expect(s.pass).toBe(false);
  });

  it('the report flags simulated arms and lists every run', () => {
    const simArms = arms.map((a) => ({ ...a, simulated: true }));
    const runs = [...allPrompts('baseline'), ...allPrompts('grok')];
    const md = renderParityMarkdown(summarizeParity(runs, simArms, 'baseline'), runs);
    expect(md).toContain('Simulated arms present');
    expect(md).toContain('| grok | 1.00 | pass |');
    expect(md.split('\n').filter((l) => /^\| (baseline|grok) \| (timeout-flag|extract-gate|no-progress-retry|plan-worktree) \|/.test(l))).toHaveLength(8);
  });
});
