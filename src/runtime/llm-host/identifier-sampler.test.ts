import { describe, it, expect } from 'vitest';
import { buildIdentifierTrieFromGraph } from '../identifier-trie.js';
import {
  createIdentStreamState,
  stepIdentStream,
  filterTokenTexts,
  attachDynamicIdentFilter,
  dynamicAllowedNextChars,
} from './identifier-sampler.js';

describe('identifier-sampler', () => {
  const trie = buildIdentifierTrieFromGraph({
    nodes: [{ name: 'readConfig' }, { name: 'scanDir' }],
  });

  it('allows free text until an identifier starts', () => {
    let s = createIdentStreamState();
    let r = stepIdentStream(s, 'return ', trie);
    expect(r.allowed).toBe(true);
    expect(r.next.mode).toBe('free');
    r = stepIdentStream(r.next, 'read', trie);
    expect(r.allowed).toBe(true);
    expect(r.next.mode).toBe('in_ident');
    expect(r.next.prefix).toBe('read');
  });

  it('blocks inventing a ghost identifier', () => {
    const s = createIdentStreamState();
    const r = stepIdentStream(s, 'ghostFn', trie);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not in graph trie/);
  });

  it('allows completing a known identifier then punctuation', () => {
    let s = createIdentStreamState();
    s = stepIdentStream(s, 'readConfig', trie).next;
    expect(s.mode).toBe('in_ident');
    expect(s.prefix).toBe('readConfig');
    const r = stepIdentStream(s, '()', trie);
    expect(r.allowed).toBe(true);
    expect(r.next.mode).toBe('free');
  });

  it('filterTokenTexts keeps only legal candidates', () => {
    const s = stepIdentStream(createIdentStreamState(), 'read', trie).next;
    const kept = filterTokenTexts(s, ['Config', 'XYZ', 'C'], trie);
    expect(kept).toContain('Config');
    expect(kept).not.toContain('XYZ');
  });

  it('dynamicAllowedNextChars null in free mode', () => {
    expect(dynamicAllowedNextChars(createIdentStreamState(), trie)).toBeNull();
    const s = stepIdentStream(createIdentStreamState(), 'read', trie).next;
    expect(dynamicAllowedNextChars(s, trie)?.length).toBeGreaterThan(0);
  });

  it('attachDynamicIdentFilter installs onToken when capability set', () => {
    const opts: Record<string, unknown> = {};
    const r = attachDynamicIdentFilter(opts, trie, { onTokenCallback: true });
    expect(r.attached).toBe(true);
    expect(r.method).toBe('onToken');
    expect(typeof opts.onToken).toBe('function');
    const onToken = opts.onToken as (t: string) => boolean;
    expect(onToken('read')).toBe(true);
    expect(onToken('ZZZbad')).toBe(false);
  });
});
