import { describe, it, expect } from 'vitest';
import { attachGrammar, assertGrammarOrThrow, allowGrammarStringFallback } from './grammar.js';

describe('attachGrammar', () => {
  it('returns none when no gbnf', async () => {
    const r = await attachGrammar({}, undefined);
    expect(r.applied).toBe(false);
    expect(r.method).toBe('none');
  });

  it('uses LlamaGrammar when constructible', async () => {
    class LlamaGrammar {
      g: string;
      constructor(_llama: unknown, opts: { grammar: string }) {
        this.g = opts.grammar;
      }
    }
    const lib = {
      LlamaGrammar,
      getLlama: async () => ({}),
    };
    const r = await attachGrammar(lib, 'root ::= "a"');
    expect(r.applied).toBe(true);
    expect(r.method).toBe('LlamaGrammar');
    expect(r.value).toBeInstanceOf(LlamaGrammar);
  });

  it('uses createGrammar when present', async () => {
    const lib = {
      createGrammar: async (g: string) => ({ g }),
    };
    const r = await attachGrammar(lib, 'root ::= "b"');
    expect(r.applied).toBe(true);
    expect(r.method).toBe('createGrammar');
  });

  it('string-fallback is not applied by default', async () => {
    const r = await attachGrammar({}, 'root ::= "c"');
    expect(r.method).toBe('string-fallback');
    expect(r.applied).toBe(false);
    expect(r.value).toBe('root ::= "c"');
  });
});

describe('assertGrammarOrThrow', () => {
  it('no-ops when requireGrammar is false', () => {
    expect(() =>
      assertGrammarOrThrow({ value: null, method: 'none', applied: false }, { requireGrammar: false }),
    ).not.toThrow();
  });

  it('throws when required and not applied', () => {
    expect(() =>
      assertGrammarOrThrow(
        { value: null, method: 'none', applied: false, reason: 'nope' },
        { requireGrammar: true },
      ),
    ).toThrow(/constrained decoding required/);
  });

  it('allows string fallback only when opted in', () => {
    const r = { value: 'root ::= "x"', method: 'string-fallback' as const, applied: false };
    expect(() => assertGrammarOrThrow(r, { requireGrammar: true })).toThrow(/constrained decoding required/);
    expect(() => assertGrammarOrThrow(r, { requireGrammar: true, allowStringFallback: true })).not.toThrow();
  });

  it('allowGrammarStringFallback reads env', () => {
    expect(allowGrammarStringFallback({})).toBe(false);
    expect(allowGrammarStringFallback({ VG_ALLOW_GRAMMAR_STRING_FALLBACK: '1' })).toBe(true);
  });
});
