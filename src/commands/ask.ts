import { Command } from 'commander';
import { queryGraph, queryGraphSemantic, type QueryResult } from '../engine/query.js';
import { analyzeQuestion } from '../engine/relevance-provider.js';
import { loadTopicTags } from '../engine/relevance-enrich.js';
import {
  loadEmbedder,
  getNodeEmbeddings,
  resolveEmbedModel,
  embeddingsCached,
  unavailableMessage,
  type EmbedUnavailable,
} from '../engine/embeddings.js';
import { refreshIfStale } from '../engine/refresh.js';
import { attachVgd, type AttachResult } from '../runtime/vgd/attach.js';
import { ActivityLog, type ActivityOutcome } from '../runtime/vgd/activity.js';
import { DaemonSemanticSession } from '../runtime/vgd/semantic-client.js';
import { driftCount } from '../engine/freshness.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
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
        // Thread the resolved map path so a refresh never re-runs defaultGraphPath
        // (which shells out to git for the branch-keyed global store).
        const graphPath = resolveGraphPath(root, global.graph);
        const refreshed = await refreshIfStale(root, { graphPath });
        if (refreshed.status === 'refreshed' && !global.json) {
          const n = driftCount(refreshed.drift);
          info(c.dim(`  map refreshed — ${n} file(s) drifted (${(refreshed.ms / 1000).toFixed(2)}s)`));
        } else if (refreshed.status === 'error' && !global.json) {
          info(c.yellow(`  map refresh failed (${refreshed.message}) — answering from the last built map`));
        }
      }
      const { graph } = requireGraph(global);
      // Join the local runtime (starting it if needed) and hand it this map, so
      // the semantic pass below can run against its resident index instead of
      // loading a model into this short-lived process.
      const activity = new ActivityLog();
      const attached = await activity.time(
        'attach',
        () =>
          attachVgd(root, {
            graphPath: global.graph,
            disabled: global.daemon === false,
            // Skip the republish when the daemon already holds this exact map:
            // a publish drops the slot's vectors, so doing it on every ask
            // churned the index for nothing.
            corpusHash: graph.provenance?.corpusHash,
          }),
        (a) => describeAttach(a),
      );
      const budget = Number(opts.budget) || 2000;
      const q = question.join(' ');
      // Semantic is the default; --no-semantic or --local opt out.
      const wantSemantic = opts.semantic !== false && !global.local;

      let result: QueryResult;
      let mode = 'lexical';
      let note = '';
      // Optional relevance provider (engine/relevance-provider.ts): widens
      // seed vocabulary when installed; null (the default) changes nothing.
      const relevance = await analyzeQuestion(q);
      const topicTags = relevance ? await loadTopicTags(graph, root, resolveGraphPath(root, global.graph)) : null;

      if (wantSemantic) {
        // Daemon first: it already holds vectors for this slot, so it answers
        // the semantic half without this process loading the model at all.
        const ranked = attached.status === 'attached' && attached.repositoryId
          ? await activity.time(
              'semantic',
              // The attach above already resolved (and, if needed, published)
              // the slot — this session only sends the question.
              () => new DaemonSemanticSession(root, { socketPath: attached.socketPath, publish: false }).rank(q),
              (r) =>
                r
                  ? { outcome: 'ok' as const, detail: `ranked in the daemon · ${r.ranked.length} of ${r.vectors} vector(s)${r.model ? ` · ${r.model}` : ''}` }
                  : { outcome: 'skip' as const, detail: 'daemon has no usable index — embedding in this process' },
            )
          : null;
        if (ranked) {
          result = await queryGraphSemantic(graph, q, {
            budget,
            semanticRanked: ranked.ranked,
            relevance,
            topicTags,
          });
          mode = `semantic (vgd${ranked.model ? `, ${ranked.model}` : ''})`;
          activity.add('answer', 'ok', 'answered from the daemon index — no local model load');
        } else {
          // A genuine first run for this repo (no cached vectors yet) → show a
          // one-time note + live progress bar for the embedding pass. Otherwise stay quiet.
          const firstRun = !embeddingsCached(root, resolveEmbedModel());
          if (!global.json && firstRun) {
            info(c.dim('  preparing semantic search (first use embeds the map; cached, resumable & offline after)…'));
          }
          let reason: EmbedUnavailable | undefined;
          let detail: string | undefined;
          const embedder = await loadEmbedder({
            local: global.local,
            onUnavailable: (r, d) => {
              reason = r;
              detail = d;
            },
          });
          if (embedder) {
            const bar = !global.json && firstRun ? new ProgressBar(c.dim('embedding')) : undefined;
            const vectors = await getNodeEmbeddings(graph, embedder, root, bar ? (d, t) => bar.update(d, t) : undefined);
            bar?.done();
            result = await queryGraphSemantic(graph, q, { budget, embedder, nodeVectors: vectors, relevance, topicTags });
            mode = `semantic (${embedder.id})`;
            activity.add('answer', 'ok', `answered in this process · ${embedder.id} · ${vectors.size} vector(s)`);
          } else {
            result = queryGraph(graph, q, { budget, relevance, topicTags });
            note = reason ? unavailableMessage(reason) : 'semantic unavailable; used lexical';
            if (detail) note += ` (${detail})`;
            activity.add('answer', 'warn', `lexical only — ${note}`);
          }
        }
      } else {
        result = queryGraph(graph, q, { budget, relevance, topicTags });
        if (global.local) note = 'semantic skipped under --local; used lexical';
        activity.add('answer', 'skip', global.local ? 'lexical only (--local)' : 'lexical only (--no-semantic)');
      }

      // Count this call in the local ledger when an AI host identified itself
      // (`--client`). `ask` is the CLI twin of the MCP `query_graph` tool, so it
      // records under that shared name with source `cli` — that's the
      // command-vs-MCP split `vg savings` reports.
      if (global.client) {
        const files = new Set(result.matches.map((m) => m.node.file).filter(Boolean));
        recordCliCall(
          root,
          {
            tool: CLI_TOOL_ALIASES.ask,
            client: global.client,
            outcome: result.matches.length === 0 ? 'miss' : 'complete',
            vgTokens: result.tokensEstimate,
            baselineFiles: files.size,
          },
          Date.now(),
        );
      }

      if (global.json) {
        json({
          question: result.question,
          mode,
          note: note || undefined,
          activity: activity.toJSON(),
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
      for (const line of activity.render()) info(line);
    });
  applyGlobalOptions(cmd);
}

/** One line describing what attaching to the runtime achieved. */
function describeAttach(a: AttachResult): { outcome: ActivityOutcome; detail: string } {
  if (a.status === 'disabled') return { outcome: 'skip', detail: `${a.reason} — running in this process` };
  if (a.status === 'unavailable') return { outcome: 'skip', detail: `${a.reason} — running in this process` };
  const started = a.started ? 'started vgd' : 'attached to vgd';
  if (a.published?.status === 'current') {
    return { outcome: 'ok', detail: `${started} · already holds this map (${a.published.gitRef})` };
  }
  if (a.published?.status === 'published') {
    return { outcome: 'ok', detail: `${started} · map published ${a.published.gitRef} · ${a.published.nodeCount} nodes` };
  }
  if (a.published?.status === 'failed') {
    return { outcome: 'warn', detail: `${started} · map not published (${a.published.error})` };
  }
  return { outcome: 'ok', detail: started };
}
