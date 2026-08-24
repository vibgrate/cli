/**
 * Ask relevance benchmark — the reporting half of the quality gates.
 *
 * Since the 2026-08 relevance relocation the ranking engine lives in the
 * relevance module: with a provider loadable (installed, or
 * VIBGRATE_RELEVANCE_PATH pointing at one — in the monorepo,
 * packages/vibgrate-relevance/dev-provider.mjs) the FULL ask corpus runs
 * against it; without one, the bench reports the mechanical fallback over
 * the name-bearing subset (the enforcement halves live in
 * src/engine/ask-quality.test.ts here and the module package's gate).
 *
 *   pnpm --filter @vibgrate/cli-public exec tsx bench/ask-quality.bench.ts
 *   BENCH_SCALE=10 BENCH_LINES=40 … (bigger repo, same expectations)
 */
import * as fs from 'node:fs';
// @ts-ignore — plain-JS fixture helper
import { generateIntentRepo } from './intent-fixture.mjs';
// @ts-ignore — plain-JS corpus helper
import { buildAskCorpus, evaluateAskEntry } from './ask-corpus.mjs';
// @ts-ignore — scoreboard shared with the locate bench
import { scoreByCategory } from './locate-corpus.mjs';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph } from '../src/engine/query.js';
import { rankQuestion } from '../src/engine/relevance-provider.js';

const SCALE = Number(process.env.BENCH_SCALE ?? 8);
const SEED_LIMIT = 16;

async function main(): Promise<void> {
  const { root, catalog } = generateIntentRepo(SCALE);
  try {
    const built = await buildGraph({
      root,
      inline: true,
      noGround: true,
      noTsc: true,
      noCoverage: true,
      noScip: true,
      generatedAt: '2026-01-01T00:00:00Z',
    });
    const graph = built.graph;
    const probe = await rankQuestion(graph, 'probe', { limit: 1 });
    const moduleMode = probe !== null;
    const corpus = (buildAskCorpus(catalog) as Array<{ q: string; category: string }>).filter(
      (e) => moduleMode || e.category.startsWith('name-'),
    );

    const outcomes = [] as Array<{ entry: { q: string; category: string }; pass: boolean; reason?: string; ms: number }>;
    for (const entry of corpus) {
      const s = process.hrtime.bigint();
      const ranked = moduleMode ? await rankQuestion(graph, entry.q, { limit: SEED_LIMIT }) : null;
      const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT, ranked });
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      const seeds = result.matches.map((m) => ({ file: m.node.file }));
      const { pass, reason } = evaluateAskEntry(entry, seeds);
      outcomes.push({ entry, pass, reason, ms });
    }

    const scored = scoreByCategory(outcomes) as Array<{
      category: string;
      total: number;
      passed: number;
      rate: number;
      p95Ms: number;
      failures: Array<{ q: string; reason: string }>;
    }>;

    const mode = moduleMode ? `module (${probe!.version})` : 'mechanical fallback — name-bearing subset';
    console.log(`\nAsk relevance — scale ${SCALE}, ${graph.nodes.length} nodes, ${corpus.length} questions, engine: ${mode}\n`);
    for (const r of scored) {
      const pct = (r.rate * 100).toFixed(0).padStart(3);
      console.log(`  ${r.rate === 1 ? '✓' : '✗'} ${r.category.padEnd(24)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${pct}%  p95 ${r.p95Ms.toFixed(1)}ms`);
      for (const f of r.failures.slice(0, 5)) console.log(`      "${f.q}" — ${f.reason}`);
    }
    const total = outcomes.length;
    const passed = outcomes.filter((o) => o.pass).length;
    console.log(`\n  ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%) questions resolved\n`);
    if (passed < total) process.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
