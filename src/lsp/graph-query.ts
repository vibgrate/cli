/**
 * `vibgrate/graph/query` — the graph-command surface for editor clients.
 *
 * Every mode here calls the exact same engine functions the CLI commands
 * (`vg ask`, `vg areas`, `vg hubs`, `vg impact`, `vg path`, `vg show`,
 * `vg tree`) call — no re-implementation, no shelling out to a second `vg`
 * process. That is what keeps "ONE ENGINE, MANY THIN CLIENTS" (see
 * `server.ts` file header) true for the graph, not just the DriftScore.
 *
 * Unlike the CLI commands, a lookup failure here returns a typed result
 * instead of throwing `CliError` — this is a long-lived server, not a
 * one-shot process that exits on error.
 */

import { queryGraph, queryGraphSemantic, type QueryResult } from '../engine/query.js';
import {
  loadEmbedder,
  getNodeEmbeddings,
  unavailableMessage,
  withTimeout,
  type EmbedUnavailable,
} from '../engine/embeddings.js';
import { embedderHealth, type EmbedHealth } from '../engine/embed-health.js';
import { resolveOne } from '../engine/lookup.js';
import { impactOf } from '../engine/impact.js';
import { shortestPath } from '../engine/paths.js';
import { indexFor } from '../engine/relations.js';
import { toJsonTree } from '../commands/tree.js';
import type { GraphNode, VgGraph } from '../schema.js';

export type GraphQueryMode = 'ask' | 'areas' | 'hubs' | 'impact' | 'path' | 'show' | 'tree';

export interface GraphQueryParams {
  mode: GraphQueryMode;
  question?: string;
  semantic?: boolean;
  budget?: number;
  limit?: number;
  name?: string;
  depth?: number;
  a?: string;
  b?: string;
  callers?: boolean;
}

export interface GraphQueryContext {
  root: string;
  /** Mirrors `vg ask --local` — skip the embedding download even if `semantic` was requested. */
  offline: boolean;
  /** Mirrors `vg ask --no-semantic` — `false` forces lexical search regardless of the request. */
  semantic?: boolean;
  /** Progress trace for the client's output channel. Never carries user text. */
  log?: (message: string) => void;
}

/**
 * Hard ceiling for the semantic path on an editor Ask. Loading the model and
 * embedding an un-cached corpus can take minutes on a large repo; the panel has
 * no way to show that, so past this budget we answer from the lexical floor and
 * let the (uncancelled) embedding keep warming the on-disk cache for next time.
 * Matches the MCP navigation path's guarantee. Override via VG_SEMANTIC_BUDGET_MS.
 */
function semanticBudgetMs(): number {
  const n = Number(process.env.VG_SEMANTIC_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

interface CandidateSummary {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export type GraphQueryResult =
  | { ok: true; mode: GraphQueryMode; data: unknown }
  | {
      ok: false;
      mode: GraphQueryMode;
      error: 'ambiguous' | 'not-found' | 'bad-request' | 'disabled';
      message: string;
      candidates?: CandidateSummary[];
    };

export async function runGraphQuery(
  graph: VgGraph,
  params: GraphQueryParams,
  ctx: GraphQueryContext,
): Promise<GraphQueryResult> {
  switch (params.mode) {
    case 'ask':
      return runAsk(graph, params, ctx);
    case 'areas':
      return runAreas(graph, params);
    case 'hubs':
      return runHubs(graph, params);
    case 'impact':
      return runImpact(graph, params);
    case 'path':
      return runPath(graph, params);
    case 'show':
      return runShow(graph, params);
    case 'tree':
      return runTree(graph, params);
    default:
      return { ok: false, mode: params.mode, error: 'bad-request', message: `unknown mode "${String(params.mode)}"` };
  }
}

async function runAsk(graph: VgGraph, params: GraphQueryParams, ctx: GraphQueryContext): Promise<GraphQueryResult> {
  const question = (params.question ?? '').trim();
  if (!question) return { ok: false, mode: 'ask', error: 'bad-request', message: 'question is required' };

  const budget = params.budget ?? 2000;
  const semanticRequested = !!params.semantic && !ctx.offline && ctx.semantic !== false;
  // The native backend can kill this process outright: a blocked
  // onnxruntime-node postinstall SIGTRAPs on first inference, and no
  // try/catch, timeout or lexical floor below survives a signal — the
  // language server dies mid-request and the host restarts it. A sacrificial
  // child process settles that question before this one loads the addon.
  const health: EmbedHealth = semanticRequested ? await embedderHealth() : { status: 'unknown' };
  const wantSemantic = semanticRequested && health.status !== 'crashed';
  const log = ctx.log ?? (() => {});

  let result: QueryResult | null = null;
  let mode = 'lexical';
  let note: string | undefined;

  if (wantSemantic) {
    const budgetMs = semanticBudgetMs();
    log(`ask: trying the semantic path (budget ${Math.round(budgetMs / 1000)}s)`);
    let reason: EmbedUnavailable | undefined;
    let detail: string | undefined;
    const started = Date.now();
    try {
      // Every step here is bounded and fallible — a missing backend, a cold
      // model, an un-embedded corpus. None of them may hold the request open:
      // the lexical floor below always answers.
      result = await withTimeout(
        (async () => {
          const embedder = await loadEmbedder({
            onUnavailable: (r, d) => {
              reason = r;
              detail = d;
            },
          });
          if (!embedder) return null;
          log(`ask: embedder "${embedder.id}" loaded in ${Date.now() - started}ms; embedding nodes…`);
          const vectors = await getNodeEmbeddings(graph, embedder, ctx.root);
          log(`ask: ${vectors.size} node vectors ready in ${Date.now() - started}ms; ranking…`);
          const r = await queryGraphSemantic(graph, question, { budget, embedder, nodeVectors: vectors });
          mode = `semantic (${embedder.id})`;
          return r;
        })(),
        budgetMs,
        'semantic search went over its time budget',
      );
      if (!result) {
        note = reason ? unavailableMessage(reason) : 'semantic unavailable; used lexical';
        // Log the loader's own error too: "not-installed" on a machine where the
        // backend *is* installed means it failed to load, and only this line
        // says why (wrong ABI, missing transitive dep, unreadable tree).
        log(
          `ask: semantic unavailable (${reason ?? 'no backend'}) — falling back to lexical` +
            (detail ? ` · ${detail}` : ''),
        );
      }
    } catch (err) {
      mode = 'lexical';
      result = null;
      note =
        'semantic search did not finish in time — answered with fast lexical search. ' +
        'It keeps warming in the background, so the next Ask should be semantic.';
      log(
        `ask: semantic path abandoned after ${Date.now() - started}ms ` +
          `(${err instanceof Error ? err.message : String(err)}) — falling back to lexical`,
      );
    }
  } else if (health.status === 'crashed') {
    note = health.message;
    log(`ask: semantic disabled — native backend crashed with ${health.signal}; answering lexically`);
  } else if (params.semantic && ctx.semantic === false) {
    note = 'semantic search is turned off — used lexical';
  } else if (params.semantic && ctx.offline) {
    note = 'semantic skipped — Vibgrate is running offline';
  }

  if (!result) {
    result = queryGraph(graph, question, { budget });
  }
  log(`ask: answered with ${mode} — ${result.matches.length} match(es)`);

  return {
    ok: true,
    mode: 'ask',
    data: {
      question: result.question,
      mode,
      note,
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
    },
  };
}

function runAreas(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const limit = params.limit ?? 30;
  const list = [...graph.areas].sort((a, b) => b.size - a.size || a.id - b.id).slice(0, limit);
  return { ok: true, mode: 'areas', data: list };
}

function runHubs(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const limit = params.limit ?? 20;
  const list = graph.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'external')
    .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, limit)
    .map(nodeSummary);
  return { ok: true, mode: 'hubs', data: list };
}

function nodeSummary(n: GraphNode) {
  return {
    id: n.id,
    name: n.qualifiedName,
    kind: n.kind,
    file: n.file,
    line: n.span.start,
    importance: n.importance,
    isHub: n.isHub,
    area: n.area,
  };
}

/** Resolve a name to one node, or a typed not-found/ambiguous result. */
function resolveOrError(
  graph: VgGraph,
  name: string,
  mode: GraphQueryMode,
): { node: GraphNode } | GraphQueryResult {
  const { node, candidates } = resolveOne(graph, name);
  if (node) return { node };
  if (candidates.length === 0) {
    return { ok: false, mode, error: 'not-found', message: `no node matches "${name}"` };
  }
  return {
    ok: false,
    mode,
    error: 'ambiguous',
    message: `"${name}" is ambiguous`,
    candidates: candidates.slice(0, 10).map((n) => ({ name: n.qualifiedName, kind: n.kind, file: n.file, line: n.span.start })),
  };
}

function runImpact(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const name = (params.name ?? '').trim();
  if (!name) return { ok: false, mode: 'impact', error: 'bad-request', message: 'name is required' };
  const resolved = resolveOrError(graph, name, 'impact');
  if (!('node' in resolved)) return resolved;
  const result = impactOf(graph, resolved.node.id, { depth: params.depth ?? 4 });
  return { ok: true, mode: 'impact', data: result };
}

function runPath(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const a = (params.a ?? '').trim();
  const b = (params.b ?? '').trim();
  if (!a || !b) return { ok: false, mode: 'path', error: 'bad-request', message: 'a and b are required' };

  const ra = resolveOrError(graph, a, 'path');
  if (!('node' in ra)) return ra;
  const rb = resolveOrError(graph, b, 'path');
  if (!('node' in rb)) return rb;

  const result = shortestPath(graph, ra.node.id, rb.node.id);
  if (!result) {
    return {
      ok: false,
      mode: 'path',
      error: 'not-found',
      message: `no path between ${ra.node.qualifiedName} and ${rb.node.qualifiedName}`,
    };
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const names = result.ids.map((id) => byId.get(id)?.qualifiedName ?? id);
  return {
    ok: true,
    mode: 'path',
    data: { from: ra.node.qualifiedName, to: rb.node.qualifiedName, hops: names.length - 1, direction: result.direction, path: names },
  };
}

function runShow(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const name = (params.name ?? '').trim();
  if (!name) return { ok: false, mode: 'show', error: 'bad-request', message: 'name is required' };
  const resolved = resolveOrError(graph, name, 'show');
  if (!('node' in resolved)) return resolved;

  const node = resolved.node;
  const index = indexFor(graph);
  const callees = dedupeNodes(index.callees(node.id).map((x) => x.node));
  const callers = dedupeNodes(index.callers(node.id).map((x) => x.node));
  const extendsEdges = index.out(node.id, 'extends').concat(index.out(node.id, 'implements'));
  const supertypes = extendsEdges.map((e) => index.node(e.dst)?.qualifiedName).filter(Boolean);
  const area = graph.areas.find((a) => a.id === node.area);

  return {
    ok: true,
    mode: 'show',
    data: {
      id: node.id,
      name: node.qualifiedName,
      kind: node.kind,
      file: node.file,
      line: node.span.start,
      signature: node.signature ?? null,
      importance: node.importance,
      centrality: node.centrality,
      isHub: node.isHub,
      area: node.area,
      areaLabel: area?.label ?? null,
      tested: node.tested,
      calls: callees.map((n) => n.qualifiedName),
      calledBy: callers.map((n) => n.qualifiedName),
      extends: supertypes,
    },
  };
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function runTree(graph: VgGraph, params: GraphQueryParams): GraphQueryResult {
  const name = (params.name ?? '').trim();
  if (!name) return { ok: false, mode: 'tree', error: 'bad-request', message: 'name is required' };
  const resolved = resolveOrError(graph, name, 'tree');
  if (!('node' in resolved)) return resolved;

  const index = indexFor(graph);
  const direction = params.callers ? 'callers' : 'callees';
  const maxDepth = Math.max(1, params.depth ?? 3);
  const data = toJsonTree(index, resolved.node, direction, maxDepth, new Set());
  return { ok: true, mode: 'tree', data };
}
