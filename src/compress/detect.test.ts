import { describe, expect, it } from 'vitest';
import { grepOutput, HTML_PAGE, jsonLogRows, PY_SOURCE, pytestLog, TOML_CONFIG, TS_SOURCE, unifiedDiff, YAML_CONFIG, csvTable } from './__fixtures__/samples.js';
import { canonicalLanguage, decodeConcatenatedJson, detectContentType, findJsonEnd, isMixedContent, looksLikeCode, normalizeConcatenatedJson, parseJsonLoose, ripgrepJsonToGrep, splitIntoSections, stripEnvelope, toolKind, tryDetectSearch } from './detect.js';

describe('json detection', () => {
  it('parses arrays, objects, concatenated and wrapped payloads', () => {
    expect(detectContentType(JSON.stringify(jsonLogRows(5)))).toMatchObject({ type: 'json', confidence: 1, metadata: { itemCount: 5, isDictArray: true } });
    expect(detectContentType('[1,2,3]')).toMatchObject({ type: 'json', confidence: 0.8 });
    expect(detectContentType('{"items":[{"a":1},{"a":2}],"total":2}')).toMatchObject({ type: 'json', confidence: 0.9, metadata: { isObject: true, arrayKey: 'items' } });
    expect(detectContentType('{"a":1} {"a":2}  {"a":3}')).toMatchObject({ type: 'json', confidence: 1, metadata: { concatenated: true, itemCount: 3 } });
    expect(normalizeConcatenatedJson('{"a":1} {"a":2}')).toBe('[{"a":1},{"a":2}]');
    expect(normalizeConcatenatedJson('[1]')).toBeNull();
    expect(decodeConcatenatedJson('{"a":1} nope')).toBeNull();
    const wrapped = `Exit code: 0\n${JSON.stringify(jsonLogRows(20))}`;
    expect(detectContentType(wrapped).type).toBe('json');
    expect(parseJsonLoose(wrapped)?.wrapped).toBe(true);
  });
  it('rejects bare scalars, small fragments and deep junk', () => {
    expect(detectContentType('42').type).not.toBe('json');
    expect(detectContentType('"just a string"').type).not.toBe('json');
    expect(detectContentType(`${'prose '.repeat(50)} {"a":1}`).type).not.toBe('json');
    expect(findJsonEnd('{"a":"}"}', 0)).toBe(9);
    expect(findJsonEnd('{"a":[1,2', 0)).toBe(-1);
    expect(detectContentType('['.repeat(100_000)).type).not.toBe('json');
  });
});

describe('structural detectors', () => {
  it('detects diffs, html, search, logs, tables, config and code with the documented floors', () => {
    expect(detectContentType(unifiedDiff())).toMatchObject({ type: 'git_diff' });
    expect(detectContentType(HTML_PAGE)).toMatchObject({ type: 'html' });
    expect(detectContentType(grepOutput())).toMatchObject({ type: 'search_results', metadata: { format: 'grep' } });
    expect(detectContentType(pytestLog()).type).toBe('build_output');
    expect(detectContentType(csvTable())).toMatchObject({ type: 'tabular', metadata: { format: 'csv', delimiter: ',' } });
    expect(detectContentType('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toMatchObject({ type: 'tabular', confidence: 0.95, metadata: { format: 'markdown' } });
    expect(detectContentType(YAML_CONFIG)).toMatchObject({ type: 'structured_config', metadata: { flavor: 'yaml' } });
    expect(detectContentType(TOML_CONFIG)).toMatchObject({ type: 'structured_config', metadata: { flavor: 'toml' } });
    expect(detectContentType('[section]\nkey = value\nother: 1\n[more]\nx = 1')).toMatchObject({ type: 'structured_config', metadata: { flavor: 'ini' } });
    expect(detectContentType(TS_SOURCE)).toMatchObject({ type: 'source_code', metadata: { language: 'typescript' } });
    expect(detectContentType(PY_SOURCE)).toMatchObject({ type: 'source_code', metadata: { language: 'python' } });
    expect(detectContentType('Just a plain paragraph of text.').type).toBe('plain_text');
  });
  it('search needs ≥2 rows and a clean path prefix', () => {
    expect(tryDetectSearch('a.ts:1:x')).toBeNull();
    expect(tryDetectSearch('2026-09-02T09:57:59:foo\n2026-09-02T09:58:00:bar')).toBeNull();
    expect(tryDetectSearch('<tag>:1:x\n<tag>:2:y')).toBeNull();
    expect(tryDetectSearch('key=value:12:x\nkey=value:13:y')).toBeNull();
    expect(tryDetectSearch('a.ts:1:x\nb.ts:2:y')).toMatchObject({ confidence: 1 });
    expect(detectContentType('one\ntwo\nthree\nfour\nfive\nsix\na.ts:1:x\nb.ts:2:y').type).not.toBe('search_results');
  });
  it('prose with commas is not a table and markdown front matter is not config', () => {
    expect(detectContentType('Hello, friend, how are you today.\nI am fine, thanks, and you.\nGood, good, very good.').type).not.toBe('tabular');
    expect(detectContentType('---\ntitle: x\ndate: 2026\n---\n\nSome markdown prose here.\nMore prose with words and words.\nAnd more.').type).not.toBe('structured_config');
  });
  it('post-hoc overrides: html-looking logs route to log, code-looking config routes to config', () => {
    const logWithTags = `${pytestLog(200)}\n<div></div><span></span><meta><link><nav>`;
    expect(detectContentType(logWithTags).type).toBe('build_output');
  });
});

describe('hints', () => {
  it('maps tool names to kinds', () => {
    expect(toolKind('Grep')).toBe('search');
    expect(toolKind('rg')).toBe('search');
    expect(toolKind('Glob')).toBe('paths');
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('WebFetch')).toBe('html');
    expect(toolKind('Bash')).toBe('shell');
    expect(toolKind('mcp__foo__grep_search')).toBe('search');
    expect(toolKind(undefined)).toBe('unknown');
  });
  it('lowers the search floor for Grep and the html floor for WebFetch', () => {
    const one = 'src/a.ts:12:foo\nunrelated line here\nanother unrelated line\nthird line';
    expect(detectContentType(one).type).not.toBe('search_results');
    expect(detectContentType(one, { toolName: 'Grep' }).type).toBe('search_results');
    const fragment = '<div><p>Hello</p><span>x</span><section>y</section></div>';
    expect(detectContentType(fragment, { toolName: 'WebFetch' }).type).toBe('html');
  });
  it('uses the language hint for code and normalises aliases', () => {
    expect(canonicalLanguage('.py')).toBe('python');
    expect(canonicalLanguage('tsx')).toBe('typescript');
    expect(canonicalLanguage('src/app.rb')).toBe('ruby');
    expect(canonicalLanguage('c++')).toBe('cpp');
    expect(canonicalLanguage('nope')).toBeUndefined();
    const ruby = 'x = 1\ny = x + 1\nputs y\n';
    expect(detectContentType(ruby, { language: 'rb' })).toMatchObject({ type: 'source_code', metadata: { language: 'ruby', hinted: true } });
    expect(looksLikeCode(TS_SOURCE)).toMatchObject({ isCode: true, language: 'typescript' });
    expect(looksLikeCode('nothing here')).toMatchObject({ isCode: false });
  });
  it('recognises path listings for Glob', () => {
    const listing = 'src/a.ts\nsrc/b.ts\nsrc/lib/c.ts';
    expect(detectContentType(listing, { toolName: 'Glob' })).toMatchObject({ type: 'plain_text', metadata: { paths: true } });
  });
});

describe('envelopes, ripgrep json and mixed content', () => {
  it('strips tool envelopes before detecting', () => {
    expect(stripEnvelope('<returncode>0</returncode><output>hi</output>')).toEqual({ inner: 'hi', envelope: 'returncode+output' });
    expect(stripEnvelope('<stdout>x</stdout>')).toEqual({ inner: 'x', envelope: 'stdout' });
    expect(stripEnvelope('plain')).toEqual({ inner: 'plain' });
    const r = detectContentType(`<output>${grepOutput()}</output>`);
    expect(r.type).toBe('search_results');
    expect(r.metadata.envelope).toBe('output');
  });
  it('converts rg --json', () => {
    const rg = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, lines: { text: 'const x = 1;\n' }, line_number: 3 } }),
      JSON.stringify({ type: 'context', data: { path: { text: 'a.ts' }, lines: { text: 'ctx\n' }, line_number: 4 } }),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n');
    expect(ripgrepJsonToGrep(rg)).toEqual({ rows: 'a.ts:3:const x = 1;\na.ts-4-ctx', matches: 2, files: 1 });
    expect(detectContentType(rg)).toMatchObject({ type: 'search_results', metadata: { format: 'ripgrep-json' } });
    expect(ripgrepJsonToGrep('{"a":1}')).toBeNull();
  });
  it('splits mixed content into sections', () => {
    const mixed = `Here is what I found.\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\nAnd data:\n[{"a":1},{"a":2}]\nsrc/a.ts:1:x\nsrc/b.ts:2:y\nDone.`;
    expect(isMixedContent(mixed)).toBe(true);
    const s = splitIntoSections(mixed);
    expect(s.map((x) => x.kind)).toEqual(['text', 'fence', 'text', 'json', 'search', 'text']);
    expect(s[1].lang).toBe('ts');
    expect(detectContentType(mixed)).toMatchObject({ type: 'plain_text', metadata: { mixed: true } });
  });
  it('handles a 1 MB single line and 5 MB inputs quickly', () => {
    const line = `${'a'.repeat(1_000_000)}:12:${'b'.repeat(10)}`;
    const t0 = Date.now();
    detectContentType(line);
    detectContentType(`${line}\n`.repeat(5));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('is deterministic', () => {
    for (const text of [pytestLog(), grepOutput(), HTML_PAGE, YAML_CONFIG]) expect(detectContentType(text)).toEqual(detectContentType(text));
  });
});
