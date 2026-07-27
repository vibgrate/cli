import { describe, it, expect } from 'vitest';
import { buildIdentifierTrieFromGraph, trieEnumerateWords } from '../identifier-trie.js';
import {
  buildIdentifierTokenBias,
  planNextCharMask,
  tokenCompatibleWithTrie,
  trieFingerprint,
} from './logit-mask.js';

describe('logit-mask', () => {
  const trie = buildIdentifierTrieFromGraph({
    nodes: [{ name: 'readConfig' }, { name: 'scanDir' }],
  });

  it('enumerates trie words for boost targets', () => {
    const words = trieEnumerateWords(trie);
    expect(words).toEqual(expect.arrayContaining(['readConfig', 'scanDir']));
  });

  it('planNextCharMask follows trie', () => {
    expect(planNextCharMask(trie, 'read').length).toBeGreaterThan(0);
  });

  it('tokenCompatibleWithTrie accepts known ids and rejects ghosts', () => {
    expect(tokenCompatibleWithTrie('readConfig', trie)).toBe(true);
    expect(tokenCompatibleWithTrie('Config', trie, 'read')).toBe(true);
    expect(tokenCompatibleWithTrie('ghostFn', trie)).toBe(false);
  });

  it('trieFingerprint is stable for same trie', () => {
    expect(trieFingerprint(trie)).toBe(trieFingerprint(trie));
  });

  it('buildIdentifierTokenBias is none without TokenBias class', () => {
    const r = buildIdentifierTokenBias({}, { tokenize: () => [] }, trie);
    expect(r.applied).toBe(false);
    expect(r.method).toBe('none');
  });

  it('buildIdentifierTokenBias boosts known tokens when TokenBias is available', () => {
    const sets: Array<{ token: unknown; value: unknown }> = [];
    class TokenBias {
      constructor(_tokenizer: unknown) {}
      set(token: unknown, value: unknown) {
        sets.push({ token, value });
      }
    }
    const model = {
      tokenizer: {},
      tokenize: (s: string) => s.split('').map((c, i) => `${s}:${i}:${c}`),
      detokenize: (toks: unknown[]) => String(toks[0] ?? ''),
      iterateAllTokens: function* () {
        yield 'tok:ghostFn';
        yield 'tok:readConfig';
      },
    };
    // Make detokenize return the id string for suppress path
    model.detokenize = (toks: unknown[]) => {
      const t = String(toks[0] ?? '');
      if (t === 'tok:ghostFn') return 'ghostFn';
      if (t === 'tok:readConfig') return 'readConfig';
      return t;
    };

    const r = buildIdentifierTokenBias({ TokenBias }, model, trie, { suppressUnknown: true });
    expect(r.applied).toBe(true);
    expect(r.method === 'TokenBias' || r.method === 'TokenBias-boost').toBe(true);
    expect(r.boostedTokens).toBeGreaterThan(0);
    expect(r.tokenBias).toBeTruthy();
    // ghostFn complete unknown should be suppressed
    expect(r.suppressedTokens).toBeGreaterThanOrEqual(1);
    expect(sets.some((s) => s.value === 'never' || (typeof s.value === 'number' && s.value < 0))).toBe(true);
  });

  it('capability method when iterateAllTokens but no TokenBias', () => {
    const r = buildIdentifierTokenBias(
      {},
      { iterateAllTokens: function* () { yield 1; } },
      trie,
    );
    expect(r.method).toBe('capability');
    expect(r.applied).toBe(false);
  });
});
