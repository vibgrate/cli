import { describe, it, expect } from 'vitest';
import { probeInferenceBackends, summarizeBackendHealth } from './inference-adapters.js';

describe('probeInferenceBackends', () => {
  it('reports ollama when binary present', () => {
    const health = probeInferenceBackends({
      hasBinary: (n) => n === 'ollama',
      discover: () => [{ runtime: 'ollama', name: 'qwen:7b', path: '/x' }],
      probeHttp: () => false,
    });
    const ollama = health.find((h) => h.id === 'ollama')!;
    expect(ollama.available).toBe(true);
    expect(ollama.models).toEqual(['qwen:7b']);
  });

  it('reports lm-studio when server up', () => {
    const health = probeInferenceBackends({
      hasBinary: () => false,
      discover: () => [],
      probeHttp: () => true,
    });
    expect(health.find((h) => h.id === 'lm-studio')?.available).toBe(true);
  });

  it('reports foundry when CLI on PATH', () => {
    const health = probeInferenceBackends({
      hasBinary: (n) => n === 'foundry',
      discover: () => [],
      probeHttp: () => false,
    });
    expect(health.find((h) => h.id === 'foundry-local')?.available).toBe(true);
  });

  it('lists foundry models when server is up', () => {
    const health = probeInferenceBackends({
      hasBinary: () => false,
      discover: () => [],
      probeHttp: (url) => url.includes('5272'),
      listModels: () => ['phi-4-mini', 'qwen2.5-coder'],
    });
    const f = health.find((h) => h.id === 'foundry-local')!;
    expect(f.available).toBe(true);
    expect(f.models).toContain('phi-4-mini');
  });

  it('summarize lists available backends', () => {
    const s = summarizeBackendHealth([
      { id: 'ollama', available: true, label: 'Ollama', models: [] },
      { id: 'lm-studio', available: false, label: 'LM Studio', models: [] },
    ]);
    expect(s).toContain('ollama');
    expect(s).not.toContain('lm-studio');
  });
});
