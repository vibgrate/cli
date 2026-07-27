import { describe, it, expect } from 'vitest';
import { buildModelInstallPlan, runtimeDepsForBackend } from './model-install-plan.js';

describe('runtimeDepsForBackend', () => {
  it('declares node-llama-cpp for llama.cpp / vibgrate', () => {
    expect(runtimeDepsForBackend('llama.cpp').map((d) => d.id)).toEqual(['node-llama-cpp']);
    expect(runtimeDepsForBackend('vibgrate')[0]?.spec).toMatch(/node-llama-cpp/);
  });

  it('declares ollama binary for ollama backend', () => {
    expect(runtimeDepsForBackend('ollama').map((d) => d.id)).toEqual(['ollama']);
  });
});

describe('buildModelInstallPlan', () => {
  it('ollama: already installed weights + binary → ready', () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: ['qwen2.5-coder:7b'],
      hasBinary: () => true,
      isPackageInstalled: () => false,
    });
    expect(plan.ready).toBe(true);
    expect(plan.willDownload).toEqual([]);
    expect(plan.willInstall).toEqual([]);
    expect(plan.blocked).toEqual([]);
    expect(plan.weights.status).toBe('satisfied');
  });

  it('ollama: missing weights, binary present → willDownload', () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      hasBinary: (b) => b === 'ollama',
      isPackageInstalled: () => false,
    });
    expect(plan.ready).toBe(false);
    expect(plan.willDownload).toEqual(['qwen2.5-coder:7b']);
    expect(plan.blocked).toEqual([]);
  });

  it('ollama: missing binary → blocked (never auto-install third-party app)', () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      hasBinary: () => false,
      isPackageInstalled: () => false,
    });
    expect(plan.ready).toBe(false);
    expect(plan.blocked.some((b) => b.id === 'ollama')).toBe(true);
    expect(plan.willInstall).toEqual([]);
  });

  it('llama.cpp: missing npm dep → willInstall', () => {
    const plan = buildModelInstallPlan({
      backend: 'llama.cpp',
      weightsRef: 'my-model.gguf',
      modelPath: '/models/my-model.gguf',
      hasBinary: () => false,
      isPackageInstalled: () => false,
      isWeightCached: () => false,
    });
    expect(plan.willInstall).toEqual(['node-llama-cpp@^3']);
    expect(plan.runtimeDeps[0]?.status).toBe('missing');
    expect(plan.weights.status).toBe('satisfied'); // modelPath set
  });

  it('llama.cpp: npm present + modelPath → ready', () => {
    const plan = buildModelInstallPlan({
      backend: 'llama.cpp',
      weightsRef: 'my-model.gguf',
      modelPath: '/models/my-model.gguf',
      hasBinary: () => false,
      isPackageInstalled: (spec) => spec.includes('node-llama-cpp'),
      isWeightCached: () => false,
    });
    expect(plan.ready).toBe(true);
    expect(plan.willInstall).toEqual([]);
  });

  it('llama.cpp catalog ref uses vibgrate channel and willDownload when uncached', () => {
    const plan = buildModelInstallPlan({
      backend: 'llama.cpp',
      weightsRef: 'qwen2.5-coder-3b-q4_k_m.gguf',
      isPackageInstalled: (spec) => spec.includes('node-llama-cpp'),
      isWeightCached: () => false,
      hasBinary: () => false,
    });
    expect(plan.weights.channel).toBe('vibgrate');
    expect(plan.willDownload).toEqual(['qwen2.5-coder-3b-q4_k_m.gguf']);
    expect(plan.weights.downloadUrl).toMatch(/huggingface/);
  });

  it('offline blocks npm install and ollama download', () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:7b',
      installedNames: [],
      offline: true,
      hasBinary: () => true,
      isPackageInstalled: () => false,
    });
    expect(plan.willDownload).toEqual([]);
    expect(plan.offlineBlocked).toBe(true);
    expect(plan.blocked.some((b) => /offline/i.test(b.reason))).toBe(true);
  });

  it('includes mode/pack metadata when provided', () => {
    const plan = buildModelInstallPlan({
      backend: 'ollama',
      weightsRef: 'qwen2.5-coder:3b',
      mode: 'spark',
      packId: 'spark@2026.07.1',
      installedNames: ['qwen2.5-coder:3b'],
      hasBinary: () => true,
    });
    expect(plan.mode).toBe('spark');
    expect(plan.packId).toBe('spark@2026.07.1');
    expect(plan.schemaVersion).toBe('model-install-plan/0');
  });
});
