/**
 * Offline tuner + evaluator for the deterministic doc selector (engine/select.ts).
 *
 * The MOAT, server-side: runs in/alongside the S2 ingestion pipeline (which already
 * parses every README/llms.txt), measures how well a weight set recovers the
 * "critical" parts of each doc under a token budget while excluding noise, searches
 * for better weights on a TRAIN split, and reports on a held-out TEST split. Emits a
 * candidate `selection-weights.json` to re-cut into the CLI per release.
 * **No ML/LLM ships in the CLI** — only the resulting numbers.
 *
 * Run (bundled corpus):  npx tsx scripts/tune-selection.ts
 * Run (real corpus):     npx tsx scripts/tune-selection.ts ./corpus.json   # array of fixtures
 *   fixture: { query, budget?, readme, critical: string[], noise?: string[], criticalAtTop? }
 *   `critical` = oracle-labelled must-include substrings (LLM-judge or human, one-off).
 *   `noise`    = must-exclude substrings (preamble/badges/TOC).
 *
 * Metrics: recall@budget (critical present ↑), noise-leak (noise present ↓),
 * budget adherence (≤ budget), avg tokens. Objective: recall ↑, then noise ↓, then tokens ↓.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectForBudget } from '../src/engine/select.js';
import { truncateToTokens, countTokens } from '../src/engine/tokens.js';
import { DEFAULT_SELECTION_WEIGHTS, type SelectionWeights } from '../src/engine/selection-weights.js';

interface Fixture {
  name?: string;
  query: string;
  budget?: number;
  readme: string;
  critical: string[];
  noise?: string[];
  criticalAtTop?: boolean;
}

const DEFAULT_BUDGET = 120;
const here = path.dirname(fileURLToPath(import.meta.url));

function loadCorpus(arg?: string): Fixture[] {
  const file = arg ?? path.join(here, '..', 'test', 'fixtures', 'selection-corpus.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture[];
}

interface Metrics {
  recall: number; // fraction of critical markers present
  noiseLeak: number; // fraction of noise markers present (lower better)
  budgetOk: number; // fraction of fixtures within budget
  avgTokens: number;
}

function evaluate(fixtures: Fixture[], select: (f: Fixture) => string): Metrics {
  let cHit = 0;
  let cTot = 0;
  let nHit = 0;
  let nTot = 0;
  let withinBudget = 0;
  let tokens = 0;
  for (const f of fixtures) {
    const budget = f.budget ?? DEFAULT_BUDGET;
    const out = select(f);
    tokens += countTokens(out);
    if (countTokens(out) <= budget) withinBudget++;
    for (const m of f.critical) {
      cTot++;
      if (out.includes(m)) cHit++;
    }
    for (const m of f.noise ?? []) {
      nTot++;
      if (out.includes(m)) nHit++;
    }
  }
  return {
    recall: cTot ? cHit / cTot : 1,
    noiseLeak: nTot ? nHit / nTot : 0,
    budgetOk: fixtures.length ? withinBudget / fixtures.length : 1,
    avgTokens: fixtures.length ? tokens / fixtures.length : 0,
  };
}

const sel = (w: SelectionWeights) => (f: Fixture): string =>
  selectForBudget({ readme: f.readme, query: f.query, budget: f.budget ?? DEFAULT_BUDGET, weights: w }).text;
const prefix = (f: Fixture): string => truncateToTokens(f.readme, f.budget ?? DEFAULT_BUDGET).text;

/** Deterministic split: every 3rd fixture → test, rest → train. */
function split(fixtures: Fixture[]): { train: Fixture[]; test: Fixture[] } {
  const train: Fixture[] = [];
  const test: Fixture[] = [];
  fixtures.forEach((f, i) => (i % 3 === 2 ? test : train).push(f));
  return { train, test };
}

function better(a: Metrics, b: Metrics): boolean {
  if (a.recall !== b.recall) return a.recall > b.recall;
  if (a.noiseLeak !== b.noiseLeak) return a.noiseLeak < b.noiseLeak;
  return a.avgTokens < b.avgTokens;
}

function tune(train: Fixture[]): SelectionWeights {
  let bestW = DEFAULT_SELECTION_WEIGHTS;
  let bestM = evaluate(train, sel(bestW));
  const grid = { headingUsage: [2, 4, 6], headingPreamble: [-4, -6, -10], hasCode: [1, 3, 5], queryOverlap: [3, 5, 8] };
  for (const headingUsage of grid.headingUsage)
    for (const headingPreamble of grid.headingPreamble)
      for (const hasCode of grid.hasCode)
        for (const queryOverlap of grid.queryOverlap) {
          const w: SelectionWeights = { ...DEFAULT_SELECTION_WEIGHTS, headingUsage, headingPreamble, hasCode, queryOverlap };
          const m = evaluate(train, sel(w));
          if (better(m, bestM)) {
            bestM = m;
            bestW = w;
          }
        }
  return bestW;
}

function report(label: string, m: Metrics): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`  ${label.padEnd(26)} recall ${pct(m.recall)} · noise ${pct(m.noiseLeak)} · budget-ok ${pct(m.budgetOk)} · ~${m.avgTokens.toFixed(0)} tok`);
}

function main(): void {
  const corpus = loadCorpus(process.argv[2]);
  const { train, test } = split(corpus);
  console.log(`corpus: ${corpus.length} fixtures (${train.length} train / ${test.length} test)\n`);

  console.log('TEST split:');
  report('prefix-truncation', evaluate(test, prefix));
  report('default weights', evaluate(test, sel(DEFAULT_SELECTION_WEIGHTS)));
  const tuned = tune(train);
  report('tuned weights', evaluate(test, sel(tuned)));

  console.log('\nWHOLE corpus:');
  report('prefix-truncation', evaluate(corpus, prefix));
  report('default weights', evaluate(corpus, sel(DEFAULT_SELECTION_WEIGHTS)));
  report('tuned weights', evaluate(corpus, sel(tuned)));

  const outPath = path.join(here, 'selection-weights.candidate.json');
  fs.writeFileSync(outPath, `${JSON.stringify(tuned, null, 2)}\n`);
  console.log(`\nwrote candidate weights → ${outPath}`);
  console.log('review, then re-cut into src/engine/selection-weights.ts (bump SELECTION_WEIGHTS_VERSION).');

  const whole = evaluate(corpus, sel(tuned));
  if (whole.recall < 1 || whole.noiseLeak > 0) {
    console.warn(`\n⚠ recall ${(whole.recall * 100).toFixed(1)}% / noise ${(whole.noiseLeak * 100).toFixed(1)}% — inspect misses before shipping.`);
  }
}

main();
