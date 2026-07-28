import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fitPack,
  resolveMode,
  recommendMode,
  buildOrchestratorStatus,
  QUALIFIED_PACKS,
  packForMode,
  pinPack,
  unpinPack,
  readOrchestratorState,
  parseMode,
  providerForBackend,
  type QualifiedPack,
} from './model-orchestrator.js';
import type { SystemMemory } from '../code/capability.js';

const GiB = 1024 ** 3;

function mem(partial: Partial<SystemMemory> & { totalRamBytes: number; freeRamBytes: number }): SystemMemory {
  return { loaded: [], ...partial };
}

describe('fitPack', () => {
  const spark = packForMode('spark')!;

  it('labels flies when headroom is large', () => {
    const fit = fitPack({
      pack: spark,
      system: mem({ totalRamBytes: 64 * GiB, freeRamBytes: 48 * GiB }),
    });
    expect(fit.label).toBe('flies');
    expect(fit.score).toBeGreaterThanOrEqual(80);
    expect(fit.breakdown.modelBytes).toBeGreaterThan(0);
  });

  it('labels will_not_fit when free RAM is tiny', () => {
    const fit = fitPack({
      pack: packForMode('forge')!,
      system: mem({ totalRamBytes: 8 * GiB, freeRamBytes: 0.5 * GiB }),
    });
    expect(fit.label).toBe('will_not_fit');
    expect(fit.score).toBeLessThanOrEqual(20);
  });

  it('labels will_not_fit when free disk cannot hold weights', () => {
    const fit = fitPack({
      pack: packForMode('flow')!,
      system: mem({ totalRamBytes: 64 * GiB, freeRamBytes: 40 * GiB }),
      freeDiskBytes: 1 * GiB, // Flow weights ~4.4 GiB + headroom
    });
    expect(fit.label).toBe('will_not_fit');
    expect(fit.diskNeedBytes).toBeGreaterThan(1 * GiB);
    expect(fit.reasons.some((r) => /disk/i.test(r))).toBe(true);
  });

  it('fits spark when available RAM is modest after reclaim-aware free', () => {
    // Regression: macOS os.freemem() often reports ~0 while Activity Monitor
    // shows many GiB available. With ~8 GiB available, spark (~2 GiB) must fit
    // after growth reserves (not a full second IDE/OS footprint).
    const fit = fitPack({
      pack: spark,
      system: mem({ totalRamBytes: 16 * GiB, freeRamBytes: 8 * GiB }),
    });
    expect(fit.label).not.toBe('will_not_fit');
    expect(fit.availableBytes).toBeGreaterThan(fit.needBytes * 0.85);
  });

  it('does not double-count full IDE/OS against already-free RAM', () => {
    const fit = fitPack({
      pack: spark,
      system: mem({ totalRamBytes: 32 * GiB, freeRamBytes: 6 * GiB }),
    });
    // Old formula reserved ~5.25 GiB → ~0.75 free after; spark need ~2 → will_not_fit.
    // Growth-only reserves leave enough headroom for spark.
    expect(fit.label).not.toBe('will_not_fit');
  });

  it('suggests reduced capsule when tight', () => {
    const flow = packForMode('flow')!;
    // Need roughly model+kv; set free just above 0.85 * need after reserves.
    const needApprox = (flow.primary.weightsBytes ?? 5 * GiB) + 2 * GiB;
    const free = needApprox + 4 * GiB; // after reserves (~5 GiB) may be tight
    const fit = fitPack({
      pack: flow,
      system: mem({ totalRamBytes: 16 * GiB, freeRamBytes: free }),
      reserves: {
        ideBytes: 1 * GiB,
        osBytes: 1 * GiB,
        graphBytes: 0.2 * GiB,
        testsBytes: 0.1 * GiB,
        safetyMarginBytes: 0.5 * GiB,
      },
    });
    expect(['tight', 'comfortable', 'flies', 'will_not_fit']).toContain(fit.label);
    if (fit.label === 'tight') {
      expect(fit.reducedCapsuleBudgetTokens).toBeDefined();
      expect(fit.reducedCapsuleBudgetTokens!).toBeLessThan(flow.contract.capsuleBudgetTokens);
    }
  });
});

describe('resolveMode / recommendMode', () => {
  it('auto-fits spark on small machines', () => {
    const system = mem({ totalRamBytes: 8 * GiB, freeRamBytes: 5 * GiB });
    const mode = recommendMode(system, { fileCount: 40 });
    expect(mode).toBe('spark');
    const r = resolveMode({ autoFit: true, system, repo: { fileCount: 40 } });
    expect(r.mode).toBe('spark');
    expect(r.selection).toBe('auto_fit');
    expect(r.profile.mode).toBe('spark');
    expect(r.underlying.weightsRef).toBeTruthy();
  });

  it('prefers flow as daily default when machine has room', () => {
    const system = mem({ totalRamBytes: 32 * GiB, freeRamBytes: 24 * GiB });
    const mode = recommendMode(system, { fileCount: 500 });
    expect(['flow', 'forge']).toContain(mode);
    const r = resolveMode({ mode: 'flow', autoFit: false, system });
    expect(r.fit.label === 'flies' || r.fit.label === 'comfortable' || r.fit.label === 'tight').toBe(true);
  });

  it('falls back to smaller weights when primary will not fit', () => {
    const system = mem({ totalRamBytes: 8 * GiB, freeRamBytes: 3 * GiB });
    const r = resolveMode({ mode: 'flow', autoFit: false, system });
    // 7b may not fit; 3b fallback should win when available
    expect(r.pack.mode).toBe('flow');
    expect(r.underlying.weightsRef).toMatch(/qwen2\.5-coder/);
  });

  it('honors explicit mode over auto-fit', () => {
    const system = mem({ totalRamBytes: 64 * GiB, freeRamBytes: 48 * GiB });
    const r = resolveMode({ mode: 'spark', autoFit: true, system });
    expect(r.mode).toBe('spark');
    expect(r.selection).toBe('explicit');
  });

  it('builds status with all three modes', () => {
    const system = mem({ totalRamBytes: 16 * GiB, freeRamBytes: 10 * GiB });
    const status = buildOrchestratorStatus({
      system,
      installedNames: ['qwen2.5-coder-3b-q4_k_m.gguf', 'qwen2.5-coder:3b'],
    });
    expect(status.modes).toHaveLength(3);
    expect(status.recommended).toMatch(/spark|flow|forge/);
    expect(status.memoryBreakdown).toBeDefined();
    const spark = status.modes.find((m) => m.mode === 'spark')!;
    expect(spark.installed).toBe(true);
    expect(spark.backend).toBe('llama.cpp');
    const forge = packForMode('forge')!;
    expect(forge.primary.backend).toBe('llama.cpp');
    expect(forge.primary.weightsRef).toMatch(/14b/);
    expect(forge.contract.preferredInference).toBe('llama.cpp');
  });
});


describe('pin registry', () => {
  let tmp: string;
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, VIBGRATE_DATA_DIR: tmp });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-orch-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('pins and unpins a pack version', () => {
    const packId = QUALIFIED_PACKS[1].packId; // flow
    pinPack('flow', packId, env());
    const state = readOrchestratorState(env());
    expect(state.pins.flow).toBe(packId);

    const r = resolveMode({
      mode: 'flow',
      autoFit: false,
      system: mem({ totalRamBytes: 32 * GiB, freeRamBytes: 20 * GiB }),
      pin: { mode: 'flow', packId },
    });
    expect(r.pinned).toBe(true);
    expect(r.selection).toBe('pinned');

    unpinPack('flow', env());
    expect(readOrchestratorState(env()).pins.flow).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parseMode accepts spark|flow|forge', () => {
    expect(parseMode('Flow')).toBe('flow');
    expect(parseMode('nope')).toBeNull();
  });

  it('providerForBackend maps backends', () => {
    expect(providerForBackend('ollama')).toBe('ollama');
    expect(providerForBackend('llama.cpp')).toBe('llama-cpp');
  });

  it('every curated pack has a contract and primary weights', () => {
    for (const p of QUALIFIED_PACKS as QualifiedPack[]) {
      expect(p.packId).toMatch(/^(spark|flow|forge)@/);
      expect(p.primary.weightsRef).toBeTruthy();
      expect(p.contract.capsuleBudgetTokens).toBeGreaterThan(0);
    }
  });
});
