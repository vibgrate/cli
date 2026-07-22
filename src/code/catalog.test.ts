import { describe, it, expect, vi } from 'vitest';
import { parseModels, groupModels, fetchCatalog, topProviders } from './catalog.js';

const payload = {
  data: [
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'x-ai/grok-code', name: 'Grok Code', context_length: 256000, pricing: { prompt: '0', completion: '0' } },
    { id: 'qwen/qwen-2.5-coder-7b', name: 'Qwen2.5 Coder 7B', context_length: 32000, pricing: { prompt: '0', completion: '0' } },
    { id: 'not-a-slug', name: 'junk' }, // no provider → skipped
  ],
};

describe('parseModels', () => {
  it('parses ids, providers, context and per-million pricing; skips non-slug ids', () => {
    const models = parseModels(payload);
    expect(models).toHaveLength(4);
    const claude = models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')!;
    expect(claude.provider).toBe('anthropic');
    expect(claude.contextLength).toBe(200000);
    expect(claude.promptPricePerM).toBe(3); // 0.000003 * 1e6
  });

  it('returns [] on a malformed payload', () => {
    expect(parseModels({})).toEqual([]);
    expect(parseModels(null)).toEqual([]);
  });
});

describe('groupModels', () => {
  it('groups by provider and orders featured providers first', () => {
    const groups = groupModels(parseModels(payload));
    const ids = groups.map((g) => g.id);
    // anthropic, openai, x-ai come before qwen in the featured order
    expect(ids.indexOf('anthropic')).toBeLessThan(ids.indexOf('qwen'));
    expect(groups[0].label).toBe('Anthropic (Claude)');
  });
});

describe('fetchCatalog', () => {
  it('returns a network catalog from a stubbed fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const cat = await fetchCatalog({ fetchImpl, noCache: true, now: () => 1000 });
    expect(cat.source).toBe('network');
    expect(cat.fresh).toBe(true);
    expect(topProviders(cat, 3).length).toBe(3);
  });

  it('falls back to the curated provider list when offline with no cache', async () => {
    // offline + a cache path that won't exist under a throwaway XDG dir.
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/nonexistent-vg-cache-xyz';
    try {
      const cat = await fetchCatalog({ offline: true });
      expect(cat.source).toBe('fallback');
      expect(cat.providers.length).toBeGreaterThan(0);
      // Fallback carries provider names but no hard-coded model ids.
      expect(cat.providers.every((p) => p.models.length === 0)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });

  it('falls back (not throws) when the network fails and there is no cache', async () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/nonexistent-vg-cache-abc';
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    try {
      const cat = await fetchCatalog({ fetchImpl, noCache: true });
      expect(cat.source).toBe('fallback');
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});
