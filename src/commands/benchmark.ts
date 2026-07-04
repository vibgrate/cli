import * as fs from 'node:fs';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { serializeGraph } from '../engine/serialize.js';
import { queryGraph } from '../engine/query.js';
import { discover } from '../engine/discover.js';
import { resolveLimits, type ResourceLimits } from '../engine/limits.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info, json } from '../util/output.js';
import type { VgGraph } from '../schema.js';

/**
 * `vg benchmark` (VG-ENGINE-TEARDOWN §6) — reproducible, cache-aware,
 * honest-estimate benchmark on the current repo:
 *   - cold vs incremental build time, plus throughput (files/s, MB/s);
 *   - memory: peak RSS/heap sampled across the cold build, heap retained by
 *     the loaded graph, serialized artifact size (all labelled approximate —
 *     GC timing and OS accounting make them indicative, not exact);
 *   - determinism (two pinned builds must be byte-identical);
 *   - token reduction: vg's context block vs a grep/read baseline, per question;
 *   - the effective resource limits (VG_MAX_FILE_BYTES etc.) the run built under.
 *
 * Token figures are clearly-labelled estimates (~4 chars/token), scaling with
 * repo size — never a hero number.
 */
const PIN = '2020-01-01T00:00:00.000Z';

export interface BenchmarkResult {
  repo: { files: number; nodes: number; edges: number };
  build: { coldMs: number; incrementalMs: number; reusedOnWarm: number };
  throughput: { corpusBytes: number; filesPerSec: number; mbPerSec: number };
  memory: {
    baselineRssMb: number;
    peakRssMb: number;
    peakHeapMb: number;
    retainedHeapMb: number;
    graphJsonBytes: number;
    bytesPerNode: number;
    note: string;
  };
  limits: ResourceLimits;
  determinism: { byteIdentical: boolean };
  tokenReduction: {
    questions: { question: string; vgTokens: number; baselineTokens: number; ratio: number }[];
    aggregateRatio: number;
    note: string;
  };
}

export function registerBenchmark(program: Command): void {
  const cmd = program
    .command('benchmark')
    .description('reproducible build + memory + token-reduction benchmark (honest estimates)')
    .option('--budget <n>', 'token budget for vg answers', '2000')
    .action(async function (this: Command, opts: { budget?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const budget = Number(opts.budget) || 2000;
      const result = await runBenchmarkSuite(root, budget);

      if (global.json) {
        json(result);
        return;
      }

      const { repo, build, throughput, memory, determinism, tokenReduction } = result;
      info(`${c.cyan('vg benchmark')} · ${repo.files} files · ${repo.nodes} nodes`);
      info(`  build   cold ${build.coldMs.toFixed(0)}ms · incremental ${build.incrementalMs.toFixed(0)}ms (reused ${build.reusedOnWarm})`);
      info(`  speed   ${throughput.filesPerSec.toFixed(0)} files/s · ${throughput.mbPerSec.toFixed(1)} MB/s (cold, ${mb(throughput.corpusBytes).toFixed(1)} MB corpus)`);
      info(
        `  memory  peak rss ${memory.peakRssMb.toFixed(0)} MB (baseline ${memory.baselineRssMb.toFixed(0)} MB) · ` +
          `peak heap ${memory.peakHeapMb.toFixed(0)} MB · graph retains ~${memory.retainedHeapMb.toFixed(0)} MB ${c.dim('(approximate)')}`,
      );
      info(`  graph   ${mb(memory.graphJsonBytes).toFixed(1)} MB serialized · ${memory.bytesPerNode.toFixed(0)} B/node`);
      info(`  determinism  ${determinism.byteIdentical ? c.green('byte-identical ✓') : c.red('NON-DETERMINISTIC ✗')}`);
      if (tokenReduction.questions.length) {
        info(`  token reduction vs grep/read baseline (${c.dim('estimates')}):`);
        for (const q of tokenReduction.questions) {
          info(`    ${pad(`${q.ratio.toFixed(1)}×`, 6)} ${c.dim(`vg ${q.vgTokens} vs ~${q.baselineTokens}`)}  "${q.question}"`);
        }
        info(`  ${c.bold(`aggregate ≈ ${tokenReduction.aggregateRatio.toFixed(1)}× fewer tokens`)} ${c.dim('(honest estimate, scales with repo size)')}`);
      }
    });
  applyGlobalOptions(cmd);
}

/**
 * The benchmark body, exported for tests. Timings and memory figures are
 * environment-dependent by nature (the graph artifact stays deterministic; the
 * measurements of producing it are not).
 */
export async function runBenchmarkSuite(root: string, budget: number): Promise<BenchmarkResult> {
  // 1. cold build (no cache), with peak-memory sampling across it.
  const baseline = process.memoryUsage();
  const sampler = startMemorySampler();
  const t0 = now();
  const cold = await buildGraph({ root, generatedAt: PIN, noCache: true });
  const coldMs = now() - t0;

  // 2. incremental build (warm cache)
  const t1 = now();
  const warm = await buildGraph({ root, generatedAt: PIN });
  const warmMs = now() - t1;

  // 3. determinism: two pinned builds byte-identical
  const a = serializeGraph(cold.graph);
  const b = serializeGraph((await buildGraph({ root, generatedAt: PIN, noCache: true })).graph);
  const peak = sampler.stop();
  const deterministic = a === b;

  const after = process.memoryUsage();
  const corpusBytes = cold.fileStats.reduce((s, f) => s + f.size, 0);
  const graphJsonBytes = Buffer.byteLength(a, 'utf8');
  const nodes = cold.graph.meta.counts.nodes;

  // 4. token reduction vs a grep/read baseline
  const questions = deriveQuestions(cold.graph);
  const fileSizes = fileSizeIndex(root);
  const perQuestion = questions.map((q) => {
    const vgTokens = queryGraph(cold.graph, q, { budget }).tokensEstimate;
    const baseTokens = grepBaselineTokens(q, fileSizes);
    return { question: q, vgTokens, baselineTokens: baseTokens, ratio: baseTokens > 0 ? round(baseTokens / Math.max(vgTokens, 1)) : 1 };
  });
  const totalVg = perQuestion.reduce((s, x) => s + x.vgTokens, 0);
  const totalBase = perQuestion.reduce((s, x) => s + x.baselineTokens, 0);
  const aggregateRatio = totalVg > 0 ? round(totalBase / totalVg) : 0;

  return {
    repo: { files: cold.totalFiles, nodes, edges: cold.graph.meta.counts.edges },
    build: { coldMs: round(coldMs), incrementalMs: round(warmMs), reusedOnWarm: warm.reused },
    throughput: {
      corpusBytes,
      filesPerSec: coldMs > 0 ? round((cold.totalFiles / coldMs) * 1000) : 0,
      // 6-decimal precision: a small corpus at 3 decimals would round to 0.
      mbPerSec: coldMs > 0 ? round6((mb(corpusBytes) / coldMs) * 1000) : 0,
    },
    memory: {
      baselineRssMb: round(mb(baseline.rss)),
      peakRssMb: round(mb(Math.max(peak.rss, baseline.rss))),
      peakHeapMb: round(mb(Math.max(peak.heapUsed, baseline.heapUsed))),
      // Heap growth across the run ≈ what the loaded graphs + caches retain.
      retainedHeapMb: round(Math.max(0, mb(after.heapUsed - baseline.heapUsed))),
      graphJsonBytes,
      bytesPerNode: nodes > 0 ? round(graphJsonBytes / nodes) : 0,
      note: 'sampled at 25ms + phase boundaries; GC timing makes these approximate',
    },
    limits: resolveLimits(),
    determinism: { byteIdentical: deterministic },
    tokenReduction: { questions: perQuestion, aggregateRatio, note: 'estimates (~4 chars/token); scales with repo size' },
  };
}

/**
 * Track peak RSS / heapUsed while the build runs: a 25ms sampling interval
 * (unref'd so it never holds the process open) catches the high-water mark
 * between phase boundaries; `stop()` takes one final sample so short runs
 * that finish inside one interval still register.
 */
function startMemorySampler(): { stop: () => { rss: number; heapUsed: number } } {
  let rss = 0;
  let heapUsed = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    if (m.rss > rss) rss = m.rss;
    if (m.heapUsed > heapUsed) heapUsed = m.heapUsed;
  };
  const timer = setInterval(sample, 25);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return { rss, heapUsed };
    },
  };
}

function deriveQuestions(graph: VgGraph): string[] {
  // Deterministic, repo-derived question set: the top hub names. Reproducible
  // and meaningful without hardcoding anything repo-specific.
  return graph.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'external')
    .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, 5)
    .map((n) => n.name);
}

function fileSizeIndex(root: string): { rel: string; abs: string; size: number }[] {
  return discover({ root }).map((f) => ({ rel: f.rel, abs: f.abs, size: safeSize(f.abs) }));
}

function grepBaselineTokens(term: string, files: { abs: string; size: number }[]): number {
  // Baseline = an agent greps for the term and reads every matching file.
  const lower = term.toLowerCase();
  let bytes = 0;
  for (const f of files) {
    if (f.size > 512 * 1024) continue; // skip huge files in the baseline
    let content = '';
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (content.toLowerCase().includes(lower)) bytes += content.length;
  }
  return Math.ceil(bytes / 4);
}

function safeSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}
function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}
function pad(s: string, n: number): string {
  return s.padStart(n, ' ');
}
