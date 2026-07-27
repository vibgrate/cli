import { describe, it, expect, vi } from 'vitest';
import { buildModelInstallPlan } from './model-install-plan.js';
import { executeModelInstallPlan } from './model-install.js';

describe('executeModelInstallPlan', () => {
  it('installs npm runtime deps with consent when listed in willInstall', async () => {
    const plan = buildModelInstallPlan({
      backend: 'llama.cpp',
      weightsRef: 'm.gguf',
      modelPath: '/m.gguf',
      isPackageInstalled: () => false,
      hasBinary: () => false,
    });
    expect(plan.willInstall).toContain('node-llama-cpp@^3');

    const ensurePackage = vi.fn(async () => ({ module: { ok: true }, dir: '/tmp' }));
    const res = await executeModelInstallPlan(plan, { ensurePackage: ensurePackage as never });
    expect(res.ok).toBe(true);
    expect(ensurePackage).toHaveBeenCalledWith(
      'node-llama-cpp@^3',
      expect.objectContaining({ consent: true }),
    );
    expect(res.installedDeps).toEqual(['node-llama-cpp@^3']);
  });

  it('pulls ollama weights via injectable puller', async () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      hasBinary: () => true,
      isPackageInstalled: () => false,
    });
    const ollamaPull = vi.fn(() => 0);
    const res = await executeModelInstallPlan(plan, { ollamaPull });
    expect(res.ok).toBe(true);
    expect(ollamaPull).toHaveBeenCalledWith('qwen2.5-coder:7b', false);
    expect(res.pulledWeights).toEqual(['qwen2.5-coder:7b']);
  });

  it('fails fast when ollama binary is blocked', async () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      hasBinary: () => false,
    });
    const ollamaPull = vi.fn(() => 0);
    const res = await executeModelInstallPlan(plan, { ollamaPull });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ollama/i);
    expect(ollamaPull).not.toHaveBeenCalled();
  });

  it('refuses offline execution', async () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      offline: true,
      hasBinary: () => true,
    });
    const res = await executeModelInstallPlan(plan, { offline: true, ollamaPull: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/offline|local/i);
  });

  it('downloads first-party weights via vibgrate channel', async () => {
    const plan = buildModelInstallPlan({
      backend: 'llama.cpp',
      weightsRef: 'qwen2.5-coder-3b-q4_k_m.gguf',
      isPackageInstalled: (spec) => spec.includes('node-llama-cpp'),
      isWeightCached: () => false,
      hasBinary: () => false,
    });
    expect(plan.weights.channel).toBe('vibgrate');
    expect(plan.willDownload).toContain('qwen2.5-coder-3b-q4_k_m.gguf');

    const ensureWeightCached = vi.fn(async () => ({ ok: true, path: '/cache/w.gguf', fromCache: false }));
    const res = await executeModelInstallPlan(plan, { ensureWeightCached: ensureWeightCached as never });
    expect(res.ok).toBe(true);
    expect(ensureWeightCached).toHaveBeenCalled();
    expect(res.pulledWeights).toContain('qwen2.5-coder-3b-q4_k_m.gguf');
  });
});
