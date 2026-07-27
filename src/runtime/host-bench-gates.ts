/**
 * Host-bench release gates (Approach B / P3).
 *
 * Structural gates always apply (CI-safe). Performance gates apply when a report
 * was produced by `simulate` or `live` and carries real metric values.
 *
 * schemaVersion: host-bench-gates/0
 */

import type { HostBenchArmId, HostBenchReport, HostBenchResultRow } from './host-bench.js';
import { HOST_BENCH_ARMS, HOST_BENCH_SCHEMA } from './host-bench.js';

export const HOST_BENCH_GATES_SCHEMA = 'host-bench-gates/0' as const;

export type GateOp = 'gte' | 'lte' | 'eq' | 'present';

export interface HostBenchGate {
  id: string;
  /** When set, only that arm is checked. When omitted, every arm is checked. */
  armId?: HostBenchArmId;
  metric?: string;
  op: GateOp;
  value?: number;
  /** Soft gates never fail the suite (reported as warn). */
  soft?: boolean;
  /** Human explanation for operators. */
  rationale: string;
}

export interface GateEvalRow {
  gateId: string;
  armId?: HostBenchArmId;
  ok: boolean;
  soft: boolean;
  detail: string;
}

export interface HostBenchGateResult {
  schemaVersion: typeof HOST_BENCH_GATES_SCHEMA;
  ok: boolean;
  hardFailed: number;
  softFailed: number;
  passed: number;
  rows: GateEvalRow[];
}

/**
 * Default release gates:
 *  - every registry arm present in the report
 *  - each arm row ok
 *  - required metrics present (value defined)
 *  - soft: embedded multi-turn warmStart when turns>=2 (simulate/live)
 */
export const DEFAULT_RELEASE_GATES: HostBenchGate[] = [
  {
    id: 'report-schema',
    op: 'eq',
    metric: '__schema__',
    value: 1,
    rationale: 'Report must use host-bench/0 schema',
  },
  {
    id: 'all-arms-present',
    op: 'present',
    rationale: 'Every HOST_BENCH_ARMS id must appear in the report',
  },
  {
    id: 'arm-rows-ok',
    op: 'eq',
    metric: '__arm_ok__',
    value: 1,
    rationale: 'Each arm row must have ok=true',
  },
  {
    id: 'required-metrics-present',
    op: 'present',
    metric: '__metrics__',
    rationale: 'Each arm must include all declared metric keys',
  },
  {
    id: 'embedded-warm-on-multi-turn',
    armId: 'capsule-embedded',
    metric: 'warmStart',
    op: 'gte',
    value: 1,
    soft: true,
    rationale: 'Multi-turn simulate/live should mark warmStart on embedded arm',
  },
  {
    id: 'grammar-arm-applied',
    armId: 'capsule-embedded-grammar',
    metric: 'grammarApplied',
    op: 'gte',
    value: 1,
    soft: true,
    rationale: 'Grammar arm should record grammarApplied when simulate/live exercises grammar',
  },
  {
    id: 'kv-delta-hit-tokens',
    armId: 'capsule-embedded-kv-delta',
    metric: 'kvHitTokens',
    op: 'gte',
    value: 0,
    soft: true,
    rationale: 'KV delta arm reports kvHitTokens (zero allowed on cold mock)',
  },
];

/**
 * Evaluate gates against a report. Structural gates always run; metric
 * comparisons skip soft gates when the metric is identically 0 and the report
 * notes look like stub/mock-empty (so CI stub still passes hard gates).
 */
export function evaluateHostBenchGates(
  report: HostBenchReport,
  gates: HostBenchGate[] = DEFAULT_RELEASE_GATES,
): HostBenchGateResult {
  const rows: GateEvalRow[] = [];
  const byArm = new Map<HostBenchArmId, HostBenchResultRow>();
  for (const a of report.arms) byArm.set(a.armId, a);

  const isStubbish = report.arms.every(
    (a) => a.notes?.includes('stub') || a.notes?.includes('mock-empty') || Object.values(a.metrics).every((v) => v === 0),
  );

  for (const g of gates) {
    if (g.id === 'report-schema') {
      const ok = report.schemaVersion === HOST_BENCH_SCHEMA;
      rows.push({
        gateId: g.id,
        ok,
        soft: !!g.soft,
        detail: ok ? `schema ${report.schemaVersion}` : `expected ${HOST_BENCH_SCHEMA}, got ${report.schemaVersion}`,
      });
      continue;
    }

    if (g.id === 'all-arms-present' || (g.op === 'present' && !g.metric)) {
      const missing = HOST_BENCH_ARMS.map((a) => a.id).filter((id) => !byArm.has(id));
      rows.push({
        gateId: g.id,
        ok: missing.length === 0,
        soft: !!g.soft,
        detail: missing.length === 0 ? `all ${HOST_BENCH_ARMS.length} arms present` : `missing: ${missing.join(', ')}`,
      });
      continue;
    }

    if (g.id === 'arm-rows-ok') {
      const bad = report.arms.filter((a) => !a.ok).map((a) => a.armId);
      rows.push({
        gateId: g.id,
        ok: bad.length === 0,
        soft: !!g.soft,
        detail: bad.length === 0 ? 'all arm rows ok' : `not ok: ${bad.join(', ')}`,
      });
      continue;
    }

    if (g.id === 'required-metrics-present' || g.metric === '__metrics__') {
      const problems: string[] = [];
      for (const def of HOST_BENCH_ARMS) {
        const row = byArm.get(def.id);
        if (!row) {
          problems.push(`${def.id}: missing row`);
          continue;
        }
        for (const m of def.metrics) {
          if (!(m in row.metrics) || typeof row.metrics[m] !== 'number' || Number.isNaN(row.metrics[m])) {
            problems.push(`${def.id}.${m}`);
          }
        }
      }
      rows.push({
        gateId: g.id,
        ok: problems.length === 0,
        soft: !!g.soft,
        detail: problems.length === 0 ? 'all declared metrics present' : `missing/invalid: ${problems.slice(0, 12).join(', ')}`,
      });
      continue;
    }

    // Metric comparison for a specific arm.
    if (g.armId && g.metric && g.op !== 'present') {
      const row = byArm.get(g.armId);
      if (!row) {
        rows.push({
          gateId: g.id,
          armId: g.armId,
          ok: false,
          soft: !!g.soft,
          detail: `arm ${g.armId} missing`,
        });
        continue;
      }
      const actual = row.metrics[g.metric];
      if (typeof actual !== 'number') {
        rows.push({
          gateId: g.id,
          armId: g.armId,
          ok: false,
          soft: !!g.soft,
          detail: `metric ${g.metric} missing`,
        });
        continue;
      }
      // Soft performance gates: don't fail CI stub/mock-empty zeros.
      if (g.soft && isStubbish && actual === 0) {
        rows.push({
          gateId: g.id,
          armId: g.armId,
          ok: true,
          soft: true,
          detail: `skipped soft gate on stub/empty report (${g.metric}=0)`,
        });
        continue;
      }
      const ok = compare(actual, g.op, g.value ?? 0);
      rows.push({
        gateId: g.id,
        armId: g.armId,
        ok,
        soft: !!g.soft,
        detail: ok
          ? `${g.metric}=${actual} ${g.op} ${g.value}`
          : `${g.metric}=${actual} failed ${g.op} ${g.value} — ${g.rationale}`,
      });
      continue;
    }

    rows.push({
      gateId: g.id,
      ok: false,
      soft: !!g.soft,
      detail: `unhandled gate shape: ${g.id}`,
    });
  }

  let hardFailed = 0;
  let softFailed = 0;
  let passed = 0;
  for (const r of rows) {
    if (r.ok) passed++;
    else if (r.soft) softFailed++;
    else hardFailed++;
  }

  return {
    schemaVersion: HOST_BENCH_GATES_SCHEMA,
    ok: hardFailed === 0,
    hardFailed,
    softFailed,
    passed,
    rows,
  };
}

function compare(actual: number, op: GateOp, value: number): boolean {
  switch (op) {
    case 'gte':
      return actual >= value;
    case 'lte':
      return actual <= value;
    case 'eq':
      return actual === value;
    case 'present':
      return true;
    default:
      return false;
  }
}

/** Markdown summary for operators / CI logs. */
export function renderGateResultMarkdown(result: HostBenchGateResult): string {
  const lines = [
    `# Host-bench gates (${result.schemaVersion})`,
    '',
    result.ok ? '**PASS** (no hard failures)' : '**FAIL** (hard gate failures)',
    '',
    `| Gate | Arm | Result | Detail |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const r of result.rows) {
    const mark = r.ok ? 'ok' : r.soft ? 'warn' : 'FAIL';
    lines.push(`| ${r.gateId} | ${r.armId ?? '—'} | ${mark} | ${r.detail.replace(/\|/g, '/')} |`);
  }
  lines.push('');
  lines.push(`passed=${result.passed} softFailed=${result.softFailed} hardFailed=${result.hardFailed}`);
  return lines.join('\n');
}
