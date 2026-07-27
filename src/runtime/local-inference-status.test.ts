import { describe, it, expect, beforeEach } from 'vitest';
import { clearHostSessionPool } from './llm-host/session.js';
import {
  applyRecommendedDefaultMode,
  buildLocalInferenceStatus,
} from './local-inference-status.js';

describe('local-inference-status', () => {
  beforeEach(() => clearHostSessionPool());

  it('builds a diagnosis snapshot without secrets', () => {
    const s = buildLocalInferenceStatus({
      system: {
        totalRamBytes: 16 * 1024 ** 3,
        freeRamBytes: 8 * 1024 ** 3,
        loaded: [],
      },
      repo: { fileCount: 100 },
      env: {},
    });
    expect(s.schemaVersion).toBe('local-inference-status/0');
    expect(s.isolation).toBe('embedded');
    expect(s.recommendedMode).toMatch(/spark|flow|forge/);
    expect(s.weightCatalog.total).toBeGreaterThan(0);
    expect(Array.isArray(s.hints)).toBe(true);
  });

  it('flags process isolation and prefer ollama from env', () => {
    const s = buildLocalInferenceStatus({
      system: { totalRamBytes: 8 * 1024 ** 3, freeRamBytes: 4 * 1024 ** 3, loaded: [] },
      env: {
        VIBGRATE_INFERENCE_ISOLATION: 'process',
        VG_PREFER_OLLAMA: '1',
        VG_LLM_ON_TOKEN: '1',
      },
    });
    expect(s.isolation).toBe('process');
    expect(s.preferOllama).toBe(true);
    expect(s.dynamicOnToken).toBe(true);
    expect(s.hints.some((h) => /process isolation/i.test(h))).toBe(true);
  });

  it('applyRecommendedDefaultMode pins when unset', () => {
    let pinned: string | null = null;
    const r = applyRecommendedDefaultMode({
      system: { totalRamBytes: 32 * 1024 ** 3, freeRamBytes: 24 * 1024 ** 3, loaded: [] },
      currentDefault: null,
      setDefault: (m) => {
        pinned = m;
      },
    });
    expect(r.applied).toBe(true);
    expect(pinned).toBe(r.mode);
  });

  it('applyRecommendedDefaultMode no-ops when already pinned', () => {
    let calls = 0;
    const r = applyRecommendedDefaultMode({
      system: { totalRamBytes: 32 * 1024 ** 3, freeRamBytes: 24 * 1024 ** 3, loaded: [] },
      currentDefault: 'spark',
      setDefault: () => {
        calls++;
      },
    });
    expect(r.applied).toBe(false);
    expect(r.mode).toBe('spark');
    expect(calls).toBe(0);
  });
});
