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
      expect((e as Error).message).toMatch(/OPENROUTER_API_KEY|Ollama|--local/);
    }
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
});
