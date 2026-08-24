/**
 * `vg code` coding-prompt relevance benchmark — the reporting half of the
 * quality gates (enforcement: src/engine/code-quality.test.ts here for the
 * mechanical fallback; the module package's gate for the full corpus).
 *
 * With a relevance provider loadable (installed, or VIBGRATE_RELEVANCE_PATH
 * — in the monorepo, packages/vibgrate-relevance/dev-provider.mjs) the FULL
 * coding-prompt corpus runs against the module engine; without one, the
 * mechanical name-bearing subset runs.
 *
 *   pnpm --filter @vibgrate/cli-public exec tsx bench/code-relevance.bench.ts
 *   BENCH_SCALE=10 BENCH_LINES=40 … (bigger repo, same expectations)
 *   BENCH_JSON=out.json               (append a machine-readable run record)
 */
import * as fs from 'node:fs';
// @ts-ignore — plain-JS fixture helper
import { generateIntentRepo } from './intent-fixture.mjs';
// @ts-ignore — plain-JS corpus helper
import { buildCodeCorpus, evaluateCodeEntry } from './code-corpus.mjs';
// @ts-ignore — shared evaluation contract
import { evaluateAskEntry } from './ask-corpus.mjs';
// @ts-ignore — scoreboard shared with the locate/ask benches
import { scoreByCategory } from './locate-corpus.mjs';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph } from '../src/engine/query.js';
import { rankQuestion } from '../src/engine/relevance-provider.js';

const SCALE = Number(process.env.BENCH_SCALE ?? 8);
const SEED_LIMIT = 16;
const MECHANICAL_CATEGORIES = new Set(['code-test-writing', 'code-refactor-named', 'code-path-hint']);

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
    const corpus = (buildCodeCorpus(catalog) as Array<{ q: string; category: string }>).filter(
      (e) => moduleMode || MECHANICAL_CATEGORIES.has(e.category),
    );

    const outcomes = [] as Array<{ entry: { q: string; category: string }; pass: boolean; reason?: string; ms: number }>;
    for (const entry of corpus) {
      const s = process.hrtime.bigint();
      const ranked = moduleMode ? await rankQuestion(graph, entry.q, { limit: SEED_LIMIT }) : null;
      const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT, ranked });
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      const seeds = result.matches.map((m) => ({ file: m.node.file }));
      const { pass, reason } = evaluateCodeEntry(entry, seeds, evaluateAskEntry);
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
    console.log(`\nvg code prompt relevance — scale ${SCALE}, ${graph.nodes.length} nodes, ${corpus.length} prompts, engine: ${mode}\n`);
    for (const r of scored) {
      const pct = (r.rate * 100).toFixed(0).padStart(3);
      console.log(
        `  ${r.rate === 1 ? '✓' : '✗'} ${r.category.padEnd(26)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${pct}%  p95 ${r.p95Ms.toFixed(1)}ms`,
      );
      for (const f of r.failures) console.log(`      "${f.q}" — ${f.reason}`);
    }
    const total = outcomes.length;
    const passed = outcomes.filter((o) => o.pass).length;
    const failed = total - passed;
    console.log(`\n  ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%) prompts resolved — ${failed} failures\n`);

    if (process.env.BENCH_JSON) {
      const record = {
        scale: SCALE,
        engine: moduleMode ? probe!.version : 'mechanical',
        total,
        passed,
        failed,
        categories: scored.map((r) => ({ category: r.category, passed: r.passed, total: r.total })),
      };
      const file = process.env.BENCH_JSON;
      const prior = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[]) : [];
      prior.push(record);
      fs.writeFileSync(file, JSON.stringify(prior, null, 2) + '\n');
    }
    if (passed < total) process.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
