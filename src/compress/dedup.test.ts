import { describe, expect, it } from 'vitest';
import { dedupBlocks, dedupPointer, isPrefixMonotonic, normalizedLines, type DedupBlock } from './dedup.js';

const FILE = ['import os', 'def main():', '    print("hello world")', '    return 0', 'if __name__ == "__main__":', '    main()'].join('\n');

function block(text: string, messageIndex: number, extra: Partial<DedupBlock> = {}): DedupBlock {
  return { text, messageIndex, protected: false, tokens: Math.ceil(text.length / 4), ...extra };
}

describe('dedupBlocks', () => {
  it('folds a verbatim repeat into the §3.4 pointer, keeping the earliest copy', () => {
    const { texts, folds } = dedupBlocks([block(FILE, 2), block('other', 4), block(FILE, 6)]);
    expect(texts[0]).toBe(FILE);
    expect(texts[1]).toBe('other');
    expect(texts[2]).toBe(dedupPointer(2, Math.ceil(FILE.length / 4)));
    expect(texts[2]).toBe(`[duplicate of tool result #2 — ${Math.ceil(FILE.length / 4)} tokens omitted]`);
    expect(folds).toEqual([{ index: 2, refMessageIndex: 2, kind: 'verbatim', pointer: texts[2], tokensOmitted: Math.ceil(FILE.length / 4) }]);
  });

  it('respects min lines / chars and protected blocks (still reference targets)', () => {
    expect(dedupBlocks([block('a\nb', 0), block('a\nb', 1)]).folds).toEqual([]);
    const { texts } = dedupBlocks([block(FILE, 0, { protected: true }), block(FILE, 1, { protected: true }), block(FILE, 2)]);
    expect(texts[1]).toBe(FILE);
    expect(texts[2]).toMatch(/#0/);
  });

  it('ignores trailing whitespace and line-number renumbering', () => {
    const numbered = FILE.split('\n')
      .map((l, i) => `${i + 10}:${l}`)
      .join('\n');
    const shifted = FILE.split('\n')
      .map((l, i) => `${i + 12}:${l}`)
      .join('\n');
    expect(dedupBlocks([block(numbered, 1), block(shifted, 3)]).folds[0]?.kind).toBe('verbatim');
    expect(dedupBlocks([block(FILE, 1), block(`${FILE}   `, 3)]).folds).toHaveLength(1);
    expect(normalizedLines('12:x\t')[0]).toEqual({ num: 12, key: ':x' });
  });

  it('near-verbatim folds need recoverable + hash and carry a retrieval hint', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} payload ${i * 2}`);
    const a = lines.join('\n');
    const b = [...lines.slice(0, 39), 'line 39 changed'].join('\n');
    expect(dedupBlocks([block(a, 0), block(b, 2)]).folds).toEqual([]);
    const r = dedupBlocks([block(a, 0), block(b, 2, { hash: 'abcdef0123456789abcdef01' })], { recoverable: true });
    expect(r.folds[0]?.kind).toBe('near_verbatim');
    expect(r.texts[1]).toMatch(/^\[duplicate of tool result #0 — \d+ tokens omitted\]\nRetrieve original: hash=abcdef0123456789abcdef01/);
  });

  it('is prefix-monotonic and deterministic', () => {
    const blocks = [block(FILE, 0), block('x\ny\nz\nw\nv\nu a very long trailing line here, past the floor', 1), block(FILE, 2), block(FILE, 3), block('x\ny\nz\nw\nv\nu a very long trailing line here, past the floor', 4)];
    expect(isPrefixMonotonic(blocks)).toBe(true);
    expect(dedupBlocks(blocks)).toEqual(dedupBlocks(blocks));
    expect(dedupBlocks(blocks).texts[3]).toMatch(/#0/);
    expect(dedupBlocks(blocks).texts[4]).toMatch(/#1/);
  });
});
