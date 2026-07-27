import { describe, it, expect, beforeEach } from 'vitest';
import { clearHostSessionPool } from './llm-host/session.js';
import { evaluateHostBenchGates } from './host-bench-gates.js';
import {
  defaultSimulateLib,
  runHostBench,
  renderHostBenchReportText,
} from './host-bench-runner.js';
import { HOST_BENCH_ARMS } from './host-bench.js';

describe('host-bench-runner', () => {
  beforeEach(() => clearHostSessionPool());

  it('mock mode fills all arms', async () => {
    const r = await runHostBench({ mode: 'mock' });
    expect(r.mode).toBe('mock');
    expect(r.report.arms.length).toBe(HOST_BENCH_ARMS.length);
    expect(evaluateHostBenchGates(r.report).ok).toBe(true);
  });

  it('simulate mode exercises multi-turn and passes hard gates when full suite', async () => {
    const r = await runHostBench({
      mode: 'simulate',
      turns: 2,
      fakeLib: defaultSimulateLib(),
    });
    expect(r.mode).toBe('simulate');
    expect(r.report.arms.length).toBe(HOST_BENCH_ARMS.length);
    expect(r.report.arms.every((a) => a.ok)).toBe(true);
    expect(r.report.arms.every((a) => a.notes === 'simulate')).toBe(true);

    // Multi-turn embedded arms should pick up warm / kv metrics on later turns.
    const emb = r.report.arms.find((a) => a.armId === 'capsule-embedded');
    expect(emb).toBeDefined();
    expect(emb!.metrics.turns).toBe(2);

    const kv = r.report.arms.find((a) => a.armId === 'capsule-embedded-kv-delta');
    expect(kv).toBeDefined();
    expect(typeof kv!.metrics.kvHitTokens).toBe('number');

    // Full suite for gates: simulate report has all arms.
    const gates = evaluateHostBenchGates(r.report);
    expect(gates.ok).toBe(true);

    const text = renderHostBenchReportText(r);
    expect(text).toMatch(/host-bench/);
    expect(text).toMatch(/capsule-embedded/);
  });

  it('live mode without binding throws actionable error', async () => {
    await expect(runHostBench({ mode: 'live' })).rejects.toThrow(/binding \+ modelPath/);
  });

  it('can run a subset of arms', async () => {
    const r = await runHostBench({
      mode: 'simulate',
      armIds: ['capsule-embedded-grammar'],
      turns: 1,
      fakeLib: defaultSimulateLib(),
    });
    expect(r.report.arms).toHaveLength(1);
    expect(r.report.arms[0].armId).toBe('capsule-embedded-grammar');
  });
});
