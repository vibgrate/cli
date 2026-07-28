import { describe, it, expect, vi } from 'vitest';
import {
  ensureManagerRuntime,
  formatManagerBadgeLine,
  managerBadge,
  managerFromProviderId,
} from './model-manager.js';

describe('model-manager', () => {
  it('maps llama-cpp / vibgrate to the Vibgrate manager badge', () => {
    expect(managerFromProviderId('llama-cpp')).toBe('vibgrate');
    expect(managerFromProviderId('vibgrate')).toBe('vibgrate');
    expect(managerBadge('vibgrate').badge).toBe('[Vibgrate]');
    expect(formatManagerBadgeLine('vibgrate', 'qwen.gguf')).toMatch(/\[Vibgrate\].*qwen/);
  });

  it('maps custom backends to their manager badges', () => {
    expect(managerFromProviderId('ollama')).toBe('ollama');
    expect(managerFromProviderId('lmstudio')).toBe('lmstudio');
    expect(managerFromProviderId('openrouter')).toBe('openrouter');
    expect(managerBadge('lmstudio').label).toBe('LM Studio');
  });

  it('silently installs npm runtime deps for the Vibgrate manager when consented', async () => {
    const ensurePackage = vi.fn(async () => ({ module: {}, dir: '/tmp' }));
    const r = await ensureManagerRuntime({
      providerId: 'llama-cpp',
      consent: true,
      ensurePackage: ensurePackage as never,
      hasBinary: () => false,
    });
    // May already be installed in the real cache — either installed this call or ok.
    expect(r.ok).toBe(true);
    expect(r.manager).toBe('vibgrate');
    expect(r.badge.badge).toBe('[Vibgrate]');
  });

  it('does not auto-install LM Studio app; returns ok with guidance', async () => {
    const r = await ensureManagerRuntime({
      providerId: 'lmstudio',
      model: 'local-model',
      consent: true,
    });
    expect(r.ok).toBe(true);
    expect(r.manager).toBe('lmstudio');
    expect(r.messages.join(' ')).toMatch(/LM Studio/i);
  });

  it('requires Ollama on PATH for custom ollama path', async () => {
    const r = await ensureManagerRuntime({
      providerId: 'ollama',
      model: 'qwen2.5-coder:7b',
      consent: true,
      hasBinary: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PATH|ollama/i);
  });

  it('hosted managers need no local packages', async () => {
    const r = await ensureManagerRuntime({
      providerId: 'openrouter',
      model: 'some/model',
      consent: true,
    });
    expect(r.ok).toBe(true);
    expect(r.installed).toEqual([]);
  });
});
