import { describe, expect, it } from 'vitest';
import { compressText, DEFAULT_TEXT_CONFIG, MUST_KEEP_CASELESS_RE, MUST_KEEP_RE, mustKeepFraction, SALIENT_KEYWORDS, shingles, splitSegments, TextCompressor, textTokens } from './text.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { prose } from './__fixtures__/samples.js';

describe('segmentation and tokens', () => {
  it('splits on sentence ends and blank lines', () => {
    expect(splitSegments('One. Two! Three?\n\nFour')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
    expect(splitSegments('')).toEqual([]);
    expect(splitSegments('no terminator')).toEqual(['no terminator']);
  });

  it('lowercases word tokens and builds shingles for near-duplicate detection', () => {
    expect(textTokens('Hello World foo_bar')).toEqual(['hello', 'world', 'foo_bar']);
    expect(shingles(['a', 'b', 'c', 'd'], 3).size).toBe(2);
    // fewer tokens than the shingle width means there is nothing to shingle
    expect(shingles(['a', 'b'], 3).size).toBe(0);
  });

  it('measures how much of a segment must survive verbatim', () => {
    // paths, flags, constants and numbers are must-keep shapes
    expect(mustKeepFraction('src/index.ts --flag CONST 3.14')).toBe(1);
    expect(mustKeepFraction('run src/index.ts to start')).toBe(0.25);
    expect(mustKeepFraction('')).toBe(0);
    expect(SALIENT_KEYWORDS).toContain('traceback');
  });

  it('does not treat ordinary prose as must-keep', () => {
    // the ALL_CAPS and camelCase shapes are case-sensitive on purpose: matching
    // them case-insensitively would make every two-letter word must-keep, and a
    // signal that fires on everything ranks nothing
    expect(mustKeepFraction('the quick brown fox jumps')).toBe(0);
    expect(mustKeepFraction('hello world')).toBe(0);
    expect(MUST_KEEP_RE.test('hello')).toBe(false);
    expect(MUST_KEEP_RE.test('MAX_RETRIES')).toBe(true);
    expect(MUST_KEEP_RE.test('parseConfig')).toBe(true);
    expect(mustKeepFraction('Never call parseConfig directly')).toBe(0.5);
    // file names and negations are the shapes whose case really does not matter
    expect(MUST_KEEP_CASELESS_RE.test('README.MD')).toBe(true);
    expect(MUST_KEEP_CASELESS_RE.test('Never')).toBe(true);
  });
});

describe('compressText', () => {
  it('keeps the segments the query is about', () => {
    const text = [
      'The build pipeline runs on every push.',
      'Deployment rollback is triggered by the operator, never automatically.',
      ...Array.from({ length: 40 }, (_, i) => `Unrelated paragraph ${i} about formatting conventions.`),
    ].join('\n');
    const r = compressText(text, 'deployment rollback');
    expect(r).not.toBeNull();
    expect(r!.text).toContain('rollback');
    expect(r!.text.length).toBeLessThan(text.length);
  });

  it('honours an explicit keep ratio and never invents text', () => {
    const text = prose(80);
    const tight = compressText(text, '', 0.2);
    const loose = compressText(text, '', 0.8);
    expect(tight!.text.length).toBeLessThan(loose!.text.length);
    // every kept segment is a verbatim slice of the input
    for (const segment of splitSegments(tight!.text)) expect(text).toContain(segment.trim());
  });

  it('returns null when there is nothing worth compressing', () => {
    expect(compressText('', '')).toBeNull();
    expect(compressText('one short line.', '')).toBeNull();
  });
});

describe('TextCompressor', () => {
  it('compresses prose and reports the segment counts', () => {
    const text = prose(120);
    const r = new TextCompressor().compress(baseRequest(text, { ccr: new MemorySink(), injectMarker: true, query: 'integration tests' }));
    expect(r.strategy).toBe('text');
    expect(r.chain).toEqual(['text']);
    expect(r.info).toMatch(/^text\(\d+->\d+ segments\)$/);
    expect(r.content.length).toBeLessThan(text.length);
  });

  it('is deterministic and passes short input through', () => {
    const text = prose(60);
    expect(new TextCompressor().compress(baseRequest(text))).toEqual(new TextCompressor().compress(baseRequest(text)));
    for (const other of ['', 'a single sentence.']) {
      const r = new TextCompressor().compress(baseRequest(other));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
    expect(DEFAULT_TEXT_CONFIG.minSegments).toBeGreaterThan(0);
  });
});
