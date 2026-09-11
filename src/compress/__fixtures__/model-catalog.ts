import { setModelCatalogForTests, type ModelCatalogSnapshot } from '../../engine/model-catalog-provider.js';

/**
 * A deliberately tiny catalog: enough rows to exercise RESOLUTION — exact id,
 * alias, dated snapshot, case folding, gateway unwrapping, priced and unpriced
 * — and nothing more.
 *
 * It is not a copy of the shipped catalog and must not grow into one. What the
 * real `data/models/capabilities.json` contains is asserted where that file
 * lives, in the relevance package; duplicating those rows here would recreate
 * the very table this seam exists to delete, and the copy would drift.
 */
export const FIXTURE_CATALOG: ModelCatalogSnapshot = {
  version: '2026.09.11',
  models: [
    {
      id: 'claude-opus-5',
      family: 'anthropic',
      contextLimit: 1_000_000,
      maxOutput: 128_000,
      billsThinking: true,
      supportsCacheControl: true,
      aliases: [],
      price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
    {
      id: 'claude-haiku-4-5',
      family: 'anthropic',
      contextLimit: 200_000,
      maxOutput: 64_000,
      billsThinking: false,
      supportsCacheControl: true,
      aliases: ['claude-haiku-4-5-20251001'],
      price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
    {
      id: 'gpt-4o',
      family: 'openai',
      contextLimit: 128_000,
      maxOutput: 16_384,
      billsThinking: false,
      supportsCacheControl: false,
      aliases: ['gpt-4o-2024-08-06'],
      price: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: null },
    },
    {
      // Unpriced on purpose: the resolver must fall through to inference for a
      // price while still honouring the catalogued window.
      id: 'house-model-1',
      family: 'other',
      contextLimit: 64_000,
      maxOutput: null,
      billsThinking: false,
      supportsCacheControl: false,
      aliases: [],
      price: null,
    },
  ],
};

/** Install the fixture as the primed catalog for one test. */
export function useFixtureCatalog(): void {
  setModelCatalogForTests(FIXTURE_CATALOG);
}

/** Run as if no relevance module were installed. */
export function useNoCatalog(): void {
  setModelCatalogForTests(null);
}
