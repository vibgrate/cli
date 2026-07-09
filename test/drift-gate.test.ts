import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLICY,
  loadPolicy,
  planSteps,
  evaluateExit,
  evaluateCurrency,
  runGate,
  overallExit,
} from '../scripts/check-drift-gate.mjs';
import { ExitCode } from '../src/util/exit.js';
import { normalizeStandards, checkStandards } from '../src/engine/standards.js';
import type { DepRecord } from '../src/engine/drift.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Unit coverage for the pre-publish dependency-drift gate
 * (scripts/check-drift-gate.mjs). The gate spawns the built CLI in production,
 * but every decision is a pure function here, exercised with injected results —
 * so these tests are deterministic and need no build, network, or child process.
 */

describe('drift gate — loadPolicy', () => {
  it('falls back to strict defaults when the config is missing/unreadable', () => {
    const policy = loadPolicy(PKG_ROOT, () => {
      throw new Error('ENOENT');
    });
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it('merges known keys from config over the defaults', () => {
    const policy = loadPolicy(PKG_ROOT, () => JSON.stringify({ driftBudget: 12, currency: 'minor' }));
    expect(policy.driftBudget).toBe(12);
    expect(policy.currency).toBe('minor');
    // untouched keys keep their defaults
    expect(policy.worseningPercent).toBe(DEFAULT_POLICY.worseningPercent);
  });

  it('ignores unknown keys so a config typo cannot smuggle in behaviour', () => {
    const policy = loadPolicy(PKG_ROOT, () => JSON.stringify({ driftBudget: 5, bogus: 'nope' }));
    expect(policy.driftBudget).toBe(5);
    expect((policy as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('never silently weakens the gate on malformed JSON (uses defaults)', () => {
    const policy = loadPolicy(PKG_ROOT, () => '{ not json');
    expect(policy).toEqual(DEFAULT_POLICY);
  });
});

describe('drift gate — planSteps', () => {
  const policy = { ...DEFAULT_POLICY, currency: 'major', scanExclude: ['**/test/**'], driftBudget: 30 };

  it('offline runs only the deterministic standards gate', () => {
    const steps = planSteps({ policy, online: false, baselineExists: false });
    expect(steps.map((s) => s.id)).toEqual(['standards']);
    expect(steps[0].online).toBe(false);
  });

  it('online adds currency + budget (both registry-dependent)', () => {
    const steps = planSteps({ policy, online: true, baselineExists: false });
    expect(steps.map((s) => s.id)).toEqual(['standards', 'currency', 'budget']);
    const budget = steps.find((s) => s.id === 'budget')!;
    expect(budget.args).toContain('--drift-budget');
    expect(budget.args).toContain('30');
    // scanExclude is threaded through as repeated --exclude flags
    expect(budget.args.filter((a: string) => a === '--exclude')).toHaveLength(1);
    expect(budget.args).toContain('**/test/**');
    // no baseline → no regression flags
    expect(budget.args).not.toContain('--baseline');
  });

  it('adds the worsening-vs-baseline gate only when a baseline exists', () => {
    const steps = planSteps({ policy, online: true, baselineExists: true });
    const budget = steps.find((s) => s.id === 'budget')!;
    expect(budget.args).toContain('--baseline');
    expect(budget.args).toContain('--drift-worsening');
    expect(budget.args).toContain(String(policy.worseningPercent));
  });

  it('drops the currency step when currency is disabled', () => {
    const steps = planSteps({ policy: { ...policy, currency: null }, online: true, baselineExists: false });
    expect(steps.map((s) => s.id)).toEqual(['standards', 'budget']);
  });
});

describe('drift gate — evaluateExit', () => {
  it('maps exit codes: 0 pass, 2 fail, else error (fail-closed)', () => {
    expect(evaluateExit({ code: 0, stdout: 'ok', stderr: '' }).status).toBe('pass');
    expect(evaluateExit({ code: 2, stdout: '', stderr: 'budget exceeded' })).toMatchObject({
      status: 'fail',
      detail: 'budget exceeded',
    });
    expect(evaluateExit({ code: 1, stdout: '', stderr: 'boom' }).status).toBe('error');
    expect(evaluateExit({ code: 5, stdout: '', stderr: 'usage' }).status).toBe('error');
  });
});

describe('drift gate — evaluateCurrency', () => {
  const drift = (records: Array<Partial<DepRecord>>) => ({
    code: 0,
    stdout: JSON.stringify({ records }),
    stderr: '',
  });

  it('passes when nothing drifts past the threshold', () => {
    const res = evaluateCurrency(drift([{ name: 'a', drift: 'patch' }, { name: 'b', drift: 'minor' }]), {
      currency: 'major',
      allow: {},
    });
    expect(res.status).toBe('pass');
  });

  it('fails on an un-allowed major and names the offender', () => {
    const res = evaluateCurrency(
      drift([{ name: 'typescript', drift: 'major', installed: '6.0.3', latest: '7.0.2' }]),
      { currency: 'major', allow: {} },
    );
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('typescript');
    expect(res.detail).toContain('7.0.2');
  });

  it('passes a major that is explicitly allowed at that level', () => {
    const res = evaluateCurrency(
      drift([{ name: 'typescript', drift: 'major', installed: '6.0.3', latest: '7.0.2' }]),
      { currency: 'major', allow: { typescript: 'major' } },
    );
    expect(res.status).toBe('pass');
  });

  it('a minor allowance does NOT excuse a major drift', () => {
    const res = evaluateCurrency(drift([{ name: 'x', drift: 'major' }]), {
      currency: 'major',
      allow: { x: 'minor' },
    });
    expect(res.status).toBe('fail');
  });

  it('at minor threshold, minors become offenders (unless allowed)', () => {
    const records = [{ name: 'p', drift: 'minor' }, { name: 'q', drift: 'minor' }];
    expect(evaluateCurrency(drift(records), { currency: 'minor', allow: {} }).status).toBe('fail');
    expect(evaluateCurrency(drift(records), { currency: 'minor', allow: { p: 'minor', q: 'minor' } }).status).toBe('pass');
  });

  it('ignores unknown/current deps — vendored fixtures never trip the gate', () => {
    const res = evaluateCurrency(drift([{ name: 'fixture-dep', drift: 'unknown' }, { name: 'ok', drift: 'current' }]), {
      currency: 'major',
      allow: {},
    });
    expect(res.status).toBe('pass');
  });

  it('errors (never silently passes) on unparseable output or a crashed command', () => {
    expect(evaluateCurrency({ code: 0, stdout: 'not json', stderr: '' }, { currency: 'major', allow: {} }).status).toBe('error');
    expect(evaluateCurrency({ code: 3, stdout: '', stderr: 'crash' }, { currency: 'major', allow: {} }).status).toBe('error');
  });
});

describe('drift gate — runGate + overallExit', () => {
  const policy = { ...DEFAULT_POLICY, currency: 'major', allow: { typescript: 'major' }, scanExclude: [] };

  // Fake CLI: standards passes, currency reports only an allowed typescript major, budget passes.
  const cleanRun = (step: { id: string }) => {
    if (step.id === 'currency') {
      return { code: 0, stdout: JSON.stringify({ records: [{ name: 'typescript', drift: 'major', latest: '7.0.2' }] }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  it('is green when every step passes', () => {
    const results = runGate({ policy, online: true, baselineExists: false, runStep: cleanRun });
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass']);
    expect(overallExit(results)).toBe(0);
  });

  it('fails closed when a step breaches (exit 2)', () => {
    const results = runGate({
      policy,
      online: true,
      baselineExists: false,
      runStep: (step: { id: string }) =>
        step.id === 'budget' ? { code: 2, stdout: '', stderr: 'drift score 55/100 exceeds budget 30' } : cleanRun(step),
    });
    expect(results.find((r) => r.id === 'budget')!.status).toBe('fail');
    expect(overallExit(results)).toBe(2);
  });

  it('fails closed on an unexpected exit (tooling error)', () => {
    const results = runGate({
      policy,
      online: false,
      baselineExists: false,
      runStep: () => ({ code: 127, stdout: '', stderr: 'cli not found' }),
    });
    expect(results[0].status).toBe('error');
    expect(overallExit(results)).toBe(2);
  });

  it('overallExit is 0 only when nothing failed or errored', () => {
    expect(overallExit([{ status: 'pass' }, { status: 'pass' }])).toBe(0);
    expect(overallExit([{ status: 'pass' }, { status: 'fail' }])).toBe(2);
    expect(overallExit([{ status: 'pass' }, { status: 'error' }])).toBe(2);
  });
});

describe('drift gate — exit-code contract the gate relies on', () => {
  it('GATE_FAILED is 2 and stays stable (CI branches on it)', () => {
    expect(ExitCode.GATE_FAILED).toBe(2);
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.USAGE_ERROR).toBe(5);
  });
});

describe('drift gate — committed policy files are valid', () => {
  it('drift-gate.config.json is well-formed and within sane bounds', () => {
    const cfg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'drift-gate.config.json'), 'utf8'));
    expect(typeof cfg.driftBudget).toBe('number');
    expect(cfg.driftBudget).toBeGreaterThanOrEqual(0);
    expect(cfg.driftBudget).toBeLessThanOrEqual(100);
    expect(['major', 'minor', null]).toContain(cfg.currency);
    expect(Array.isArray(cfg.scanExclude)).toBe(true);
  });

  it('vibgrate.standards.json parses to a non-empty banned list and every rule names a package', () => {
    const raw = JSON.parse(readFileSync(path.join(PKG_ROOT, 'vibgrate.standards.json'), 'utf8'));
    const policy = normalizeStandards(raw);
    expect(policy.banned.length).toBeGreaterThan(0);
    for (const rule of policy.banned) expect(rule.name.length).toBeGreaterThan(0);
  });
});

describe('drift gate — standards policy semantics (the standards step)', () => {
  const banned = normalizeStandards({
    banned: [{ name: 'request', use: 'undici', reason: 'deprecated' }],
  });

  it('flags a banned dependency that is in use', () => {
    const records: DepRecord[] = [
      { name: 'request', ecosystem: 'npm', declared: '^2.88.0', installed: '2.88.2' },
      { name: 'undici', ecosystem: 'npm', declared: '^6.0.0' },
    ];
    const violations = checkStandards(banned, records);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: 'request', use: 'undici' });
  });

  it('is clean when no banned dependency is present', () => {
    const records: DepRecord[] = [{ name: 'undici', ecosystem: 'npm', declared: '^6.0.0' }];
    expect(checkStandards(banned, records)).toHaveLength(0);
  });
});
