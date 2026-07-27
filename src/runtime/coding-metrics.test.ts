import { describe, it, expect, beforeEach } from 'vitest';
import { clearHostSessionPool } from './llm-host/session.js';
import {
  assertCodingMetricsPublishable,
  buildCodingMetricsReport,
  CODING_METRICS_SCHEMA,
  renderCodingMetricsMarkdown,
} from './coding-metrics.js';
import { defaultSimulateLib } from './host-bench-runner.js';

describe('coding-metrics', () => {
  beforeEach(() => clearHostSessionPool());

  it('builds a full simulate report with fusion + host gates', async () => {
    const report = await buildCodingMetricsReport({
      mode: 'simulate',
      turns: 2,
      fakeLib: defaultSimulateLib(),
      cliVersion: '2026.727.0-test',
    });
    expect(report.schemaVersion).toBe(CODING_METRICS_SCHEMA);
    expect(report.component).toBe('cli-coding');
    expect(report.cliVersion).toBe('2026.727.0-test');
    expect(report.hostGates.ok).toBe(true);
    expect(report.hostBench.arms.length).toBeGreaterThanOrEqual(5);
    expect(report.fusion.taskCount).toBeGreaterThan(0);
    expect(report.fusion.fcs).not.toBeNull();
    expect(report.trajectorySummary.totalRuns).toBeGreaterThan(0);
    expect(report.headline.hostGatesOk).toBe(1);
    expect(report.headline.fusionRuns).toBe(report.fusion.taskCount);

    expect(() => assertCodingMetricsPublishable(report)).not.toThrow();
    const md = renderCodingMetricsMarkdown(report);
    expect(md).toMatch(/Coding metrics/);
    expect(md).toMatch(/FCS/);
  }, 30_000);

  it('mock mode still yields a publishable structural report when gates pass', async () => {
    const report = await buildCodingMetricsReport({
      mode: 'mock',
      skipFusion: true,
      cliVersion: '0.0.0-mock',
    });
    expect(report.hostGates.ok).toBe(true);
    expect(report.fusion.taskCount).toBe(0);
    expect(() => assertCodingMetricsPublishable(report)).not.toThrow();
  });

  it('assertCodingMetricsPublishable rejects wrong schema', () => {
    expect(() => assertCodingMetricsPublishable({ schemaVersion: 'nope' })).toThrow(/schema/);
  });
});
