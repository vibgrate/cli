import * as path from 'node:path';
import { runBenchmarkSuite, type BenchmarkResult } from '../src/commands/benchmark.js';

/**
 * The build/memory/determinism/token-estimate suite, run over a real tree. Run:
 *
 *   pnpm --filter @vibgrate/cli-public bench:suite                 # current package
 *   pnpm --filter @vibgrate/cli-public bench:suite -- --root ../.. # the monorepo
 *   BENCH_DIR=/path/to/repo pnpm --filter @vibgrate/cli-public bench:suite
 *   pnpm --filter @vibgrate/cli-public bench:suite -- --json       # machine-readable
 *
 * `--budget <n>` sets the per-question token budget used for the token-reduction
 * arm (default 2000).
 *
 * This is a harness, not a `vg` subcommand: the CLI surface is a budget (P1) and
 * these numbers are for release tooling and feature before/after runs (P4), not
 * for end users. The graph artifact is byte-deterministic; the *measurements* of
 * producing it are environment-dependent, so timings and memory figures are
 * honest estimates for comparison on one machine — never a hero number.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const root = path.resolve(arg('root') ?? process.env.BENCH_DIR ?? process.cwd());
  const budget = Number(arg('budget') ?? 2000);
  const result = await runBenchmarkSuite(root, budget);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  report(root, budget, result);
}

function report(root: string, budget: number, r: BenchmarkResult): void {
  console.log(`\nBuild suite — ${root}`);
  console.log(`  ${r.repo.files} files · ${r.repo.nodes} nodes · ${r.repo.edges} edges · budget ${budget} tokens\n`);

  console.log('Build');
  console.log(row('cold (no cache)', `${r.build.coldMs.toFixed(1)} ms`));
  console.log(row('incremental (warm)', `${r.build.incrementalMs.toFixed(1)} ms`));
  console.log(row('files reused on warm', `${r.build.reusedOnWarm} / ${r.repo.files}`));
  console.log(row('throughput', `${r.throughput.filesPerSec.toFixed(0)} files/s · ${r.throughput.mbPerSec.toFixed(2)} MB/s`));
  console.log(row('corpus', `${mb(r.throughput.corpusBytes)} MB`));

  console.log('\nMemory');
  console.log(row('baseline RSS', `${r.memory.baselineRssMb.toFixed(1)} MB`));
  console.log(row('peak RSS', `${r.memory.peakRssMb.toFixed(1)} MB`));
  console.log(row('peak heap', `${r.memory.peakHeapMb.toFixed(1)} MB`));
  console.log(row('retained heap', `${r.memory.retainedHeapMb.toFixed(1)} MB`));
  console.log(row('graph.json', `${mb(r.memory.graphJsonBytes)} MB · ${r.memory.bytesPerNode.toFixed(0)} B/node`));
  console.log(`    note: ${r.memory.note}`);

  console.log('\nLimits in effect');
  console.log(row('maxFileBytes / maxFiles', `${r.limits.maxFileBytes} / ${r.limits.maxFiles}`));
  console.log(row('tscMaxFiles / memoryBudgetMb', `${r.limits.tscMaxFiles} / ${r.limits.memoryBudgetMb}`));

  console.log('\nDeterminism');
  console.log(row('two pinned builds byte-identical', r.determinism.byteIdentical ? 'yes' : 'NO — REGRESSION'));

  console.log('\nToken reduction vs a grep/read baseline');
  console.log(`  ${pad('question', 34)} ${padNum('vg', 9)} ${padNum('baseline', 10)} ${padNum('ratio', 8)}`);
  for (const q of r.tokenReduction.questions) {
    console.log(`  ${pad(q.question, 34)} ${padNum(q.vgTokens, 9)} ${padNum(q.baselineTokens, 10)} ${padNum(`${q.ratio.toFixed(1)}x`, 8)}`);
  }
  console.log(`  ${pad('aggregate', 34)} ${padNum('', 9)} ${padNum('', 10)} ${padNum(`${r.tokenReduction.aggregateRatio.toFixed(1)}x`, 8)}`);
  console.log(`    note: ${r.tokenReduction.note}\n`);

  if (!r.determinism.byteIdentical) process.exitCode = 1;
}

function row(label: string, value: string): string {
  return `  ${pad(label, 34)} ${value}`;
}
function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}
function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}
function padNum(n: number | string, w: number): string {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
