/**
 * Coding metrics report (Approach B + Fusion) — release-publishable suite.
 *
 * schemaVersion: coding-metrics/0
 *
 * Combines:
 *  - host-bench arms (warm host / grammar / sampler / KV)
 *  - host-bench release gates
 *  - Fusion offline FCS / ZNS@1 trajectory pack
 *
 * Used by `vg models coding-metrics` and the coding-metrics GitHub Action.
 * Published to packages/vibgrate-website/data/benchmarks-coding/ via
 * scripts/publish-coding-metrics.mjs (human review PR = public gate).
 */

import { VERSION } from '../version.js';
import { defaultFusionTaskPack, runFusionTaskPack } from '../code/trajectory-harness.js';
import type { FcsReport } from '../code/trajectory.js';
import { evaluateHostBenchGates, type HostBenchGateResult } from './host-bench-gates.js';
import type { HostBenchReport } from './host-bench.js';
import {
  runHostBench,
  type HostBenchRunMode,
  type HostBenchRunOptions,
} from './host-bench-runner.js';

export const CODING_METRICS_SCHEMA = 'coding-metrics/0' as const;

export interface CodingMetricsHeadline {
  /** FCS (capsule/oracle) — null when undefined. */
  fcs: number | null;
  /** ZNS@1 rate among capsule solves. */
  znsAt1Rate: number | null;
  /** Host-bench hard gates passed (1/0). */
  hostGatesOk: number;
  /** Simulate/live: warmStart seen on embedded arm (1/0). */
  embeddedWarmStart: number | null;
  /** Simulate/live: grammarApplied on grammar arm (1/0). */
  grammarApplied: number | null;
  /** KV hit tokens on kv-delta arm. */
  kvHitTokens: number | null;
  /** Sampler hook engaged on logit-mask arm (1/0). */
  samplerHook: number | null;
  /** Fusion task runs in the pack. */
  fusionRuns: number;
  /** Median steps on capsule arm (null if none). */
  capsuleMedianSteps: number | null;
}

export interface CodingMetricsFusionSlice {
  fcs: number | null;
  znsAt1Rate: number | null;
  pairedTasks: number;
  capsuleSolved: number;
  oracleSolved: number;
  capsuleRuns: number;
  oracleRuns: number;
  metadataRuns: number;
  taskCount: number;
  solvedRate: number;
  byArm: FcsReport['byArm'];
}

export interface CodingMetricsTrajectorySummary {
  totalRuns: number;
  avgSteps: number | null;
  avgDiscoveryTools: number | null;
  avgMutationTools: number | null;
  failureCapsuleRate: number;
  znsAt1Count: number;
  promptTokensTotal: number;
  completionTokensTotal: number;
}

export interface CodingMetricsReport {
  schemaVersion: typeof CODING_METRICS_SCHEMA;
  /** Stable component id for publish scripts. */
  component: 'cli-coding';
  cliVersion: string;
  ranAt: string;
  mode: HostBenchRunMode;
  elapsedMs: number;
  hostBench: HostBenchReport;
  hostGates: HostBenchGateResult;
  fusion: CodingMetricsFusionSlice;
  trajectorySummary: CodingMetricsTrajectorySummary;
  headline: CodingMetricsHeadline;
  notes: string[];
}

export interface BuildCodingMetricsOptions extends HostBenchRunOptions {
  /** CLI version stamp (default package VERSION). */
  cliVersion?: string;
  /** Skip fusion trajectory pack (faster smoke). */
  skipFusion?: boolean;
}

/**
 * Run host-bench + offline fusion pack and fold into a single report.
 */
export async function buildCodingMetricsReport(
  options: BuildCodingMetricsOptions = {},
): Promise<CodingMetricsReport> {
  const t0 = Date.now();
  const mode = options.mode ?? 'simulate';
  const notes: string[] = [];
  if (mode === 'simulate') {
    notes.push('host-bench ran in simulate mode (fake binding — wiring metrics, not live GPU TTFT)');
  } else if (mode === 'mock') {
    notes.push('host-bench ran in mock mode (metric shells only)');
  } else {
    notes.push('host-bench ran in live mode (real binding + model path)');
  }

  const hostRun = await runHostBench({
    mode,
    armIds: options.armIds,
    turns: options.turns ?? 2,
    modelPath: options.modelPath,
    binding: options.binding,
    fakeLib: options.fakeLib,
    env: options.env,
    onProgress: options.onProgress,
  });
  const hostGates = evaluateHostBenchGates(hostRun.report);

  let fusionSlice: CodingMetricsFusionSlice;
  let trajectorySummary: CodingMetricsTrajectorySummary;

  if (options.skipFusion) {
    notes.push('fusion trajectory pack skipped');
    fusionSlice = emptyFusion();
    trajectorySummary = emptyTrajectory();
  } else {
    const { report: fcs } = await runFusionTaskPack(defaultFusionTaskPack());
    fusionSlice = {
      fcs: fcs.fcs,
      znsAt1Rate: fcs.znsAt1Rate,
      pairedTasks: fcs.pairedTasks,
      capsuleSolved: fcs.capsuleSolved,
      oracleSolved: fcs.oracleSolved,
      capsuleRuns: fcs.capsuleRuns,
      oracleRuns: fcs.oracleRuns,
      metadataRuns: fcs.metadataRuns,
      taskCount: fcs.records.length,
      solvedRate:
        fcs.records.length > 0 ? fcs.records.filter((r) => r.solved).length / fcs.records.length : 0,
      byArm: fcs.byArm,
    };
    trajectorySummary = summarizeTrajectories(fcs);
  }

  const headline = buildHeadline(hostRun.report, hostGates, fusionSlice);

  return {
    schemaVersion: CODING_METRICS_SCHEMA,
    component: 'cli-coding',
    cliVersion: options.cliVersion ?? VERSION,
    ranAt: new Date().toISOString(),
    mode,
    elapsedMs: Date.now() - t0,
    hostBench: hostRun.report,
    hostGates,
    fusion: fusionSlice,
    trajectorySummary,
    headline,
    notes,
  };
}

function emptyFusion(): CodingMetricsFusionSlice {
  return {
    fcs: null,
    znsAt1Rate: null,
    pairedTasks: 0,
    capsuleSolved: 0,
    oracleSolved: 0,
    capsuleRuns: 0,
    oracleRuns: 0,
    metadataRuns: 0,
    taskCount: 0,
    solvedRate: 0,
    byArm: {},
  };
}

function emptyTrajectory(): CodingMetricsTrajectorySummary {
  return {
    totalRuns: 0,
    avgSteps: null,
    avgDiscoveryTools: null,
    avgMutationTools: null,
    failureCapsuleRate: 0,
    znsAt1Count: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
  };
}

function summarizeTrajectories(fcs: FcsReport): CodingMetricsTrajectorySummary {
  const recs = fcs.records;
  const n = recs.length;
  const sum = (fn: (r: (typeof recs)[0]) => number) => recs.reduce((a, r) => a + fn(r), 0);
  return {
    totalRuns: n,
    avgSteps: n ? sum((r) => r.steps) / n : null,
    avgDiscoveryTools: n ? sum((r) => r.discoveryToolCalls) / n : null,
    avgMutationTools: n ? sum((r) => r.mutationToolCalls) / n : null,
    failureCapsuleRate: n ? recs.filter((r) => r.failureCapsuleBuilt).length / n : 0,
    znsAt1Count: recs.filter((r) => r.znsAt1).length,
    promptTokensTotal: sum((r) => r.promptTokens),
    completionTokensTotal: sum((r) => r.completionTokens),
  };
}

function buildHeadline(
  host: HostBenchReport,
  gates: HostBenchGateResult,
  fusion: CodingMetricsFusionSlice,
): CodingMetricsHeadline {
  const metric = (armId: string, key: string): number | null => {
    const row = host.arms.find((a) => a.armId === armId);
    if (!row || typeof row.metrics[key] !== 'number') return null;
    return row.metrics[key];
  };
  return {
    fcs: fusion.fcs,
    znsAt1Rate: fusion.znsAt1Rate,
    hostGatesOk: gates.ok ? 1 : 0,
    embeddedWarmStart: metric('capsule-embedded', 'warmStart'),
    grammarApplied: metric('capsule-embedded-grammar', 'grammarApplied'),
    kvHitTokens: metric('capsule-embedded-kv-delta', 'kvHitTokens'),
    samplerHook: metric('capsule-embedded-logit-mask', 'samplerHook'),
    fusionRuns: fusion.taskCount,
    capsuleMedianSteps: fusion.byArm.capsule?.medianSteps ?? null,
  };
}

/** Human markdown for CI job summary / results PR body. */
export function renderCodingMetricsMarkdown(report: CodingMetricsReport): string {
  const h = report.headline;
  const lines = [
    `# Coding metrics (${report.schemaVersion})`,
    '',
    `- **CLI version:** \`${report.cliVersion}\``,
    `- **Mode:** ${report.mode}`,
    `- **Ran at:** ${report.ranAt}`,
    `- **Elapsed:** ${report.elapsedMs} ms`,
    '',
    '## Headline',
    '',
    `| Metric | Value |`,
    `| --- | --- |`,
    `| FCS | ${fmt(h.fcs)} |`,
    `| ZNS@1 rate | ${fmt(h.znsAt1Rate)} |`,
    `| Host gates | ${h.hostGatesOk ? 'PASS' : 'FAIL'} |`,
    `| Embedded warmStart | ${fmt(h.embeddedWarmStart)} |`,
    `| Grammar applied | ${fmt(h.grammarApplied)} |`,
    `| KV hit tokens | ${fmt(h.kvHitTokens)} |`,
    `| Sampler hook | ${fmt(h.samplerHook)} |`,
    `| Fusion runs | ${h.fusionRuns} |`,
    `| Capsule median steps | ${fmt(h.capsuleMedianSteps)} |`,
    '',
    '## Host-bench gates',
    '',
    `hardFailed=${report.hostGates.hardFailed} softFailed=${report.hostGates.softFailed} passed=${report.hostGates.passed}`,
    '',
    '## Trajectory summary',
    '',
    `- totalRuns: ${report.trajectorySummary.totalRuns}`,
    `- avgSteps: ${fmt(report.trajectorySummary.avgSteps)}`,
    `- avgDiscoveryTools: ${fmt(report.trajectorySummary.avgDiscoveryTools)}`,
    `- failureCapsuleRate: ${fmt(report.trajectorySummary.failureCapsuleRate)}`,
    `- znsAt1Count: ${report.trajectorySummary.znsAt1Count}`,
    '',
  ];
  if (report.notes.length) {
    lines.push('## Notes', '');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}

function fmt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

/** Validate a report before website publish. */
export function assertCodingMetricsPublishable(report: unknown): asserts report is CodingMetricsReport {
  const r = report as CodingMetricsReport;
  if (!r || r.schemaVersion !== CODING_METRICS_SCHEMA) {
    throw new Error(`coding-metrics: expected schema ${CODING_METRICS_SCHEMA}`);
  }
  if (r.component !== 'cli-coding') {
    throw new Error('coding-metrics: component must be cli-coding');
  }
  if (!r.cliVersion || !r.hostBench || !r.hostGates || !r.fusion || !r.headline) {
    throw new Error('coding-metrics: report missing required sections');
  }
  if (!r.hostGates.ok) {
    throw new Error(
      `coding-metrics: host gates failed (hardFailed=${r.hostGates.hardFailed}) — refusing to publish`,
    );
  }
}
