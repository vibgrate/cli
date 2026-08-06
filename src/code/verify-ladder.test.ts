import { describe, it, expect, vi } from 'vitest';
import { compileVerificationLadder, runVerificationLadder } from './verify-ladder.js';
import type { VerificationPlan } from './capsule.js';

const plan = (over: Partial<VerificationPlan> = {}): VerificationPlan => ({
  syntaxFiles: ['src/a.ts', 'src/b.ts'],
  suggestedTests: ['testFoo'],
  notes: ['prefer unit tests'],
  ...over,
});

describe('compileVerificationLadder', () => {
  it('is ordered and deterministic', () => {
    const a = compileVerificationLadder(plan(), { testCommand: 'npm test' });
    const b = compileVerificationLadder(plan(), { testCommand: 'npm test' });
    expect(a).toEqual(b);
    expect(a.map((s) => s.kind)).toEqual(['note', 'syntax', 'command', 'note']);
    expect(a.find((s) => s.kind === 'command')).toMatchObject({ command: 'npm test' });
  });

  it('includes patch command targets', () => {
    const steps = compileVerificationLadder(plan({ notes: [], suggestedTests: [] }), {
      patchTargets: [{ kind: 'typecheck', target: 'tsc -p .' }],
    });
    expect(steps.some((s) => s.kind === 'command' && s.command === 'tsc -p .')).toBe(true);
  });
});

describe('runVerificationLadder', () => {
  it('passes when syntax files exist and command exits 0', async () => {
    const files: Record<string, string> = { 'src/a.ts': 'x', 'src/b.ts': 'y' };
    const run = vi.fn(() => ({ stdout: 'ok', exitCode: 0 }));
    const steps = compileVerificationLadder(plan({ notes: [], suggestedTests: [] }), { testCommand: 'npm test' });
    const result = await runVerificationLadder(steps, { readFile: (f) => files[f] ?? null, run });
    expect(result.ok).toBe(true);
    expect(result.ranCommands).toBe(true);
    expect(run).toHaveBeenCalledWith('npm test');
  });

  it('fails fast on missing syntax file', async () => {
    const run = vi.fn(() => ({ stdout: '', exitCode: 0 }));
    const steps = compileVerificationLadder(plan({ notes: [], suggestedTests: [] }), { testCommand: 'npm test' });
    const result = await runVerificationLadder(steps, { readFile: (f) => (f === 'src/a.ts' ? 'x' : null), run });
    expect(result.ok).toBe(false);
    expect(result.steps.some((s) => !s.ok && s.message.includes('missing'))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails when the test command exits non-zero', async () => {
    const files: Record<string, string> = { 'src/a.ts': 'x', 'src/b.ts': 'y' };
    const steps = compileVerificationLadder(plan({ notes: [], suggestedTests: [] }), { testCommand: 'npm test' });
    const result = await runVerificationLadder(steps, {
      readFile: (f) => files[f] ?? null,
      run: () => ({ stdout: 'FAIL', exitCode: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.message).toContain('exit 1');
  });
});
