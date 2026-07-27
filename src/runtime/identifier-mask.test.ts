import { describe, it, expect } from 'vitest';
import { buildIdentifierTrieFromGraph } from './identifier-trie.js';
import {
  extractIdentifiers,
  scanIdentifiersAgainstTrie,
  annotateUnknownIdentifiers,
  maskAllowedNextChars,
} from './identifier-mask.js';

describe('identifier-mask', () => {
  const trie = buildIdentifierTrieFromGraph({
    nodes: [{ name: 'readConfig', qualifiedName: 'app.readConfig' }, { name: 'writeConfig' }],
  });

  it('extracts identifiers skipping stopwords', () => {
    const ids = extractIdentifiers('const x = readConfig(); function foo() { return true; }');
    expect(ids).toContain('readConfig');
    expect(ids).not.toContain('const');
    expect(ids).not.toContain('true');
  });

  it('scans known vs unknown', () => {
    const scan = scanIdentifiersAgainstTrie('call readConfig then missingFn', trie);
    expect(scan.known).toContain('readConfig');
    expect(scan.unknown).toContain('missingFn');
    expect(scan.clean).toBe(false);
  });

  it('annotates when unknown present', () => {
    const { text, unknown } = annotateUnknownIdentifiers('use ghostFn here', trie);
    expect(unknown).toContain('ghostFn');
    expect(text).toMatch(/vg: unknown identifiers/);
  });

  it('maskAllowedNextChars follows trie', () => {
    expect(maskAllowedNextChars(trie, 'read').length).toBeGreaterThan(0);
  });
});
