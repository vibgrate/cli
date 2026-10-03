import { describe, expect, it } from 'vitest';
import { driftBudgetFlagDecision, evaluateConfigDriftBudget } from './drift-budget-gate.js';

const file = '.vibgrate/config.yml';

describe('driftBudgetFlagDecision', () => {
  it('does not compare an absent score, even against a budget of 0', () => {
    expect(driftBudgetFlagDecision(null, 0)).toEqual({
      exitCode: 0,
      message: 'DriftScore is absent; --drift-budget was not applied.',
    });
  });

  it('keeps a measured zero inside the budget and fails a real overrun', () => {
    expect(driftBudgetFlagDecision(0, 0)).toEqual({ exitCode: 0, message: null });
    expect(driftBudgetFlagDecision(41, 40).exitCode).toBe(2);
    expect(driftBudgetFlagDecision(41, 40).message).toContain('41/100');
  });
});

describe('evaluateConfigDriftBudget', () => {
  it('does not apply the budget when DriftScore is absent', () => {
    const gate = evaluateConfigDriftBudget({
      raw: { mode: 'enforce', maxScore: 0 },
      configFile: file,
      headScore: null,
      baseScore: null,
    });
    expect(gate.exitCode).toBe(0);
    expect(gate.verdict).toBeNull();
    expect(gate.lines[0]?.text).toContain('DriftScore is absent');
  });

  it('does nothing when the config has no driftBudget', () => {
    expect(evaluateConfigDriftBudget({ raw: undefined, configFile: file, headScore: 90, baseScore: null })).toEqual({
      exitCode: 0,
      lines: [],
      verdict: null,
    });
  });

  it('exits 2 on an enforced breach and says how to pass', () => {
    const gate = evaluateConfigDriftBudget({ raw: { mode: 'enforce', maxScore: 40 }, configFile: file, headScore: 44, baseScore: null });
    expect(gate.exitCode).toBe(2);
    expect(gate.lines).toContainEqual({
      level: 'error',
      text: 'drift budget (enforce): DriftScore 44 is above the budget of 40. Lower it by 4 points to pass.',
    });
  });

  it('warns without failing in warn mode, and names the switch', () => {
    const gate = evaluateConfigDriftBudget({ raw: { maxScore: 40 }, configFile: file, headScore: 44, baseScore: null });
    expect(gate.exitCode).toBe(0);
    expect(gate.lines[0]?.level).toBe('warn');
    expect(gate.lines.at(-1)?.text).toContain('set driftBudget.mode: enforce in .vibgrate/config.yml');
  });

  it('needs --baseline for a worsening limit and never fails without one', () => {
    const gate = evaluateConfigDriftBudget({ raw: { mode: 'enforce', maxWorseningPercent: 0 }, configFile: file, headScore: 60, baseScore: null });
    expect(gate.exitCode).toBe(0);
    expect(gate.lines[0]?.text).toContain('Run with --baseline to compare.');
  });

  it('leaves agent limits to the GitHub App check', () => {
    const gate = evaluateConfigDriftBudget({
      raw: { mode: 'enforce', agents: { maxWorseningPercent: 0 } },
      configFile: file,
      headScore: 60,
      baseScore: 10,
    });
    expect(gate).toMatchObject({ exitCode: 0, lines: [] });
  });

  it('reports an invalid budget without failing the scan', () => {
    const gate = evaluateConfigDriftBudget({ raw: { mode: 'enforce', maxscore: 40 }, configFile: file, headScore: 90, baseScore: null });
    expect(gate.exitCode).toBe(0);
    expect(gate.lines.map((l) => l.text)).toEqual([
      'driftBudget in .vibgrate/config.yml was not applied:',
      '  driftBudget.maxscore is not a known setting.',
    ]);
  });
});
