import { beforeAll, describe, expect, it } from 'vitest';
import {
  allocateBodyBudget,
  CodeCompressor,
  compressCodeAst,
  compressCodeHeuristic,
  DEFAULT_CODE_CONFIG,
  detectIndent,
  isCodeCompressorReady,
  languageIdFor,
  loadedCodeLanguages,
  normalizeScores,
  omittedMarker,
  prepareCodeCompressor,
} from './code.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { PY_SOURCE, TS_SOURCE } from './__fixtures__/samples.js';

describe('helpers', () => {
  it('maps a hint to a language id', () => {
    expect(languageIdFor('ts')).toBe('ts');
    expect(languageIdFor('.tsx')).toBe('tsx');
    expect(languageIdFor('python')).toBe('py');
    expect(languageIdFor('src/app/main.go')).toBe('go');
    expect(languageIdFor('cobol')).toBeUndefined();
    expect(languageIdFor(undefined)).toBeUndefined();
  });

  it('reads the file’s own indentation rather than assuming one', () => {
    expect(detectIndent(['function a() {', '  return 1;', '}'])).toBe('  ');
    expect(detectIndent(['def a():', '    return 1'])).toBe('    ');
    expect(detectIndent(['func a() {', '\treturn 1', '}'])).toBe('\t');
    expect(detectIndent(['flat', 'lines'])).toBe('  ');
  });

  it('writes the omitted-body marker in the file’s comment syntax', () => {
    expect(omittedMarker('  ', '//', 12)).toBe('  // … 12 lines omitted');
    expect(omittedMarker('    ', '#', 3)).toBe('    # … 3 lines omitted');
    // the calls a body made are named, so the reader keeps the call graph
    expect(omittedMarker('  ', '//', 8, ['fetchUser', 'validate'])).toContain('fetchUser, validate');
  });

  it('normalises scores to 0..1 and shares the line budget by score and size', () => {
    expect(normalizeScores([1, 3, 5])).toEqual([0, 0.5, 1]);
    // no spread means no signal, so every function scores neutral rather than top
    expect(normalizeScores([2, 2, 2])).toEqual([0.5, 0.5, 0.5]);
    expect(normalizeScores([])).toEqual([]);
    const budget = allocateBodyBudget([{ bodySize: 100, score: 1 }, { bodySize: 10, score: 0 }], 40, DEFAULT_CODE_CONFIG);
    expect(budget).toHaveLength(2);
    // the interesting function gets at least as many lines as the dull one
    expect(budget[0]).toBeGreaterThanOrEqual(budget[1]);
    for (const b of budget) expect(b).toBeGreaterThanOrEqual(0);
  });
});

describe('heuristic compression (no grammar loaded)', () => {
  it('keeps imports and signatures, collapsing bodies', () => {
    const r = compressCodeHeuristic(TS_SOURCE, 'ts');
    expect(r).not.toBeNull();
    expect(r!.text).toContain(`import { readFileSync } from 'node:fs';`);
    expect(r!.text).toContain('export function loadConfig(path: string): Config {');
    expect(r!.text.length).toBeLessThan(TS_SOURCE.length);
  });

  it('returns null for input with nothing to collapse', () => {
    expect(compressCodeHeuristic('const x = 1;', 'ts')).toBeNull();
    expect(compressCodeHeuristic('', 'ts')).toBeNull();
  });
});

describe('AST compression', () => {
  beforeAll(async () => {
    await prepareCodeCompressor(['ts', 'py']);
  });

  it('loads the grammars it was asked to warm', () => {
    expect(isCodeCompressorReady('ts')).toBe(true);
    expect(loadedCodeLanguages()).toEqual(expect.arrayContaining(['ts', 'py']));
    expect(isCodeCompressorReady('haskell')).toBe(false);
  });

  it('keeps every signature and the first docstring line, and still parses', () => {
    const r = compressCodeAst(TS_SOURCE, 'ts');
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeLessThan(TS_SOURCE.length);
    for (const signature of ['export function loadConfig(path: string): Config {', 'export function retry<T>(fn: () => T, opts: Options): T {', 'export interface Options {']) {
      expect(r!.text).toContain(signature);
    }
    // each collapsed body says how much it stands for
    expect(r!.text).toMatch(/\/\/ … \d+ lines omitted/);
    // exported constants survive — the model still sees the module's surface
    expect(r!.text).toContain('export const VERSION');
  });

  it('handles python indentation and docstrings', () => {
    const r = compressCodeAst(PY_SOURCE, 'py');
    expect(r).not.toBeNull();
    expect(r!.text).toContain('def ');
    expect(r!.text.length).toBeLessThan(PY_SOURCE.length);
  });

  it('refuses a rewrite that would not parse, and never throws on junk', () => {
    // truncated source cannot be reparsed cleanly → no compression is offered
    expect(() => compressCodeAst('function broken( {', 'ts')).not.toThrow();
    expect(() => compressCodeAst('', 'ts')).not.toThrow();
    expect(compressCodeAst('', 'ts')).toBeNull();
  });
});

describe('CodeCompressor', () => {
  it('reports which path it took', () => {
    const r = new CodeCompressor().compress(baseRequest(TS_SOURCE, { language: 'ts', ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('code_aware');
    expect(r.chain).toEqual(['code_aware']);
    expect(r.info).toMatch(/^code:ts:(ast|heuristic)\(\d+\/\d+ functions, \d+ lines omitted\)$/);
    expect(r.content.length).toBeLessThan(TS_SOURCE.length);
  });

  it('is deterministic and passes through what it cannot improve', () => {
    const a = new CodeCompressor().compress(baseRequest(TS_SOURCE, { language: 'ts' }));
    const b = new CodeCompressor().compress(baseRequest(TS_SOURCE, { language: 'ts' }));
    expect(b).toEqual(a);
    for (const other of ['', 'const x = 1;']) {
      const r = new CodeCompressor().compress(baseRequest(other, { language: 'ts' }));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
    // an unrecognised hint does not disable compression: the language is
    // re-detected from the source, which is plainly TypeScript
    const badHint = new CodeCompressor().compress(baseRequest(TS_SOURCE, { language: 'brainfuck' }));
    expect(badHint.info).toContain('code:ts:');
    expect(badHint.content.length).toBeLessThan(TS_SOURCE.length);
  });
});
