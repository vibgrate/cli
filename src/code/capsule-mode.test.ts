import { describe, it, expect } from 'vitest';
import { fixtureGraph } from './graph-fixture.js';
import {
  askNamesSymbol,
  buildWholeRepoPacket,
  capsuleMode,
  rankConfidenceOf,
  COMPILE_MIN_SOURCE_TOKENS,
  estimateSourceTokens,
  mappedFilePaths,
  MIN_RANK_CONFIDENCE,
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

  it('emits files in path order and never echoes the instruction', () => {
    const p = buildWholeRepoPacket(files);
    expect(p.files).toEqual(['src/a.js', 'src/b.js']);
    expect(p.rendered).toContain('export function a()');
    expect(p.rendered).toContain('export function b()');
    expect(p.rendered).toContain('# Repository source (entire mapped tree)');
    // The caller sends the ask as its own turn; echoing it here billed it twice.
    expect(p.rendered).not.toContain('## Task');
  });

  it('is deterministic', () => {
    const a = buildWholeRepoPacket(files);
    const b = buildWholeRepoPacket([...files].reverse());
    expect(a.rendered).toBe(b.rendered);
  });

  it('caps the paste after the first file when the budget is tiny', () => {
    const p = buildWholeRepoPacket(files, 40);
    expect(p.files.length).toBe(1);
    expect(p.files[0]).toBe('src/a.js');
  });

  it('reports sourceTokens as the tree mass, not the wrapper', () => {
    const p = buildWholeRepoPacket(files);
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

describe('rankConfidenceOf', () => {
  it('reports the top scored seed', () => {
    expect(rankConfidenceOf({ hasContent: true, seeds: [{ score: 12 }, { score: 400 }, { score: 7 }] })).toBe(400);
  });

  it('reports zero when the module says the ask had nothing rankable', () => {
    expect(rankConfidenceOf({ hasContent: false, seeds: [] })).toBe(0);
  });

  it('reports null — not zero — when there is no comparable signal', () => {
    // null means "no signal"; zero means "the engine looked and found none".
    // Conflating them would let a module-less run be gated on a threshold
    // calibrated against a scale it does not share.
    expect(rankConfidenceOf(null)).toBeNull();
    expect(rankConfidenceOf(undefined)).toBeNull();
    expect(rankConfidenceOf({ hasContent: true, seeds: [] })).toBeNull();
    expect(rankConfidenceOf({ hasContent: true, seeds: [{ score: 0 }] })).toBeNull();
  });
});

describe('capsuleMode — stand down only on honest-empty', () => {
  const bigRepo = { sourceTokens: 50_000, askNamesSymbol: true };

  it('exports MIN_RANK_CONFIDENCE=1 so harnesses that compare confidence < MIN still match', () => {
    // Not a shipped absolute score gate. An earlier revision used 150 and
    // suppressed 3/114 real terse symptom asks. Value 1 means only a
    // rankConfidence of 0 (honest-empty) is suppressed by that comparison.
    expect(MIN_RANK_CONFIDENCE).toBe(1);
    expect(capsuleMode({ ...bigRepo, rankConfidence: MIN_RANK_CONFIDENCE })).toBe('compile');
    expect(capsuleMode({ ...bigRepo, rankConfidence: 400 })).toBe('compile');
  });

  it('compiles a weak-but-nonzero ranking — terse symptom asks live here', () => {
    // Measured real asks that a 150 gate silenced: 113.6, 117.8, 133.3.
    // Two of those three retrieved their target. noise-log scored 129.9, so
    // any threshold low enough to rescue them also passes the log dumps.
    // We take the spend: vg code must not feel dumber on a one-line symptom.
    for (const weak of [1, 113.6, 117.8, 129.9, 133.3, 150]) {
      expect(capsuleMode({ ...bigRepo, rankConfidence: weak }), `score ${weak}`).toBe('compile');
    }
  });

  it('stands down only when the module reports honest-empty', () => {
    expect(capsuleMode({ ...bigRepo, rankConfidence: 0 })).toBe('off');
  });

  it('never suppresses on a missing signal', () => {
    // No module installed → the mechanical fallback → no comparable score.
    expect(capsuleMode({ ...bigRepo, rankConfidence: null })).toBe('compile');
    expect(capsuleMode(bigRepo)).toBe('compile');
  });

  it('still pastes a tiny tree regardless of confidence', () => {
    // Size wins first: on a tree this small the paste is cheaper than ranking.
    expect(capsuleMode({ sourceTokens: 100, askNamesSymbol: false, rankConfidence: 0 })).toBe('whole-repo');
  });
});
