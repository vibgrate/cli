import { describe, it, expect } from 'vitest';
import { buildModelsStatusReport, enrichLocalModels } from './model-status.js';
import type { SystemMemory } from './capability.js';

const GiB = 1024 ** 3;

describe('enrichLocalModels', () => {
  it('attaches quant and byte estimates from the model slug', () => {
    const [m] = enrichLocalModels([
      { runtime: 'ollama', name: 'qwen2.5-coder:7b-instruct-q4_K_M', path: '/m' },
    ]);
    expect(m.estimate.quant).toMatch(/q4/i);
    expect(m.estimate.paramsB).toBe(7);
    expect(m.estimate.bytes).toBeGreaterThan(1 * GiB);
    expect(m.estimate.guessed).toBe(false);
  });

  it('marks unknown-size slugs as guessed', () => {
    const [m] = enrichLocalModels([{ runtime: 'gguf', name: 'mystery-model', path: '/m' }]);
    expect(m.estimate.guessed).toBe(true);
    expect(m.estimate.bytes).toBeGreaterThan(0);
  });
});

describe('buildModelsStatusReport', () => {
  it('includes system RAM/VRAM and loaded models next to the fleet', () => {
    const sys: SystemMemory = {
      totalRamBytes: 64 * GiB,
      freeRamBytes: 40 * GiB,
      vramTotalBytes: 24 * GiB,
      vramFreeBytes: 18 * GiB,
      loaded: [{ name: 'other:7b', bytes: 5 * GiB }],
    };
    const report = buildModelsStatusReport(
      [{ runtime: 'ollama', name: 'qwen2.5-coder:7b', path: '/x' }],
      sys,
    );
    expect(report.models).toHaveLength(1);
    expect(report.models[0].estimate.paramsB).toBe(7);
    expect(report.system.totalRamBytes).toBe(64 * GiB);
    expect(report.system.vramFreeBytes).toBe(18 * GiB);
    expect(report.system.loaded).toEqual([{ name: 'other:7b', bytes: 5 * GiB }]);
  });

  it('omits VRAM fields when no discrete GPU was reported', () => {
    const sys: SystemMemory = {
      totalRamBytes: 16 * GiB,
      freeRamBytes: 8 * GiB,
      loaded: [],
    };
    const report = buildModelsStatusReport([], sys);
    expect(report.system.vramTotalBytes).toBeUndefined();
    expect(report.system.vramFreeBytes).toBeUndefined();
    expect(report.system.loaded).toEqual([]);
  });
});
