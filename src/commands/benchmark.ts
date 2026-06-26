import * as fs from 'node:fs';
import { Command } from 'commander';
import { buildGraph } from '../engine/build.js';
import { serializeGraph } from '../engine/serialize.js';
import { queryGraph } from '../engine/query.js';
import { discover } from '../engine/discover.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info, json } from '../util/output.js';
import type { VgGraph } from '../schema.js';

/**
 * `vg benchmark` (VG-ENGINE-TEARDOWN §6) — reproducible, cache-aware,
 * honest-estimate benchmark on the current repo:
 *   - cold vs incremental build time;
 *   - determinism (two pinned builds must be byte-identical);
 *   - token reduction: vg's context block vs a grep/read baseline, per question.
 *
 * Token figures are clearly-labelled estimates (~4 chars/token), scaling with
 * repo size — never a hero number.
 */
const PIN = '2020-01-01T00:00:00.000Z';

export function registerBenchmark(program: Command): void {
  const cmd = program
    .command('benchmark')
    .description('reproducible build + token-reduction benchmark (honest estimates)')
    .option('--budget <n>', 'token budget for vg answers', '2000')
    .action(async function (this: Command, opts: { budget?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const budget = Number(opts.budget) || 2000;

      // 1. cold build (no cache)
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
      const deterministic = a === b;

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

      const result = {
        repo: { files: cold.totalFiles, nodes: cold.graph.meta.counts.nodes, edges: cold.graph.meta.counts.edges },
        build: { coldMs: round(coldMs), incrementalMs: round(warmMs), reusedOnWarm: warm.reused },
        determinism: { byteIdentical: deterministic },
        tokenReduction: { questions: perQuestion, aggregateRatio, note: 'estimates (~4 chars/token); scales with repo size' },
      };

      if (global.json) {
        json(result);
        return;
      }

      info(`${c.cyan('vg benchmark')} · ${result.repo.files} files · ${result.repo.nodes} nodes`);
      info(`  build   cold ${result.build.coldMs.toFixed(0)}ms · incremental ${result.build.incrementalMs.toFixed(0)}ms (reused ${warm.reused})`);
      info(`  determinism  ${deterministic ? c.green('byte-identical ✓') : c.red('NON-DETERMINISTIC ✗')}`);
      if (perQuestion.length) {
        info(`  token reduction vs grep/read baseline (${c.dim('estimates')}):`);
        for (const q of perQuestion) {
          info(`    ${pad(`${q.ratio.toFixed(1)}×`, 6)} ${c.dim(`vg ${q.vgTokens} vs ~${q.baselineTokens}`)}  "${q.question}"`);
        }
        info(`  ${c.bold(`aggregate ≈ ${aggregateRatio.toFixed(1)}× fewer tokens`)} ${c.dim('(honest estimate, scales with repo size)')}`);
      }
    });
  applyGlobalOptions(cmd);
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

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function pad(s: string, n: number): string {
  return s.padStart(n, ' ');
}
