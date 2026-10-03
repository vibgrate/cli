import { describe, expect, it } from 'vitest';
import { compareDriftBudget, evaluateConfigDriftBudget } from './drift-budget-gate.js';

const file = '.vibgrate/config.yml';

describe('evaluateConfigDriftBudget', () => {
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

describe('compareDriftBudget', () => {
  it('does not fail when the score is absent', () => {
    expect(compareDriftBudget(null, 0)).toEqual({
      exitCode: 0,
      message: 'DriftScore is absent; --drift-budget 0 was not compared.',
    });
  });

  it('passes a measured zero without treating it as absent', () => {
    expect(compareDriftBudget(0, 0)).toEqual({ exitCode: 0, message: null });
    expect(compareDriftBudget(0, 30)).toEqual({ exitCode: 0, message: null });
  });

  it('fails when a measured score is above the budget', () => {
    expect(compareDriftBudget(44, 40)).toEqual({
      exitCode: 2,
      message: 'Failing fitness function: DriftScore 44/100 exceeds budget 40.',
    });
  });
});
