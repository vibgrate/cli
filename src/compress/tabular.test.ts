import { describe, expect, it } from 'vitest';
import { parseCsv, parseFixedWidth, parseMarkdownTable, parseTabular, TabularCompressor, toRecords } from './tabular.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { csvTable } from './__fixtures__/samples.js';

describe('table parsing', () => {
  it('reads CSV, honouring quotes and embedded delimiters', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual({ headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']] });
    expect(parseCsv('a,b\n"x,1",2')).toEqual({ headers: ['a', 'b'], rows: [['x,1', '2']] });
    expect(parseCsv('a,b\n"he said ""hi""",2')).toEqual({ headers: ['a', 'b'], rows: [['he said "hi"', '2']] });
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] });
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('reads markdown tables and drops the separator row', () => {
    expect(parseMarkdownTable('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] });
    expect(parseMarkdownTable('| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |').rows).toHaveLength(2);
    expect(parseMarkdownTable('not a table')).toEqual({ headers: [], rows: [] });
  });

  it('reads fixed-width columns', () => {
    const { headers, rows } = parseFixedWidth('NAME    STATUS\nweb     ok\nworker  down');
    expect(headers).toEqual(['NAME', 'STATUS']);
    expect(rows).toEqual([['web', 'ok'], ['worker', 'down']]);
  });

  it('names the format it found, or says it found none', () => {
    expect(parseTabular(csvTable(10))).toMatchObject({ format: 'csv', headers: ['id', 'name', 'status', 'latency_ms'] });
    expect(parseTabular('| a | b |\n|---|---|\n| 1 | 2 |')).toMatchObject({ format: 'markdown' });
    expect(parseTabular('just a sentence')).toBeNull();
    expect(parseTabular('')).toBeNull();
  });

  it('zips headers and rows into records', () => {
    expect(toRecords(['a', 'b'], [['1', '2'], ['3', '4']])).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    // a short row is padded rather than shifting the columns
    expect(toRecords(['a', 'b'], [['1']])).toEqual([{ a: '1', b: '' }]);
  });
});

describe('TabularCompressor', () => {
  it('leaves a CSV alone when re-rendering it would not be smaller', () => {
    // a plain CSV is already the compact form the crusher would produce
    const content = csvTable(200);
    const r = new TabularCompressor().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('passthrough');
    expect(r.content).toBe(content);
    expect(r.info).toContain('not_smaller');
  });

  it('routes a verbose markdown table through the crusher and shrinks it', () => {
    const header = '| id | name | status | notes |\n| --- | --- | --- | --- |';
    const rows = Array.from({ length: 200 }, (_, i) => `| ${i} | service-${i % 5} | ok | nothing to report for this row |`);
    const content = `${header}\n${rows.join('\n')}`;
    const r = new TabularCompressor().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('tabular');
    expect(r.content.length).toBeLessThan(content.length);
  });

  it('is deterministic and passes non-tables through', () => {
    const content = csvTable(50);
    expect(new TabularCompressor().compress(baseRequest(content))).toEqual(new TabularCompressor().compress(baseRequest(content)));
    for (const other of ['', 'prose, with a comma']) {
      const r = new TabularCompressor().compress(baseRequest(other));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
  });
});
