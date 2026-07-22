import { describe, it, expect } from 'vitest';
import { estimateModelBytes, parseOllamaPs, parseNvidiaSmi, assessCapability, type SystemMemory } from './capability.js';

const GiB = 1024 ** 3;

describe('estimateModelBytes', () => {
  it('reads params and quant from a slug', () => {
    const e = estimateModelBytes('qwen2.5-coder:7b-instruct-q4_K_M');
    expect(e.paramsB).toBe(7);
    expect(e.quant).toBe('q4_k_m');
    expect(e.guessed).toBe(false);
    // ~7B * 0.6 * 1.2 ≈ 5 GiB
    expect(e.bytes / GiB).toBeGreaterThan(4);
    expect(e.bytes / GiB).toBeLessThan(7);
  });

  it('marks the estimate guessed when no param count is present', () => {
    const e = estimateModelBytes('some-model:latest');
    expect(e.guessed).toBe(true);
    expect(e.bytes).toBeGreaterThan(0);
  });

  it('a 70B model is much larger than a 7B model', () => {
    expect(estimateModelBytes('llama3:70b-q4_K_M').bytes).toBeGreaterThan(estimateModelBytes('llama3:7b-q4_K_M').bytes * 5);
  });
});

describe('parseOllamaPs', () => {
  it('parses loaded models and sizes, skipping the header', () => {
    const out = [
      'NAME                ID              SIZE      PROCESSOR    UNTIL',
      'qwen2.5-coder:7b    abc123          5.5 GB    100% GPU     4 minutes from now',
      'llama3:8b           def456          6.1 GB    100% GPU     2 minutes from now',
    ].join('\n');
    const loaded = parseOllamaPs(out);
    expect(loaded.map((m) => m.name)).toEqual(['qwen2.5-coder:7b', 'llama3:8b']);
    expect(loaded[0].bytes / 1e9).toBeCloseTo(5.5, 1);
  });

  it('returns [] on empty output', () => {
    expect(parseOllamaPs('')).toEqual([]);
  });
});

describe('parseNvidiaSmi', () => {
  it('parses total/used MiB', () => {
    const r = parseNvidiaSmi('24576, 8192')!;
    expect(r.totalBytes / GiB).toBeCloseTo(24, 0);
    expect(r.usedBytes / GiB).toBeCloseTo(8, 0);
  });
  it('returns null on junk', () => {
    expect(parseNvidiaSmi('no gpu here')).toBeNull();
  });
});

describe('assessCapability', () => {
  const model = estimateModelBytes('qwen2.5-coder:7b-q4_K_M'); // ~5 GiB

  it('can run when there is ample free RAM', () => {
    const sys: SystemMemory = { totalRamBytes: 32 * GiB, freeRamBytes: 20 * GiB, loaded: [] };
    const r = assessCapability(model, sys);
    expect(r.canRun).toBe(true);
    expect(r.needsUnload).toBe(false);
  });

  it('suggests unloading when a loaded model blocks it but unloading would free enough', () => {
    const sys: SystemMemory = {
      totalRamBytes: 16 * GiB,
      freeRamBytes: 3 * GiB,
      loaded: [{ name: 'llama3:8b', bytes: 6 * GiB }],
    };
    const r = assessCapability(model, sys);
    expect(r.canRun).toBe(true);
    expect(r.needsUnload).toBe(true);
    expect(r.suggestions.join(' ')).toMatch(/ollama stop llama3:8b/);
  });

  it('cannot run when even unloading everything is not enough', () => {
    const sys: SystemMemory = { totalRamBytes: 4 * GiB, freeRamBytes: 2 * GiB, loaded: [] };
    const r = assessCapability(estimateModelBytes('llama3:70b-q4_K_M'), sys);
    expect(r.canRun).toBe(false);
    expect(r.suggestions.join(' ')).toMatch(/smaller model|lower quant/);
  });

  it('prefers VRAM when a discrete GPU is present', () => {
    const sys: SystemMemory = {
      totalRamBytes: 8 * GiB,
      freeRamBytes: 1 * GiB, // low system RAM
      vramTotalBytes: 24 * GiB,
      vramFreeBytes: 20 * GiB, // plenty of VRAM
      loaded: [],
    };
    expect(assessCapability(model, sys).canRun).toBe(true);
  });
});
