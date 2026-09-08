import { describe, expect, it } from 'vitest';
import { ConfigCompressor, detectConfigFlavor, elisionSafe, schemaFold, stripCommentLines } from './config-compress.js';
import { DEFAULT_CRUSHER_CONFIG } from './crusher.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { TOML_CONFIG, YAML_CONFIG } from './__fixtures__/samples.js';

describe('flavour detection', () => {
  it('names the config dialect, or admits it does not know', () => {
    expect(detectConfigFlavor(YAML_CONFIG)).toBe('yaml');
    expect(detectConfigFlavor(TOML_CONFIG)).toBe('toml');
    expect(detectConfigFlavor('{"a":1,"b":[1,2]}')).toBe('json');
    expect(detectConfigFlavor('hello there')).toBe('unknown');
    expect(detectConfigFlavor('')).toBe('unknown');
  });
});

describe('comment elision', () => {
  it('refuses to touch text where a `#` line could be data', () => {
    expect(elisionSafe(YAML_CONFIG, 'yaml')).toBe(true);
    // a block scalar can contain a literal `#` line that is content, not a comment
    expect(elisionSafe('script: |\n  # not a comment, this is a shell script\n  echo hi\n', 'yaml')).toBe(false);
    expect(elisionSafe('a = """\n# inside a string\n"""\n', 'toml')).toBe(false);
    expect(elisionSafe('anything', 'unknown')).toBe(false);
  });

  it('drops whole-line comments and reports how many', () => {
    const { text, elided } = stripCommentLines('# leading\nk: v\n  # indented\nother: 1', 'yaml');
    expect(text).toBe('k: v\nother: 1');
    expect(elided).toBe(2);
    // a trailing `#` inside a value is not a comment line
    expect(stripCommentLines('url: http://x/#anchor\n', 'yaml')).toMatchObject({ elided: 0 });
    // outside INI, blank lines go too
    expect(stripCommentLines('a: 1\n\nb: 2\n', 'yaml')).toMatchObject({ text: 'a: 1\nb: 2\n', elided: 1 });
    expect(stripCommentLines('a=1\n\nb=2\n', 'ini')).toMatchObject({ elided: 0 });
  });
});

describe('schema folding', () => {
  it('renders a long uniform array inside a config as a schema line', () => {
    const doc = { services: Array.from({ length: 40 }, (_, i) => ({ name: `svc-${i}`, port: 8000 + i, healthy: true })) };
    const folded = schemaFold(doc, DEFAULT_CRUSHER_CONFIG, 3);
    expect(folded).not.toBeNull();
    expect(folded!.length).toBeLessThan(JSON.stringify(doc).length);
    // too few rows to be worth a schema
    expect(schemaFold({ services: [{ name: 'a' }] }, DEFAULT_CRUSHER_CONFIG, 3)).toBeNull();
    expect(schemaFold({}, DEFAULT_CRUSHER_CONFIG, 3)).toBeNull();
  });
});

describe('ConfigCompressor', () => {
  it('folds a repetitive config losslessly', () => {
    const content = `${YAML_CONFIG}---\n${YAML_CONFIG}---\n${YAML_CONFIG}`;
    const r = new ConfigCompressor().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('config');
    // a byte-reversible fold, so nothing needs storing for retrieval
    expect(r.chain).toEqual(['lossless_config']);
    expect(r.ccrHashes).toEqual([]);
    expect(r.content.length).toBeLessThan(content.length);
  });

  it('is deterministic and leaves short or unknown config alone', () => {
    const content = `${TOML_CONFIG}\n${TOML_CONFIG}`;
    expect(new ConfigCompressor().compress(baseRequest(content))).toEqual(new ConfigCompressor().compress(baseRequest(content)));
    for (const other of ['', 'k: v', 'not config at all, just a sentence']) {
      const r = new ConfigCompressor().compress(baseRequest(other));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
  });
});
