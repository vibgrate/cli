import { describe, it, expect } from 'vitest';
import { resolveProviders } from './router.js';
import type { LocalModel } from '../engine/models.js';
import { CliError } from '../util/exit.js';

const noModels = (): LocalModel[] => [];
const withOllama = (): LocalModel[] => [{ runtime: 'ollama', name: 'qwen2.5-coder:7b', path: '/x' }];

describe('resolveProviders', () => {
  it('forces the deterministic mock provider when a scripted reply is given', () => {
    const r = resolveProviders({ mockReply: 'hello' }, { env: {}, discover: noModels });
    expect(r.providers).toHaveLength(1);
    expect(r.providers[0].id).toBe('mock');
  });

  it('honors an explicit --provider ollama with the discovered model', () => {
    const r = resolveProviders({ provider: 'ollama' }, { env: {}, discover: withOllama });
    expect(r.providers[0].id).toBe('ollama');
    expect(r.providers[0].model).toBe('qwen2.5-coder:7b');
  });

  it('picks OpenRouter when OPENROUTER_API_KEY is set, with a local fallback appended', () => {
    const r = resolveProviders({ model: 'some/model' }, { env: { OPENROUTER_API_KEY: 'k' }, discover: withOllama });
    expect(r.providers[0].id).toBe('openrouter');
    expect(r.providers[0].local).toBe(false);
    // local fallback appended so a transport failure can degrade to on-device
    expect(r.providers.some((p) => p.id === 'ollama')).toBe(true);
  });

  it('prefers a local model over the network when NO hosted key is configured (no surprise egress)', () => {
    const r = resolveProviders({}, { env: {}, discover: withOllama });
    expect(r.providers[0].local).toBe(true);
    expect(r.providers[0].id).toBe('ollama');
  });

  it('errors actionably when nothing is configured and no local model exists', () => {
    expect(() => resolveProviders({}, { env: {}, discover: noModels })).toThrow(CliError);
    try {
      resolveProviders({}, { env: {}, discover: noModels });
    } catch (e) {
      expect((e as Error).message).toMatch(/OPENROUTER_API_KEY|models install|Ollama|--local/i);
    }
  });

  it('Code Mode is fail-closed to the Vibgrate manager (no LM Studio / Ollama auto-route)', () => {
    expect(() =>
      resolveProviders({ codeMode: true, model: 'qwen2.5-coder-3b-q4_k_m.gguf' }, { env: {}, discover: withOllama }),
    ).toThrow(/Vibgrate model manager|models install/i);
  });

  it('never auto-selects LM Studio even when lm-studio GGUFs are discovered', () => {
    const withLm = (): LocalModel[] => [
      { runtime: 'lm-studio', name: 'someone/model.gguf', path: '/lm/model.gguf' },
      { runtime: 'ollama', name: 'qwen2.5-coder:7b', path: '/x' },
    ];
    const r = resolveProviders({}, { env: {}, discover: withLm });
    expect(r.providers.every((p) => p.id !== 'lmstudio')).toBe(true);
    expect(r.manager).toBe('ollama');
    expect(r.managerLine).toMatch(/\[Ollama\]/);
  });

  it('exposes a manager badge for explicit custom providers', () => {
    const r = resolveProviders({ provider: 'ollama' }, { env: {}, discover: withOllama });
    expect(r.manager).toBe('ollama');
    expect(r.managerLine).toMatch(/\[Ollama\]/);
  });

  it('--local with no local backend fails rather than reaching the network', () => {
    expect(() => resolveProviders({ local: true }, { env: { OPENROUTER_API_KEY: 'k' }, discover: noModels })).toThrow(CliError);
  });

  it('--local selects only on-device backends even when a hosted key is present', () => {
    const r = resolveProviders({ local: true }, { env: { OPENROUTER_API_KEY: 'k' }, discover: withOllama });
    expect(r.providers.every((p) => p.local)).toBe(true);
  });

  it('a hosted provider requires an explicit model (no hard-coded model id)', () => {
    expect(() => resolveProviders({ provider: 'openrouter' }, { env: { OPENROUTER_API_KEY: 'k' }, discover: noModels })).toThrow(/model/);
  });

  it('llama-cpp requires a gguf path', () => {
    expect(() => resolveProviders({ provider: 'llama-cpp' }, { env: {}, discover: noModels })).toThrow(/gguf|model-path/);
  });

  it('accepts foundry-local as an explicit local OpenAI-compatible provider', () => {
    const r = resolveProviders(
      { provider: 'foundry-local', model: 'phi-4' },
      { env: {}, discover: noModels },
    );
    expect(r.providers[0].id).toBe('foundry-local');
    expect(r.providers[0].local).toBe(true);
  });

  it('puts embedded llama-cpp first when a real GGUF path is resolvable (Approach B default)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-route-'));
    const file = path.join(dir, 'coder.gguf');
    fs.writeFileSync(file, 'gguf');
    try {
      const r = resolveProviders(
        { model: 'coder' },
        {
          env: {},
          discover: () => [{ runtime: 'gguf', name: 'coder.gguf', path: file }],
        },
      );
      expect(r.providers[0].id).toBe('llama-cpp');
      expect(r.manager).toBe('vibgrate');
      expect(r.managerLine).toMatch(/\[Vibgrate\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Code Mode with a resolvable GGUF uses only the Vibgrate manager', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-route-cm-'));
    const file = path.join(dir, 'qwen2.5-coder-3b-q4_k_m.gguf');
    fs.writeFileSync(file, 'gguf');
    try {
      const r = resolveProviders(
        { codeMode: true, model: 'qwen2.5-coder-3b-q4_k_m.gguf', modelPath: file },
        {
          env: {},
          discover: () => [
            { runtime: 'ollama', name: 'qwen2.5-coder:3b', path: '/x' },
            { runtime: 'lm-studio', name: 'other.gguf', path: '/lm/x.gguf' },
          ],
        },
      );
      expect(r.providers).toHaveLength(1);
      expect(r.providers[0].id).toBe('llama-cpp');
      expect(r.manager).toBe('vibgrate');
      expect(r.reason).toMatch(/Code Mode|Vibgrate/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


