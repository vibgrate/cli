import { describe, it, expect } from 'vitest';
import { patchIrGbnf, shouldUsePatchIrGrammar } from './patch-ir-grammar.js';

describe('patchIrGbnf', () => {
  it('emits a non-empty GBNF with PatchIR schema version and ops', () => {
    const g = patchIrGbnf();
    expect(g.length).toBeGreaterThan(200);
    expect(g).toContain('patch-ir/0');
    expect(g).toContain('replace-range');
    expect(g).toContain('replace-text');
    expect(g).toContain('create-file');
    expect(g).toContain('grammar-constrained');
    expect(g).toMatch(/^root\s*::=/m);
  });
});

describe('shouldUsePatchIrGrammar', () => {
  it('is true when constrainedDecoding is on', () => {
    expect(shouldUsePatchIrGrammar({ constrainedDecoding: true })).toBe(true);
  });

  it('is true for toolCalling grammar', () => {
    expect(shouldUsePatchIrGrammar({ toolCalling: 'grammar' })).toBe(true);
  });

  it('is false for default flow-like profile', () => {
    expect(shouldUsePatchIrGrammar({ constrainedDecoding: false, toolCalling: 'native' })).toBe(false);
  });

  it('is false when profile missing', () => {
    expect(shouldUsePatchIrGrammar(null)).toBe(false);
    expect(shouldUsePatchIrGrammar(undefined)).toBe(false);
  });
});
