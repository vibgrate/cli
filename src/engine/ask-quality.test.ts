import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
// @ts-ignore — plain-JS fixture helper, no types needed
import { generateIntentRepo } from '../../bench/intent-fixture.mjs';
// @ts-ignore — plain-JS corpus helper, no types needed
import { buildAskCorpus, evaluateAskEntry } from '../../bench/ask-corpus.mjs';
// @ts-ignore — plain-JS scoreboard helper shared with the locate gate
import { scoreByCategory } from '../../bench/locate-corpus.mjs';
import { buildGraph } from './build.js';
import { queryGraph } from './query.js';
import { sanitizeRank, type RankResult } from './relevance-provider.js';
import type { VgGraph } from '../schema.js';

/**
 * The MECHANICAL baseline gate (post relevance-relocation, 2026-08).
 *
 * The relevance engine — lexicon, term roles, IDF, typo repair, morphology,
 * diversification — lives in the auto-provisioned relevance module now; its
 * full ask/code corpora gates run in that package's test suite. What this
 * public package still owes, and what this gate enforces:
 *
 *  1. Module-less mechanical matching: an ask that NAMES a symbol pins its
 *     file (exact name / identifier-part hits), and asks whose words name
 *     nothing return an honest empty — never a grab-bag.
 *  2. The seam contract: a provider ranking is consumed in order, sanitized
 *     (unknown ids dropped, strings cleaned), and an honest miss from the
 *     module stays an honest miss.
 */

interface AskEntry {
  q: string;
  category: string;
  k: number;
  mustMiss?: boolean;
}
interface Outcome {
  entry: AskEntry;
  pass: boolean;
  reason?: string;
  ms: number;
}

const SCALE = 6;
const SEED_LIMIT = 16;

let root: string;
let graph: VgGraph;
let outcomes: Outcome[];

beforeAll(async () => {
  const fixture = generateIntentRepo(SCALE) as { root: string; catalog: unknown };
  root = fixture.root;
  const built = await buildGraph({
    root,
    inline: true,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  graph = built.graph;
  // The FULL corpus runs here. Filtering it to the name-bearing categories —
  // as this gate used to — made the must-miss and trap categories invisible
  // at merge time, which is how the fallback's grab-bag regression reached a
  // release benchmark (domain-intent 100% -> 59.1%, traps 100% -> 25%, honest
  // empties 100% -> 80%) without failing a single check. Categories the
  // fallback cannot be held to are excluded per-category below, never by
  // dropping them from the run.
  const corpus = buildAskCorpus(fixture.catalog) as AskEntry[];
  expect(corpus.length).toBeGreaterThanOrEqual(150);
  outcomes = [];
  for (const entry of corpus) {
    const s = process.hrtime.bigint();
    const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT });
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const seeds = result.matches.map((m) => ({ file: m.node.file }));
    const { pass, reason } = evaluateAskEntry(entry, seeds) as { pass: boolean; reason?: string };
    outcomes.push({ entry, pass, reason, ms });
  }
}, 180_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * What the module-less fallback is held to, per category.
 *
 * `1` = no failures tolerated. A rate below 1 is a MEASURED CEILING, not an
 * aspiration: it records what mechanical identifier matching can reach
 * without the module, so the category still fails the build if it regresses.
 * Ratchet these UP when the fallback improves; never down to make a red build
 * green — a drop means the fallback got worse and that is the bug.
 *
 * Categories absent from this table are the module's job (the intent packs
 * need a lexicon: gocardless→payments and friends) and are gated at 100% in
 * the relevance module's own ranker-gate.test.ts.
 */
const MECHANICAL_FLOORS: Record<string, number> = {
  // An ask that NAMES a symbol must pin its file. No excuses — this is the
  // whole promise of the fallback.
  'name-callers': 1,
  'name-impact': 1,
  'name-usage': 1,
  // The honest-empty contract: an ask built only of process verbs and filler,
  // or one about a domain the repo does not contain, returns NOTHING.
  'weak-only-must-miss': 1,
  'off-topic-must-miss': 1,
  // Surface-form traps. 7/8 is the mechanical ceiling: the outstanding case
  // ("what needs to change to support direct debit?") needs to know that
  // "direct debit" is a compound term, or bare `direct` substring-matches the
  // fixture's `validDirectUrl`/`directoryListing` distractors. Resolving that
  // is bigram lexicon work — module territory, gated at 100% there.
  'trap-weak-verbs': 7 / 8,
};

describe('mechanical fallback gate (module-less queryGraph over the intent fixture)', () => {
  it('every gated category holds its floor — failures listed with reasons', () => {
    const scored = scoreByCategory(outcomes) as Array<{
      category: string;
      total: number;
      passed: number;
      rate: number;
      failures: Array<{ q: string; reason: string }>;
    }>;
    const gated = scored.filter((r) => r.category in MECHANICAL_FLOORS);
    // Guard against a corpus rename silently emptying the gate.
    expect(gated.map((r) => r.category).sort()).toEqual(Object.keys(MECHANICAL_FLOORS).sort());
    const failing = gated.filter((r) => r.rate < MECHANICAL_FLOORS[r.category]!);
    const detail = failing
      .map(
        (r) =>
          `${r.category} ${r.passed}/${r.total} (floor ${MECHANICAL_FLOORS[r.category]!.toFixed(3)})\n` +
          r.failures.map((f) => `    "${f.q}" — ${f.reason}`).join('\n'),
      )
      .join('\n');
    expect(failing, `\ncategories below their mechanical floor:\n${detail}\n`).toEqual([]);
  });

  it('asks whose words name nothing return an honest empty, not a grab-bag', () => {
    // The first three are framing words that collide with REAL identifier
    // parts in the fixture, so they are the cases that actually exercise the
    // floor: without it `add` seeds every Add* symbol, `feature` seeds
    // FeatureFlagStore, and `fix`/`bug` seed the *fix*/*bug* lookalikes — a
    // full seed window for an ask that named nothing. The rest are framing
    // words with no collision, plus genuine vocabulary the repo lacks.
    for (const q of [
      'add a new feature',
      'add support for a new thing',
      'fix the bug',
      'do the work',
      'can you make changes',
      'where do we tessellate quaternion frustum meshes?',
    ]) {
      const r = queryGraph(graph, q, { limit: SEED_LIMIT });
      expect(r.matches, q).toEqual([]);
    }
  });

  it('stays fast: p95 per-question latency under 250ms at gate scale', () => {
    const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
  });
});

describe('provider-ranking seam (stub module)', () => {
  const validIds = () => new Set(graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').map((n) => n.id));

  it('consumes a sanitized ranking in order and keeps its why strings', () => {
    const picks = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').slice(0, 3);
    const raw: RankResult = {
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: picks.map((n, i) => ({ id: n.id, score: 100 - i, why: `stub pick ${i}` })),
      conceptMap: ['- stub interpretation line.'],
    };
    const ranked = sanitizeRank(raw, validIds());
    expect(ranked).not.toBeNull();
    const r = queryGraph(graph, 'anything at all', { limit: SEED_LIMIT, ranked });
    expect(r.matches.map((m) => m.node.id)).toEqual(picks.map((n) => n.id));
    expect(r.matches[0]!.why).toBe('stub pick 0');
  });

  it('drops invented ids, non-finite scores, and control characters at the boundary', () => {
    const real = graph.nodes.find((n) => n.kind !== 'file' && n.kind !== 'external')!;
    const raw: RankResult = {
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: [
        { id: 'not-a-real-node', score: 999, why: 'forged' },
        { id: real.id, score: Number.NaN, why: 'bad score' },
        { id: real.id, score: 5, why: 'ok  why\nline' },
      ],
      conceptMap: ['ok line', ' ', ''],
    };
    const ranked = sanitizeRank(raw, validIds());
    expect(ranked).not.toBeNull();
    expect(ranked!.seeds).toHaveLength(1);
    expect(ranked!.seeds[0]!.id).toBe(real.id);
    expect(ranked!.seeds[0]!.why).toBe('ok why line');
    expect(ranked!.conceptMap).toEqual(['ok line']);
  });

  it("a module honest miss stays an honest miss — the fallback must not second-guess it", () => {
    const ranked = sanitizeRank(
      { version: 'stub-ranker@1', hasContent: false, seeds: [], conceptMap: [] },
      validIds(),
    );
    // A question that WOULD mechanically match: the module's verdict wins.
    const named = graph.nodes.find((n) => n.kind !== 'file' && n.kind !== 'external')!;
    const r = queryGraph(graph, `explain where ${named.name} is used`, { limit: SEED_LIMIT, ranked });
    expect(r.matches).toEqual([]);
  });

  it('a malformed envelope drops the whole ranking (null → mechanical fallback)', () => {
    expect(sanitizeRank({} as RankResult, validIds())).toBeNull();
    expect(sanitizeRank({ version: 1, hasContent: true, seeds: [], conceptMap: [] } as unknown as RankResult, validIds())).toBeNull();
    expect(sanitizeRank({ version: 'v', hasContent: true, seeds: 'x', conceptMap: [] } as unknown as RankResult, validIds())).toBeNull();
  });
});
