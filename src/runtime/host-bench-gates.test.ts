import { describe, it, expect } from 'vitest';
import { HOST_BENCH_ARMS, stubHostBenchReport, runMockHostBench } from './host-bench.js';
import {
  DEFAULT_RELEASE_GATES,
  evaluateHostBenchGates,
  renderGateResultMarkdown,
} from './host-bench-gates.js';

describe('host-bench-gates', () => {
  it('passes hard gates on stub report', () => {
    const r = evaluateHostBenchGates(stubHostBenchReport());
    expect(r.ok).toBe(true);
    expect(r.hardFailed).toBe(0);
    expect(r.rows.length).toBe(DEFAULT_RELEASE_GATES.length);
  });

  it('passes hard gates on mock report', () => {
    const r = evaluateHostBenchGates(runMockHostBench());
    expect(r.ok).toBe(true);
  });

  it('fails when an arm is missing', () => {
    const report = stubHostBenchReport();
    report.arms = report.arms.slice(1);
    const r = evaluateHostBenchGates(report);
    expect(r.ok).toBe(false);
    expect(r.rows.some((x) => x.gateId === 'all-arms-present' && !x.ok)).toBe(true);
  });

  it('fails when a required metric is missing', () => {
    const report = stubHostBenchReport();
    const first = report.arms[0];
    const def = HOST_BENCH_ARMS.find((a) => a.id === first.armId)!;
    delete first.metrics[def.metrics[0]];
    const r = evaluateHostBenchGates(report);
    expect(r.ok).toBe(false);
    expect(r.rows.some((x) => x.gateId === 'required-metrics-present' && !x.ok)).toBe(true);
  });

  it('renders markdown', () => {
    const md = renderGateResultMarkdown(evaluateHostBenchGates(stubHostBenchReport()));
    expect(md).toMatch(/Host-bench gates/);
    expect(md).toMatch(/PASS|FAIL/);
  });
});
