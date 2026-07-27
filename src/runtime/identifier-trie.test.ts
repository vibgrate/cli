import { describe, it, expect } from 'vitest';
import {
  buildIdentifierTrieFromGraph,
  trieComplete,
  trieHas,
  trieHasPrefix,
  trieAllowedNextChars,
  trieEnumerateWords,
  createTrieNode,
  trieInsert,
} from './identifier-trie.js';

describe('identifier-trie', () => {
  it('inserts and queries', () => {
    const root = createTrieNode();
    trieInsert(root, 'foo');
    trieInsert(root, 'for');
    expect(trieHas(root, 'foo')).toBe(true);
    expect(trieHas(root, 'bar')).toBe(false);
    expect(trieHasPrefix(root, 'fo')).toBe(true);
    expect(trieComplete(root, 'fo').sort()).toEqual(['foo', 'for']);
    expect(trieAllowedNextChars(root, 'fo').sort()).toEqual(['o', 'r']);
    expect(trieEnumerateWords(root).sort()).toEqual(['foo', 'for']);
  });

  it('builds from graph node names', () => {
    const trie = buildIdentifierTrieFromGraph({
      nodes: [
        { name: 'readConfig', qualifiedName: 'pkg.util.readConfig' },
        { name: 'writeConfig', qualifiedName: 'pkg.util.writeConfig' },
      ],
    });
    expect(trieHas(trie, 'readConfig')).toBe(true);
    expect(trieHas(trie, 'writeConfig')).toBe(true);
    expect(trieHas(trie, 'util')).toBe(true); // segment
    expect(trieComplete(trie, 'read').some((s) => s.includes('readConfig'))).toBe(true);
    expect(trieEnumerateWords(trie)).toEqual(expect.arrayContaining(['readConfig', 'writeConfig', 'util']));
  });
});
