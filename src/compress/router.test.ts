import { describe, expect, it } from 'vitest';
import { ContentRouter, createRouter, retrievalHint, strategyForType } from './router.js';
import { baseRequest, MemorySink, ThrowingSink } from './__fixtures__/sink.js';
import { csvTable, grepOutput, HTML_PAGE, jsonLogRows, prose, pytestLog, TS_SOURCE, unifiedDiff, YAML_CONFIG } from './__fixtures__/samples.js';

/** A router with the env out of the picture, so the defaults under test are the code's. */
const router = (over: ConstructorParameters<typeof ContentRouter>[0] = {}): ContentRouter =>
  createRouter({ env: {}, codeAware: true, textCompression: true, minTokens: 50, ...over });

describe('routing table', () => {
  it('sends each content type to the compressor built for it', () => {
    expect(strategyForType('json')).toBe('smart_crusher');
    expect(strategyForType('source_code')).toBe('code_aware');
    expect(strategyForType('search_results')).toBe('search');
    expect(strategyForType('build_output')).toBe('log');
    expect(strategyForType('git_diff')).toBe('diff');
    expect(strategyForType('html')).toBe('html');
    expect(strategyForType('tabular')).toBe('tabular');
    expect(strategyForType('structured_config')).toBe('config');
    expect(strategyForType('plain_text')).toBe('text');
    // a bare path listing is only ever folded, never sampled
    expect(strategyForType('plain_text', { paths: true })).toBe('lossless');
    expect(strategyForType('plain_text', { mixed: true })).toBe('mixed');
  });

  it('explains its choice on real payloads', () => {
    const r = router();
    expect(r.route(JSON.stringify(jsonLogRows(60)))).toMatchObject({ type: 'json', strategy: 'smart_crusher' });
    expect(r.route(pytestLog(60))).toMatchObject({ type: 'build_output', strategy: 'log' });
    expect(r.route(grepOutput(4, 6))).toMatchObject({ type: 'search_results', strategy: 'search' });
    expect(r.route(unifiedDiff(2, 4, 3))).toMatchObject({ type: 'git_diff', strategy: 'diff' });
    expect(r.route(HTML_PAGE)).toMatchObject({ type: 'html', strategy: 'html' });
    expect(r.route(csvTable(30))).toMatchObject({ type: 'tabular', strategy: 'tabular' });
    expect(r.route(YAML_CONFIG)).toMatchObject({ type: 'structured_config', strategy: 'config' });
    expect(r.route(TS_SOURCE, { language: 'ts' })).toMatchObject({ type: 'source_code', strategy: 'code_aware' });
    expect(r.route(prose(40)).reason).toContain('plain_text');
  });

  it('honours the switches that turn a compressor off', () => {
    expect(router({ codeAware: false }).route(TS_SOURCE, { language: 'ts' })).toMatchObject({ strategy: 'passthrough' });
    expect(router({ textCompression: false }).route(prose(40))).toMatchObject({ strategy: 'passthrough' });
    // an explicit allow-list excludes everything not on it
    expect(router({ compressors: ['log'] }).route(JSON.stringify(jsonLogRows(60)))).toMatchObject({ strategy: 'passthrough' });
    expect(router({ compressors: ['log'] }).route(pytestLog(60))).toMatchObject({ strategy: 'log' });
  });
});

describe('the retrieval hint', () => {
  it('is one line naming the hash and what it costs to expand', () => {
    expect(retrievalHint('original', 'abc123def456', 900, 120)).toBe('Retrieve original: hash=abc123def456 (900 → 120 tokens)');
    expect(retrievalHint('more', 'abc123def456', 900, 120, 'Bash')).toBe('Retrieve more: hash=abc123def456 (900 → 120 tokens, tool=Bash)');
  });
});

describe('compress', () => {
  it('compresses a big JSON tool result and stays deterministic', () => {
    const content = JSON.stringify(jsonLogRows(200));
    const sink = new MemorySink();
    const r = router().compress(baseRequest(content, { ccr: sink, injectMarker: true, toolName: 'Bash' }));
    expect(r.strategy).not.toBe('passthrough');
    expect(r.content.length).toBeLessThan(content.length);
    expect(router().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true, toolName: 'Bash' }))).toEqual(r);
  });

  it('never touches content that already carries a marker', () => {
    const sink = new MemorySink();
    // force the lossy path so the output really carries a marker, then feed it back
    const first = router({ smartCrusherCompaction: false }).compress(baseRequest(JSON.stringify(jsonLogRows(200)), { ccr: sink, injectMarker: true }));
    expect(first.content).toContain('<<vg-ccr:');
    const again = router().compress(baseRequest(first.content, { ccr: sink, injectMarker: true }));
    expect(again.strategy).toBe('passthrough');
    expect(again.chain).toEqual(['already_compressed', 'passthrough']);
    expect(again.content).toBe(first.content);
    // the retrieval hint alone is enough to make a block off-limits
    const hinted = router().compress(baseRequest(`some output\nRetrieve original: hash=abc123def456 (900 → 120 tokens)`, { ccr: sink, injectMarker: true }));
    expect(hinted.chain).toContain('already_compressed');
  });

  it('respects the per-tool profile', () => {
    const content = pytestLog(200);
    const sink = new MemorySink();
    // byte-exact tools are never rewritten at all
    const exact = router({ toolProfiles: { Read: { skipCompression: true } } }).compress(baseRequest(content, { ccr: sink, injectMarker: true, toolName: 'Read' }));
    expect(exact.strategy).toBe('passthrough');
    expect(exact.content).toBe(content);
    // lossless-only tools may be folded but never sampled, and carry no marker
    const folded = router({ toolProfiles: { Grep: { losslessOnly: true } } }).compress(baseRequest(grepOutput(6, 12), { ccr: sink, injectMarker: true, toolName: 'Grep' }));
    expect(folded.ccrHashes).toEqual([]);
    expect(folded.content).not.toContain('<<vg-ccr:');
  });

  it('leaves anything below the token floor alone', () => {
    const r = router({ minTokens: 5_000 }).compress(baseRequest(pytestLog(200), { ccr: new MemorySink(), injectMarker: true }));
    expect(r.ccrHashes).toEqual([]);
    // a fold may still apply, but nothing lossy runs below the floor
    expect(r.strategy === 'passthrough' || r.strategy === 'lossless').toBe(true);
  });

  it('refuses an unrecoverable lossy rewrite when markers were asked for', () => {
    // prose has no structure to recover from, so without a store it is left alone
    const content = prose(200);
    const noStore = router().compress(baseRequest(content, { ccr: null, injectMarker: true }));
    expect(noStore.content).toBe(content);
    const broken = router().compress(baseRequest(content, { ccr: new ThrowingSink(), injectMarker: true }));
    expect(broken.content).toBe(content);
  });

  it('is lossless-only when told to be, and marker-free', () => {
    const content = pytestLog(300);
    const r = router().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true, losslessOnly: true }));
    expect(r.ccrHashes).toEqual([]);
    expect(r.content).not.toContain('<<vg-ccr:');
    expect(r.strategy === 'lossless' || r.strategy === 'passthrough').toBe(true);
  });

  it('falls back to the original when a compressor throws, and on empty input', () => {
    const boom = router();
    // a compressor that explodes must not take the request down with it
    (boom as unknown as { compressors: Map<string, { compress(): never }> }).compressors.set('log', {
      compress() {
        throw new Error('boom');
      },
    });
    const content = pytestLog(200);
    const r = boom.compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.content.length).toBeLessThanOrEqual(content.length);
    expect(() => boom.compress(baseRequest(''))).not.toThrow();
    expect(boom.compress(baseRequest('')).strategy).toBe('passthrough');
  });

  it('stops at the deadline rather than running long', () => {
    let t = 0;
    // every clock read advances past a 1 ms budget, so the lossy stage never starts
    const r = createRouter({ env: {}, minTokens: 10, deadlineMs: 1, now: () => (t += 50) }).compress(
      baseRequest(pytestLog(300), { ccr: new MemorySink(), injectMarker: true }),
    );
    expect(r.chain).toContain('deadline');
    expect(r.ccrHashes).toEqual([]);
  });
});
