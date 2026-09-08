import { describe, expect, it } from 'vitest';
import {
  analyzeField,
  crushArray,
  DEFAULT_CRUSHER_CONFIG,
  detectErrorItems,
  detectIdField,
  detectRareStatusValues,
  detectSequentialPattern,
  detectStructuralOutliers,
  ERROR_KEYWORDS,
  isUuidFormat,
  mean,
  median,
  percentileLinear,
  sampleStdev,
  sampleVariance,
  SmartCrusher,
  stringEntropy,
} from './crusher.js';
import { baseRequest, MemorySink, ThrowingSink } from './__fixtures__/sink.js';
import { jsonLogRows } from './__fixtures__/samples.js';

/** The lossy row-drop path only runs when csv-schema compaction is off (see the first suite). */
const lossy = (): SmartCrusher => new SmartCrusher({ withCompaction: false });

describe('statistics helpers', () => {
  it('computes mean, variance, stdev, median and linear percentiles', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    // sample (n-1) variance, not population
    expect(sampleVariance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571, 3);
    expect(sampleVariance([5])).toBe(0);
    expect(sampleStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    // linear interpolation between neighbours, matching numpy's default
    expect(percentileLinear([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileLinear([1, 2, 3, 4], 0)).toBe(1);
    expect(percentileLinear([1, 2, 3, 4], 1)).toBe(4);
    expect(percentileLinear([10], 0.9)).toBe(10);
  });

  it('recognises uuids and measures how evenly a string uses its own alphabet', () => {
    expect(isUuidFormat('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isUuidFormat('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    expect(isUuidFormat('not-a-uuid')).toBe(false);
    // entropy is normalised by log2(distinct symbols), so it reads 1 for any
    // string whose symbols are equiprobable and 0 when there is nothing to say
    expect(stringEntropy('')).toBe(0);
    expect(stringEntropy('a')).toBe(0);
    expect(stringEntropy('aaaa')).toBe(0);
    expect(stringEntropy('abcd')).toBe(1);
    expect(stringEntropy('aaaabbbb')).toBe(1);
    expect(stringEntropy('aaaaaaab')).toBeLessThan(0.6);
  });

  it('detects unit-step id sequences, ordered or not', () => {
    expect(detectSequentialPattern([1, 2, 3, 4, 5])).toBe(true);
    expect(detectSequentialPattern([5, 3, 1, 4, 2])).toBe(false);
    expect(detectSequentialPattern([5, 3, 1, 4, 2], false)).toBe(true);
    // ids step by one — an arithmetic run with any other step is not an id column
    expect(detectSequentialPattern([10, 20, 30, 40, 50])).toBe(false);
    expect(detectSequentialPattern([1, 2, 4, 8, 16])).toBe(false);
    // fewer than five values, or values that are only strings, decide nothing
    expect(detectSequentialPattern([1, 2, 3, 4])).toBe(false);
    expect(detectSequentialPattern(['1', '2', '3', '4', '5'])).toBe(false);
    expect(detectSequentialPattern(['a', 'b'])).toBe(false);
  });
});

describe('field analysis and role detection', () => {
  const rows = jsonLogRows(60, 30);

  it('summarises a field: type, cardinality and its commonest values', () => {
    const level = analyzeField('level', rows);
    expect(level).toMatchObject({ name: 'level', fieldType: 'string', count: 60, uniqueCount: 2, isConstant: false, constantValue: 'info' });
    // 59 info rows and the one seeded error
    expect(level.topValues).toEqual([['info', 59], ['error', 1]]);
    const id = analyzeField('id', rows);
    expect(id).toMatchObject({ fieldType: 'numeric', uniqueCount: 60, uniqueRatio: 1, min: 1, max: 60, mean: 30.5 });
    // a field absent from every row types as `null` with nothing to summarise
    expect(analyzeField('nope', rows)).toMatchObject({ fieldType: 'null', uniqueCount: 0, topValues: [] });
    // a field only some rows carry counts the values that are actually there
    expect(analyzeField('tag', [{ a: 1 }, { a: 2, tag: 'x' }, { a: 3 }])).toMatchObject({ fieldType: 'string', uniqueCount: 2, topValues: [['x', 1]] });
  });

  it('flags identifier-shaped fields and rare status values', () => {
    // a unit-step numeric column is the clearest id; a column of unique strings
    // is id-shaped too, with lower confidence
    const [idIsId, idConfidence] = detectIdField(analyzeField('id', rows), rows.map((r) => r.id));
    expect(idIsId).toBe(true);
    const [msgIsId, msgConfidence] = detectIdField(analyzeField('message', rows), rows.map((r) => r.message));
    expect(msgIsId).toBe(true);
    expect(msgConfidence).toBeLessThan(idConfidence);
    // a column with only a couple of repeated values is not an id
    expect(detectIdField(analyzeField('level', rows), rows.map((r) => r.level))[0]).toBe(false);
    // `level` is 'info' everywhere except the seeded error row → that row is the rare one
    expect(detectRareStatusValues(rows, ['level'])).toEqual([30]);
  });

  it('flags error items by keyword and rows with an unusual shape', () => {
    const hits = detectErrorItems(rows);
    expect(hits).toContain(30);
    expect(hits.length).toBeLessThan(rows.length);
    expect(ERROR_KEYWORDS).toContain('timeout');
    expect(detectErrorItems([{ msg: 'all good' }, { msg: 'panic: nil map' }])).toEqual([1]);
    // a key carried by fewer than a fifth of the rows marks its row as odd;
    // fewer than five rows is too little to call anything an outlier
    const ragged = [...Array.from({ length: 9 }, (_, i) => ({ a: i })), { a: 9, stacktrace: 'boom' }];
    expect(detectStructuralOutliers(ragged)).toEqual([9]);
    expect(detectStructuralOutliers([{ a: 1 }, { a: 2, weird: true }])).toEqual([]);
  });
});

describe('SmartCrusher — lossless compaction', () => {
  it('renders a uniform array as a csv-schema table, keeping every row', () => {
    const rows = jsonLogRows(120);
    const r = new SmartCrusher().compress(baseRequest(JSON.stringify(rows), { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('smart_crusher');
    // lossless: the fold is recorded in the chain and no original needs storing
    expect(r.chain).toEqual(['lossless_json', 'smart_crusher']);
    expect(r.info).toBe('lossless:table(120 rows)');
    expect(r.ccrHashes).toEqual([]);
    expect(r.itemCounts).toEqual({ original: 120, kept: 120 });
    expect(r.content.split('\n')[0]).toBe('[120]{id:int,level:string,message:string,service:string,ts:string}');
    expect(r.content.length).toBeLessThan(JSON.stringify(rows).length);
    // every row survives, including the seeded error: header + 120 rows + trailing newline
    expect(r.content.split('\n')).toHaveLength(122);
    expect(r.content).toContain('ETIMEDOUT');
  });

  it('prefers that lossless table over a lossy sample — it costs no retrieval round-trip', () => {
    const rows = JSON.stringify(jsonLogRows(400));
    const sink = new MemorySink();
    // even with an explicit item cap, a table that saves ≥ losslessMinSavingsRatio wins
    const r = new SmartCrusher().compress(baseRequest(rows, { ccr: sink, injectMarker: true, profile: { maxItemsAfterCrush: 12 } }));
    expect(r.itemCounts).toEqual({ original: 400, kept: 400 });
    expect(r.ccrHashes).toEqual([]);
    expect(sink.calls).toBe(0);
    expect(DEFAULT_CRUSHER_CONFIG.losslessMinSavingsRatio).toBe(0.15);
  });

  it('is deterministic and never returns something larger', () => {
    const rows = JSON.stringify(jsonLogRows(150));
    const once = new SmartCrusher().compress(baseRequest(rows, { ccr: new MemorySink(), injectMarker: true }));
    const twice = new SmartCrusher().compress(baseRequest(rows, { ccr: new MemorySink(), injectMarker: true }));
    expect(twice).toEqual(once);
    expect(once.content.length).toBeLessThan(rows.length);
  });
});

describe('SmartCrusher — lossy sampling', () => {
  const rows = JSON.stringify(jsonLogRows(200, 111));

  it('samples rows, keeps the error, and points at the stored original', () => {
    const sink = new MemorySink();
    const r = lossy().compress(baseRequest(rows, { ccr: sink, injectMarker: true, query: 'timeout' }));
    expect(r.chain).toEqual(['smart_crusher']);
    expect(r.info).toBe('smart_sample(200->15)');
    expect(r.itemCounts).toEqual({ original: 200, kept: 15 });
    expect(r.ccrHashes).toHaveLength(1);
    // the row the query is about is never sampled away
    expect(r.content).toContain('ETIMEDOUT');
    // in-array sentinel plus the trailing marker, both carrying the short hash
    const short = r.ccrHashes[0].slice(0, 12);
    expect(r.content).toContain(`{"_vg_dropped":185,"hash":"${short}"}`);
    expect(r.content.endsWith(`<<vg-ccr:${short} 185_rows_offloaded>>`)).toBe(true);
    // the original is stored byte-for-byte, with the accounting the retriever needs
    expect(sink.calls).toBe(1);
    expect(sink.get(r.ccrHashes[0])).toBe(rows);
    expect([...sink.entries.values()][0].meta).toMatchObject({ strategy: 'smart_crusher', originalItemCount: 200, compressedItemCount: 15, queryContext: 'timeout' });
  });

  it('refuses to drop rows it could not make retrievable', () => {
    // marker requested but no store, a store that throws, and strict lossless mode
    for (const req of [
      baseRequest(rows, { ccr: null, injectMarker: true }),
      baseRequest(rows, { ccr: new ThrowingSink(), injectMarker: true }),
      baseRequest(rows, { ccr: new MemorySink(), injectMarker: true, losslessOnly: true }),
    ]) {
      const r = lossy().compress(req);
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(rows);
      expect(r.ccrHashes).toEqual([]);
    }
  });

  it('honours an explicit item cap from the tool profile', () => {
    const sink = new MemorySink();
    const r = lossy().compress(baseRequest(rows, { ccr: sink, injectMarker: true, profile: { maxItemsAfterCrush: 5 } }));
    expect(r.itemCounts!.kept).toBeLessThanOrEqual(5);
    expect(r.content).toContain('_vg_dropped');
  });

  it('is deterministic', () => {
    const a = lossy().compress(baseRequest(rows, { ccr: new MemorySink(), injectMarker: true, query: 'timeout' }));
    const b = lossy().compress(baseRequest(rows, { ccr: new MemorySink(), injectMarker: true, query: 'timeout' }));
    expect(b).toEqual(a);
  });
});

describe('SmartCrusher — guards and fail-open', () => {
  const c = new SmartCrusher();

  it('passes anything that is not a big JSON container straight through', () => {
    for (const [content, info] of [
      ['', 'empty'],
      ['   \n  ', 'empty'],
      ['this is prose, not json', 'below_min_tokens'],
    ] as const) {
      const r = c.compress(baseRequest(content));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(content);
      expect(r.info).toBe(info);
    }
    const brokenJson = `[{"a":1},{"a":2},${'x'.repeat(4000)}`;
    expect(c.compress(baseRequest(brokenJson)).strategy).toBe('passthrough');
    // a bare JSON scalar is not a container to crush
    const scalars = c.compress(baseRequest(JSON.stringify('a string that is quite long '.repeat(60))));
    expect(scalars.strategy).toBe('passthrough');
    expect(scalars.info).toBe('not_json');
  });

  it('crushArray leaves short arrays and non-objects alone', () => {
    const short = [{ a: 1 }, { a: 2 }];
    expect(crushArray(short, {}, DEFAULT_CRUSHER_CONFIG)).toMatchObject({ dropped: 0, lossless: true, items: short });
    expect(crushArray([1, 2, 3], { injectMarker: true, ccr: new MemorySink() }).dropped).toBe(0);
  });
});
