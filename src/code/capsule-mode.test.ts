import { describe, it, expect } from 'vitest';
import { fixtureGraph } from './graph-fixture.js';
import {
  askNamesSymbol,
  buildWholeRepoPacket,
  capsuleMode,
  COMPILE_MIN_SOURCE_TOKENS,
  estimateSourceTokens,
  mappedFilePaths,
  sourceTokenMass,
  WHOLE_REPO_MAX_SOURCE_TOKENS,
} from './capsule-mode.js';

describe('capsuleMode', () => {
  it('pastes tiny trees (whole-repo) regardless of greppability', () => {
    expect(capsuleMode({ sourceTokens: 166, askNamesSymbol: true })).toBe('whole-repo');
    expect(capsuleMode({ sourceTokens: 70, askNamesSymbol: false })).toBe('whole-repo');
    expect(capsuleMode({ sourceTokens: WHOLE_REPO_MAX_SOURCE_TOKENS, askNamesSymbol: true })).toBe('whole-repo');
  });

  it('compiles once mass is high enough that grep is expensive', () => {
    expect(capsuleMode({ sourceTokens: COMPILE_MIN_SOURCE_TOKENS + 1, askNamesSymbol: true })).toBe('compile');
    expect(capsuleMode({ sourceTokens: 50_000, askNamesSymbol: false })).toBe('compile');
  });

  it('fails closed to off in the modest-mass band (no measured win there yet)', () => {
    expect(capsuleMode({ sourceTokens: 5_000, askNamesSymbol: true })).toBe('off');
    expect(capsuleMode({ sourceTokens: 5_000, askNamesSymbol: false })).toBe('off');
  });
});

describe('askNamesSymbol', () => {
  const g = fixtureGraph();
  it('is true when the ask names a graph identifier', () => {
    expect(askNamesSymbol(g, 'add a timeout to scanDir')).toBe(true);
  });
  it('is false for a symptom that names nothing in the fixture', () => {
    expect(askNamesSymbol(g, 'payments are double-charging after a refund')).toBe(false);
  });
});

describe('buildWholeRepoPacket', () => {
  const files = [
    { path: 'src/b.js', content: 'export function b() { return 2; }\n' },
    { path: 'src/a.js', content: 'export function a() { return 1; }\n' },
  ];

  it('emits files in path order and includes the task once', () => {
    const p = buildWholeRepoPacket('fix a()', files);
    expect(p.files).toEqual(['src/a.js', 'src/b.js']);
    expect(p.rendered).toContain('export function a()');
    expect(p.rendered).toContain('export function b()');
    expect(p.rendered).toContain('# Repository source (entire mapped tree)');
    expect(p.rendered.indexOf('## Task')).toBeGreaterThan(p.rendered.indexOf('src/a.js'));
    expect(p.rendered.trimEnd().endsWith('fix a()')).toBe(true);
    expect((p.rendered.match(/## Task/g) ?? []).length).toBe(1);
  });

  it('is deterministic', () => {
    const a = buildWholeRepoPacket('t', files);
    const b = buildWholeRepoPacket('t', [...files].reverse());
    expect(a.rendered).toBe(b.rendered);
  });

  it('caps the paste after the first file when the budget is tiny', () => {
    const p = buildWholeRepoPacket('t', files, 40);
    expect(p.files.length).toBe(1);
    expect(p.files[0]).toBe('src/a.js');
  });

  it('reports sourceTokens as the tree mass, not the wrapper', () => {
    const p = buildWholeRepoPacket('t', files);
    expect(p.sourceTokens).toBe(sourceTokenMass(files.map((f) => f.content)));
    expect(p.tokensEstimate).toBe(estimateSourceTokens(p.rendered));
    expect(p.tokensEstimate).toBeGreaterThan(p.sourceTokens);
  });
});

describe('mappedFilePaths', () => {
  it('returns unique sorted files from the fixture graph', () => {
    expect(mappedFilePaths(fixtureGraph())).toEqual(['src/report.ts', 'src/scan.ts']);
  });
});
