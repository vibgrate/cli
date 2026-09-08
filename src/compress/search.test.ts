import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_CONFIG, cjkBigrams, formatSearchOutput, parseMatchLine, parseSearchResults, priorityBoost, SearchCompressor, scoreMatches, selectMatches } from './search.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { grepOutput } from './__fixtures__/samples.js';

describe('parsing grep-shaped output', () => {
  it('splits `file:line:content`, and nothing else', () => {
    expect(parseMatchLine('src/a.ts:42:  const x = 1;')).toEqual(['src/a.ts', 42, '  const x = 1;']);
    // a windows drive letter is part of the path, not a line number
    expect(parseMatchLine('C:\\src\\a.ts:42:x')).toEqual(['C:\\src\\a.ts', 42, 'x']);
    expect(parseMatchLine('no line number here')).toBeNull();
    expect(parseMatchLine('src/a.ts:notanumber:x')).toBeNull();
    expect(parseMatchLine('')).toBeNull();
  });

  it('groups matches by file and counts what it could not parse', () => {
    const parsed = parseSearchResults(grepOutput(4, 5));
    expect(parsed.files.size).toBe(4);
    expect(parsed.scanned).toBe(20);
    expect(parsed.unparsed).toBe(0);
    for (const matches of parsed.files.values()) expect(matches).toHaveLength(5);
    // lines that are not `file:line:content` are counted, never invented into a file
    const noisy = parseSearchResults('src/a.ts:1:hit\nsearching...\nsrc/a.ts:2:hit');
    expect(noisy.files.size).toBe(1);
    expect(noisy.unparsed).toBe(1);
  });

  it('boosts matching lines by severity keyword, in the documented order', () => {
    expect(priorityBoost('throw new Error("failed")')).toBe(0.5);
    expect(priorityBoost('console.warn("deprecated")')).toBe(0.4);
    expect(priorityBoost('// TODO: revisit this')).toBe(0.3);
    // an ordinary line of code gets no boost — this ranks severity, not syntax
    expect(priorityBoost('export function loadConfig() {')).toBe(0);
    expect(priorityBoost('  const x = 1;')).toBe(0);
  });

  it('indexes CJK by bigram, since it has no spaces to split on', () => {
    expect([...cjkBigrams('数据库连接')]).toEqual(['数据', '据库', '库连', '连接']);
    expect(cjkBigrams('plain ascii').size).toBe(0);
    expect(cjkBigrams('数').size).toBe(0);
  });
});

describe('selection', () => {
  it('caps matches per file and keeps the ones the query is about', () => {
    const parsed = parseSearchResults(grepOutput(6, 12));
    scoreMatches(parsed.files, 'failed to load user', DEFAULT_SEARCH_CONFIG);
    const selected = selectMatches(parsed.files, 1, DEFAULT_SEARCH_CONFIG);
    const kept = [...selected.values()].flat();
    expect(kept.length).toBeLessThan(parsed.scanned);
    for (const matches of selected.values()) expect(matches.length).toBeLessThanOrEqual(DEFAULT_SEARCH_CONFIG.maxMatchesPerFile);
    // the line the query names survives the cut
    expect(kept.some((m) => m.content.includes('failed to load user'))).toBe(true);
    // matches stay in file order within each file
    for (const matches of selected.values()) {
      const lines = matches.map((m) => m.lineNumber);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
    }
  });

  it('says how much it left out, per file', () => {
    const content = grepOutput(3, 20);
    const parsed = parseSearchResults(content);
    scoreMatches(parsed.files, '', DEFAULT_SEARCH_CONFIG);
    const selected = selectMatches(parsed.files, 1, DEFAULT_SEARCH_CONFIG);
    const out = formatSearchOutput(selected, parsed.files, DEFAULT_SEARCH_CONFIG);
    expect(out).toMatch(/and \d+ more matches? in /);
    expect(out.length).toBeLessThan(content.length);
  });
});

describe('SearchCompressor', () => {
  it('reports the match and file counts it kept', () => {
    const content = grepOutput(6, 12);
    const r = new SearchCompressor().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true, query: 'timeout' }));
    expect(r.strategy).toBe('search');
    expect(r.chain).toEqual(['search']);
    expect(r.info).toMatch(/^search\(\d+->\d+ matches, \d+ files\)$/);
    expect(r.itemCounts!.original).toBe(72);
    expect(r.itemCounts!.kept).toBeLessThan(72);
    expect(r.content.length).toBeLessThan(content.length);
  });

  it('is deterministic and passes through anything that is not grep output', () => {
    const content = grepOutput(4, 8);
    expect(new SearchCompressor().compress(baseRequest(content))).toEqual(new SearchCompressor().compress(baseRequest(content)));
    for (const other of ['', 'just some prose about searching', 'a\nb\nc']) {
      const r = new SearchCompressor().compress(baseRequest(other));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
  });
});
