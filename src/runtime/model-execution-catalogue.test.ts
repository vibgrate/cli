import { describe, it, expect } from 'vitest';
import { listCatalogueNeedles, matchCatalogueProfile } from './model-execution-catalogue.js';

describe('matchCatalogueProfile', () => {
  it('matches qwen coder spark and flow', () => {
    const spark = matchCatalogueProfile('qwen2.5-coder:1.5b-instruct-q4_K_M');
    expect(spark?.mode).toBe('spark');
    expect(spark?.constrainedDecoding).toBe(true);

    const flow = matchCatalogueProfile('qwen2.5-coder:7b');
    expect(flow?.mode).toBe('flow');
    expect(flow?.capsuleBudgetTokens).toBe(3500);
  });

  it('prefers the longest match', () => {
    const p = matchCatalogueProfile('qwen2.5-coder:32b-instruct');
    expect(p?.mode).toBe('forge');
    expect(p?.capsuleBudgetTokens).toBe(6000);
  });

  it('returns null for unknown models', () => {
    expect(matchCatalogueProfile('totally-unknown-model-xyz')).toBeNull();
  });

  it('lists needles stably', () => {
    const a = listCatalogueNeedles();
    const b = listCatalogueNeedles();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(5);
  });
});
