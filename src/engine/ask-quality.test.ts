import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore — plain-JS fixture helper, no types needed
import { generateIntentRepo, DOMAIN_PACKS } from '../../bench/intent-fixture.mjs';
// @ts-ignore — plain-JS corpus helper, no types needed
import { buildAskCorpus, buildRelationshipCorpus, evaluateAskEntry } from '../../bench/ask-corpus.mjs';
// Public term→domain relationship pairs (bench/relationship-pairs.json).
import pairsData from '../../bench/relationship-pairs.json';
// @ts-ignore — plain-JS landscape data, no types needed
import { inScopeCategories } from '../../bench/app-landscape.mjs';
// @ts-ignore — plain-JS scoreboard helper shared with the locate gate
import { scoreByCategory } from '../../bench/locate-corpus.mjs';
import { buildGraph } from './build.js';
import { queryGraph } from './query.js';
import { buildTaskCapsule } from '../code/capsule.js';
import type { VgGraph } from '../schema.js';

/**
 * The ask/capsule relevance quality gate: the full ask corpus (150+ categorized
 * natural-language questions at this scale) runs against a REAL graph built
 * from the intent fixture, and every category must resolve at 100% —
 * name-bearing asks pin the named file; intent asks with no shared identifier
 * ("what do i need to do to add payments via direct debit?") seed the owning
 * domain, not the `addTeamMember`/`AddBlogForm`/`validDirectUrl`/`…Via…`
 * surface-form traps the field report caught; weak-verb-only and off-topic
 * asks return an honest empty seed list instead of a grab-bag.
 *
 * This is the enforcement half of the `bench:ask` benchmark: the bench reports
 * the numbers per release; this gate stops a ranking regression merging. The
 * seeds scored here are the SAME seeds `buildCodeContext` / Task Capsule
 * expand into primary symbols, so this gate is the capsule-relevance gate.
 */

interface AskEntry {
  q: string;
  category: string;
  k: number;
  expectFile?: string;
  expectAnyFiles?: string[];
  domainDirs?: string[];
  minShare?: number;
  firstSeedDomain?: boolean;
  forbidFiles?: string[];
  maxForbidden?: number;
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
let fixtureCatalog: unknown;

/** Build a deterministic stand-in provider from regex→expansion rules. */
function makeStubAnalyze(rules: Array<[RegExp, Array<{ term: string; from: string; weight: number }>]>) {
  return (q: string) => {
    const lq = q.toLowerCase();
    const expansions = rules.flatMap(([re, ex]) => (re.test(lq) ? ex : []));
    if (!expansions.length) return null;
    return { version: 'stub-relevance@1', topics: [], expansions };
  };
}

beforeAll(async () => {
  const fixture = generateIntentRepo(SCALE) as { root: string; catalog: unknown };
  root = fixture.root;
  fixtureCatalog = fixture.catalog;
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
  const corpus = buildAskCorpus(fixture.catalog) as AskEntry[];
  expect(corpus.length).toBeGreaterThanOrEqual(400); // the breadth contract
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

describe('vg ask / capsule seed relevance gate (real graph over the intent fixture)', () => {
  it('every in-scope app category (bench/app-landscape.mjs) is covered by a domain pack with intent questions', () => {
    const packKeys = new Set(DOMAIN_PACKS.map((p: { key: string }) => p.key));
    for (const cat of inScopeCategories() as Array<{ key: string; fixtureDomains: string[] }>) {
      expect(cat.fixtureDomains.length, `category ${cat.key} has no fixture domains`).toBeGreaterThan(0);
      for (const d of cat.fixtureDomains) {
        expect(packKeys.has(d), `category ${cat.key} maps to unknown domain pack "${d}"`).toBe(true);
      }
      const covered = outcomes.some((o) => cat.fixtureDomains.some((d) => o.entry.category === `intent-${d}`));
      expect(covered, `category ${cat.key} has no intent questions in the corpus`).toBe(true);
    }
  });

  it('every category resolves at 100% — failures listed with reasons', () => {
    const scored = scoreByCategory(outcomes) as Array<{
      category: string;
      total: number;
      passed: number;
      rate: number;
      failures: Array<{ q: string; reason: string }>;
    }>;
    const failing = scored.filter((r) => r.rate < 1);
    const detail = failing
      .map((r) => `${r.category} ${r.passed}/${r.total}\n` + r.failures.map((f) => `    "${f.q}" — ${f.reason}`).join('\n'))
      .join('\n');
    expect(failing, `\nfailing categories:\n${detail}\n`).toEqual([]);
  });

  it('weak-verb-only and off-topic asks never produce confident seeds', () => {
    const misses = outcomes.filter((o) => o.entry.mustMiss);
    expect(misses.length).toBeGreaterThanOrEqual(4);
    for (const o of misses) expect(o.pass, `"${o.entry.q}": ${o.reason ?? ''}`).toBe(true);
  });

  it('dual mode: a relevance provider widening vocabulary keeps every category at 100%', () => {
    // Deterministic stand-in for an installed relevance provider (the real
    // module is optional and proprietary; this stub exercises the same seam
    // with the same behaviour class): expansions fire only on topic-bearing
    // words, never on weak verbs, exactly like the sanitized contract
    // guarantees. Traps and must-miss questions therefore see either no
    // analysis or on-topic vocabulary — both must stay clean.
    const RULES: Array<[RegExp, Array<{ term: string; from: string; weight: number }>]> = [
      [/\bdirect debit\b|\bdebit\b/, [
        { term: 'mandate', from: 'direct debit', weight: 0.6 },
        { term: 'sepa', from: 'direct debit', weight: 0.6 },
        { term: 'billing', from: 'payments', weight: 0.45 },
      ]],
      [/\bpayments?\b/, [
        { term: 'invoice', from: 'payments', weight: 0.45 },
        { term: 'billing', from: 'payments', weight: 0.45 },
      ]],
      [/\blocales?\b|\btranslations?\b/, [
        { term: 'i18n', from: 'locale', weight: 0.5 },
        { term: 'localization', from: 'locale', weight: 0.5 },
      ]],
      [/\bnotifications?\b/, [{ term: 'push', from: 'notification', weight: 0.45 }]],
      [/\bsessions?\b|\blogin\b/, [{ term: 'auth', from: 'session', weight: 0.45 }]],
    ];
    const stubAnalyze = makeStubAnalyze(RULES);
    const withProvider: Outcome[] = [];
    for (const o of outcomes) {
      const relevance = stubAnalyze(o.entry.q);
      const result = queryGraph(graph, o.entry.q, { limit: SEED_LIMIT, relevance });
      const seeds = result.matches.map((m) => ({ file: m.node.file }));
      const { pass, reason } = evaluateAskEntry(o.entry, seeds) as { pass: boolean; reason?: string };
      withProvider.push({ entry: o.entry, pass, reason, ms: 0 });
    }
    const scored = scoreByCategory(withProvider) as Array<{
      category: string;
      total: number;
      passed: number;
      rate: number;
      failures: Array<{ q: string; reason: string }>;
    }>;
    const failing = scored.filter((r) => r.rate < 1);
    const detail = failing
      .map((r) => `${r.category} ${r.passed}/${r.total}\n` + r.failures.map((f) => `    "${f.q}" — ${f.reason}`).join('\n'))
      .join('\n');
    expect(failing, `\nfailing categories with provider active:\n${detail}\n`).toEqual([]);
  });

  it('relationship corpus: kernel-only term→domain asks resolve at 100% with a provider and demonstrably NOT without', () => {
    // Provider stub fed from the SAME public pairs file the corpus is
    // generated from — the term is the only bridge, exactly like the kernel.
    const pairRules: Array<[RegExp, Array<{ term: string; from: string; weight: number }>]> = (
      pairsData.pairs as Array<{ term: string; expansions: string[] }>
    ).map((p) => [
      new RegExp(`\\b${p.term}\\b`, 'i'),
      p.expansions.map((w) => ({ term: w, from: p.term, weight: 0.6 })),
    ]);
    const stubAnalyze = makeStubAnalyze(pairRules);

    const relCorpus = buildRelationshipCorpus(fixtureCatalog, pairsData) as AskEntry[];
    // Grows as the pairs file grows; floor guards against the filter
    // silently emptying the corpus.
    expect(relCorpus.length).toBeGreaterThanOrEqual(18);

    const run = (withProvider: boolean): Outcome[] =>
      relCorpus.map((entry) => {
        const relevance = withProvider ? stubAnalyze(entry.q) : null;
        const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT, relevance });
        const seeds = result.matches.map((m) => ({ file: m.node.file }));
        const { pass, reason } = evaluateAskEntry(entry, seeds) as { pass: boolean; reason?: string };
        return { entry, pass, reason, ms: 0 };
      });

    const withKernel = run(true);
    const failing = withKernel.filter((o) => !o.pass);
    const detail = failing.map((o) => `    "${o.entry.q}" — ${o.reason}`).join('\n');
    expect(failing, `\nrelationship asks failing with provider:\n${detail}\n`).toEqual([]);

    // Dominance: without a provider these asks must largely be unresolvable —
    // if the baseline starts passing them, they no longer measure the kernel.
    const baselinePassRate = run(false).filter((o) => o.pass).length / relCorpus.length;
    expect(baselinePassRate).toBeLessThan(0.5);
  });

  it('the field-report capsule is clean: direct-debit ask carries payment evidence, zero distractors', () => {
    const capsule = buildTaskCapsule(graph, 'what do i need to do to add payments via direct debit?', {
      readFile: (rel) => {
        try {
          return fs.readFileSync(path.join(root, rel), 'utf8');
        } catch {
          return null;
        }
      },
    });
    const primaryFiles = capsule.primary.map((p) => p.file);
    expect(primaryFiles.length).toBeGreaterThan(0);
    // Every primary symbol lives in the payments/billing domain…
    for (const f of primaryFiles) {
      expect(f, `distractor seeded into the capsule: ${f}`).toMatch(/^src\/(payments|billing)\//);
    }
    // …the true target (direct-debit mandates) is present…
    expect(primaryFiles.some((f) => f.includes('DirectDebitMandate'))).toBe(true);
    // …and the source slices the model receives are domain evidence too.
    for (const s of capsule.sourceSlices) {
      expect(s.file, `distractor slice in the capsule: ${s.file}`).toMatch(/^src\/(payments|billing)\//);
    }
  });

  it('stays fast: p95 per-question latency under 250ms at gate scale', () => {
    const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
  });
});
