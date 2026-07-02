import { Command } from 'commander';
import { queryGraph, queryGraphSemantic, type QueryResult } from '../engine/query.js';
import {
  loadEmbedder,
  getNodeEmbeddings,
  resolveEmbedModel,
  embeddingsCached,
  unavailableMessage,
  type EmbedUnavailable,
} from '../engine/embeddings.js';
import { refreshIfStale } from '../engine/refresh.js';
import { driftCount } from '../engine/freshness.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { c, info, json, out } from '../util/output.js';
import { ProgressBar } from '../util/progress.js';

/**
 * `vg ask "<question>"` (VG-CLI-SPEC §3.2). Hybrid lexical+structural+semantic
 * retrieval **on by default** — no API key, no flags. A local ONNX embedding
 * model is downloaded once on first use (then cached and fully offline) and
 * blends with the always-on deterministic lexical floor. It degrades gracefully
 * to lexical alone under `--local`, `--no-semantic`, on an unsupported platform,
 * or if the model can't be fetched — `ask` never fails. The context block goes
 * to stdout (pipeable); notes/progress to stderr.
 *
 * Before answering, `ask` auto-refreshes the map if the working tree drifted
 * since the last build (incremental, fail-soft; `--no-refresh` opts out), so
 * answers reflect the code as it is now — not as it was last built.
 */
export function registerAsk(program: Command): void {
  const cmd = program
    .command('ask')
    .description('ask the map — returns a budget-bounded context block')
    .argument('<question...>', 'your question (a bare quoted string also works: vg "…")')
    .option('-b, --budget <n>', 'approx token budget for the answer', '2000')
    .option('--no-semantic', 'lexical only (skip the local-embedding pass)')
    .option('--no-refresh', 'answer from the map as built — skip the auto-rebuild when files change')
    .action(async function (this: Command, question: string[], opts: { budget?: string; semantic?: boolean; refresh?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      // Answer from a map that matches the working tree: a cheap freshness
      // probe, then an incremental rebuild only if files really drifted. A
      // custom --graph is an explicit artifact and is never rebuilt over.
      // Fail-soft — a refresh problem falls back to the last built map.
      if (opts.refresh !== false && !global.graph) {
        const refreshed = await refreshIfStale(root);
        if (refreshed.status === 'refreshed' && !global.json) {
          const n = driftCount(refreshed.drift);
          info(c.dim(`  map refreshed — ${n} file(s) drifted (${(refreshed.ms / 1000).toFixed(2)}s)`));
        } else if (refreshed.status === 'error' && !global.json) {
          info(c.yellow(`  map refresh failed (${refreshed.message}) — answering from the last built map`));
        }
      }
      const { graph } = requireGraph(global);
      const budget = Number(opts.budget) || 2000;
      const q = question.join(' ');
      // Semantic is the default; --no-semantic or --local opt out.
      const wantSemantic = opts.semantic !== false && !global.local;

      let result: QueryResult;
      let mode = 'lexical';
      let note = '';

      if (wantSemantic) {
        // A genuine first run for this repo (no cached vectors yet) → show a
        // one-time note + live progress bar for the embedding pass. Otherwise stay quiet.
        const firstRun = !embeddingsCached(root, resolveEmbedModel());
        if (!global.json && firstRun) {
          info(c.dim('  preparing semantic search (first use embeds the map; cached, resumable & offline after)…'));
        }
        let reason: EmbedUnavailable | undefined;
        const embedder = await loadEmbedder({ local: global.local, onUnavailable: (r) => (reason = r) });
        if (embedder) {
          const bar = !global.json && firstRun ? new ProgressBar(c.dim('embedding')) : undefined;
          const vectors = await getNodeEmbeddings(graph, embedder, root, bar ? (d, t) => bar.update(d, t) : undefined);
          bar?.done();
          result = await queryGraphSemantic(graph, q, { budget, embedder, nodeVectors: vectors });
          mode = `semantic (${embedder.id})`;
        } else {
          result = queryGraph(graph, q, { budget });
          note = reason ? unavailableMessage(reason) : 'semantic unavailable; used lexical';
        }
      } else {
        result = queryGraph(graph, q, { budget });
        if (global.local) note = 'semantic skipped under --local; used lexical';
      }

      if (global.json) {
        json({
          question: result.question,
          mode,
          note: note || undefined,
          tokensEstimate: result.tokensEstimate,
          matches: result.matches.map((m) => ({
            name: m.node.qualifiedName,
            kind: m.node.kind,
            file: m.node.file,
            line: m.node.span.start,
            score: m.score,
            why: m.why,
          })),
          context: result.context,
        });
        return;
      }

      out(result.context);
      info('');
      info(c.dim(`vg · ${result.matches.length} match(es) · ~${result.tokensEstimate} tokens (budget ${budget}) · ${mode}`));
      if (note) info(c.yellow(`  ${note}`));
    });
  applyGlobalOptions(cmd);
}
