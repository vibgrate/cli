import { describe, it, expect } from 'vitest';
import {
  HOST_BENCH_ARMS,
  assertHostBenchRegistry,
  planHostBench,
  stubHostBenchReport,
  metricsFromHostGenerate,
  runMockHostBench,
} from './host-bench.js';

describe('host-bench', () => {
  it('registry is unique and non-empty', () => {
    expect(() => assertHostBenchRegistry()).not.toThrow();
    expect(HOST_BENCH_ARMS.length).toBeGreaterThanOrEqual(7);
    expect(HOST_BENCH_ARMS.some((a) => a.id === 'capsule-embedded-logit-mask')).toBe(true);
    expect(HOST_BENCH_ARMS.some((a) => a.id === 'capsule-embedded-dynamic-sampler')).toBe(true);
    expect(HOST_BENCH_ARMS.some((a) => a.id === 'capsule-embedded-kv-delta')).toBe(true);
  });

  it('plans subset of arms', () => {
    const p = planHostBench(['capsule-embedded-grammar']);
    expect(p).toHaveLength(1);
    expect(p[0].grammar).toBe(true);
  });

  it('stub report covers all arms', () => {
    const r = stubHostBenchReport();
    expect(r.schemaVersion).toBe('host-bench/0');
    expect(r.arms).toHaveLength(HOST_BENCH_ARMS.length);
  });

  it('metricsFromHostGenerate maps generate report fields', () => {
    const m = metricsFromHostGenerate({
      latencyMs: 42,
      warmStart: true,
      samplerHook: true,
      samplerBoostedTokens: 12,
      kvPrefixReusedTokens: 100,
      kvPlan: { hitTokens: 80, totalTokens: 200 },
      unknownIdentifiers: ['ghost'],
    });
    expect(m.ttftMs).toBe(42);
    expect(m.warmStart).toBe(1);
    expect(m.samplerHook).toBe(1);
    expect(m.samplerBoostedTokens).toBe(12);
    expect(m.kvPrefixReusedTokens).toBe(100);
    expect(m.kvHitTokens).toBe(80);
    expect(m.unknownIdentifierRate).toBe(1);
  });

  it('runMockHostBench fills arm metric shells from reports', () => {
    const r = runMockHostBench({
      'capsule-embedded-logit-mask': {
        latencyMs: 10,
        samplerHook: true,
        samplerBoostedTokens: 5,
        samplerSuppressedTokens: 2,
        kvPrefixReusedTokens: 30,
      },
    });
    const row = r.arms.find((a) => a.armId === 'capsule-embedded-logit-mask');
    expect(row?.ok).toBe(true);
    expect(row?.metrics.samplerHook).toBe(1);
    expect(row?.metrics.samplerBoostedTokens).toBe(5);
    expect(row?.notes).toMatch(/mock-from-generate/);
  });
});
