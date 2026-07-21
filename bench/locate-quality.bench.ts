import * as fs from 'node:fs';
import { buildGraph } from '../src/engine/build.js';
import { searchSymbols, clearListingCache } from '../src/engine/search.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS fixture helper, no types needed
import { generateXlRepo } from './xl-fixture.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS corpus helper, no types needed
import { buildCorpus, evaluateEntry, scoreByCategory } from './locate-corpus.mjs';

/**
 * The published locate-quality benchmark: the full categorized corpus (100+
 * queries per run, scaling with BENCH_SCALE) against a REAL graph built from
 * the polyglot XL fixture. Reports per-category resolution rate and latency so
 * each release can be compared against the last — the tracked goal is that an
 * agent never needs grep. Run:
 *
 *   pnpm --filter @vibgrate/cli-public bench:locate                # scale 12
 *   BENCH_SCALE=40 pnpm --filter @vibgrate/cli-public bench:locate # bigger repo
 *
 * The same corpus is enforced at 100% in CI by src/engine/search-quality.test.ts
 * (small scale); this script is the numbers half — bigger repo, latency columns,
 * and a non-zero exit on any resolution failure so release automation can gate.
 */

const SCALE = Number(process.env.BENCH_SCALE ?? 12);
const LIMIT = 15;

interface Entry {
  q: string;
  category: string;
  k: number;
  mustMiss?: boolean;
}

async function main(): Promise<void> {
  const { root, catalog } = generateXlRepo(SCALE) as { root: string; catalog: unknown };
  const t0 = process.hrtime.bigint();
  const built = await buildGraph({
    root,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const corpus = buildCorpus(catalog) as Entry[];

  clearListingCache();
  const outcomes = [];
  for (const entry of corpus) {
    const s = process.hrtime.bigint();
    const result = await searchSymbols(built.graph, root, entry.q, LIMIT);
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const { pass, reason } = evaluateEntry(entry, result) as { pass: boolean; reason?: string };
    outcomes.push({ entry, pass, reason, ms });
  }

  const scored = scoreByCategory(outcomes) as Array<{
    category: string;
    total: number;
    passed: number;
    rate: number;
    meanMs: number;
    p95Ms: number;
    failures: Array<{ q: string; reason: string }>;
  }>;

  console.log(
    `\nLocate quality — XL fixture scale ${SCALE} (${built.totalFiles} files, ${built.graph.nodes.length} nodes), ` +
      `graph build ${(buildMs / 1000).toFixed(1)}s, ${corpus.length} queries\n`,
  );
  console.log(`  ${pad('category', 24)} ${pad('queries', 8)} ${pad('resolved', 9)} ${pad('rate', 6)} ${pad('mean', 8)} p95`);
  for (const r of scored) {
    console.log(
      `  ${pad(r.category, 24)} ${padNum(r.total, 7)} ${padNum(r.passed, 8)}  ${pad(`${Math.round(r.rate * 100)}%`, 6)} ${pad(fmtMs(r.meanMs), 8)} ${fmtMs(r.p95Ms)}`,
    );
  }
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.pass).length;
  const all = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  console.log(
    `\n  overall ${passed}/${total} (${Math.round((passed / total) * 100)}%) · ` +
      `query mean ${fmtMs(all.reduce((a, b) => a + b, 0) / all.length)} · p95 ${fmtMs(all[Math.floor(all.length * 0.95)]!)}\n`,
  );

  const failures = scored.flatMap((r) => r.failures.map((f) => ({ ...f, category: r.category })));
  if (failures.length) {
    console.log('  FAILURES:');
    for (const f of failures) console.log(`    [${f.category}] "${f.q}" — ${f.reason}`);
    console.log('');
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) process.exit(2);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}
function padNum(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}
function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(1)}ms`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
