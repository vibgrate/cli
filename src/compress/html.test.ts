import { describe, expect, it } from 'vitest';
import { DEFAULT_HTML_CONFIG, decodeEntities, extractHtml, HtmlCompressor } from './html.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { HTML_PAGE } from './__fixtures__/samples.js';

describe('entity decoding', () => {
  it('decodes the named and numeric entities that matter, and leaves the rest', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(`a & b <c> "d" 'e'`);
    // named `&nbsp;` becomes an ordinary space: the extracted text is prose for a
    // model, where a non-breaking space costs the same tokens and only complicates
    // word splitting. A numeric escape is a literal code point and stays one.
    expect(decodeEntities('&nbsp;')).toBe(' ');
    expect(decodeEntities('&#160;')).toBe(String.fromCharCode(160));
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    // typographic entities keep their real character
    expect(decodeEntities('&mdash;&hellip;&copy;')).toBe('—…©');
    expect(decodeEntities('100% &notarealentity;')).toBe('100% &notarealentity;');
    expect(decodeEntities('')).toBe('');
    // decoding runs once — an escaped ampersand does not become a second entity
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('extraction', () => {
  it('keeps readable text, headings, lists, tables and code, and drops the chrome', () => {
    const ex = extractHtml(HTML_PAGE);
    expect(ex.title).toBe('Release notes & changes');
    expect(ex.links).toBeGreaterThan(0);
    expect(ex.tables).toBeGreaterThan(0);
    // script, style and navigation never reach the model
    expect(ex.text).not.toContain('function analytics');
    expect(ex.text).not.toContain('body {');
    expect(ex.text).not.toContain('Skip to content');
    // structure survives as markdown
    expect(ex.text).toContain('# Version 2.1.0');
    expect(ex.text).toContain('- Faster startup');
    expect(ex.text).toContain('| Metric | Before | After |');
    expect(ex.text).toContain('vg scan --format sarif');
    // a link becomes an inline markdown link, not a bare url
    expect(ex.text).toContain('[issue #42](https://example.com/issues/42)');
  });

  it('honours the extraction switches', () => {
    const noLinks = extractHtml(HTML_PAGE, { ...DEFAULT_HTML_CONFIG, includeLinks: false });
    expect(noLinks.text).not.toContain('https://example.com/issues/42');
    expect(noLinks.text).toContain('issue #42');
    const noTables = extractHtml(HTML_PAGE, { ...DEFAULT_HTML_CONFIG, includeTables: false });
    expect(noTables.text).not.toContain('| Metric |');
  });

  it('survives malformed markup without throwing', () => {
    for (const bad of ['', '<p>unclosed', '<<<>>>', '<div><span>a</div>', '<!-- only a comment -->', '<script>never ends']) {
      expect(() => extractHtml(bad)).not.toThrow();
    }
    expect(extractHtml('').text).toBe('');
  });
});

describe('HtmlCompressor', () => {
  it('replaces a page with its readable text and reports the saving', () => {
    const r = new HtmlCompressor().compress(baseRequest(HTML_PAGE, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('html');
    expect(r.chain).toEqual(['html']);
    expect(r.info).toMatch(/^html\(\d+->\d+ chars, \d+ links, \d+ tables\)$/);
    expect(r.content.length).toBeLessThan(HTML_PAGE.length);
    expect(r.content).not.toContain('<script');
  });

  it('is deterministic, and empty input is left alone', () => {
    expect(new HtmlCompressor().compress(baseRequest(HTML_PAGE))).toEqual(new HtmlCompressor().compress(baseRequest(HTML_PAGE)));
    for (const empty of ['', '   ']) {
      const r = new HtmlCompressor().compress(baseRequest(empty));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(empty);
    }
    // this compressor strips tags from whatever it is handed, so keeping it away
    // from prose that merely contains an angle bracket is the router's job
    expect(new HtmlCompressor().compress(baseRequest('prose with an <angle> bracket')).content).not.toContain('<angle>');
  });
});
