import { queryGraph, queryGraphSemantic } from '../engine/query.js';
import { loadEmbedder, getNodeEmbeddings, isModelReady, withTimeout, type Embedder } from '../engine/embeddings.js';
import { resolveOne } from '../engine/lookup.js';
import { indexFor } from '../engine/relations.js';
import { shortestPath } from '../engine/paths.js';
import { impactOf } from '../engine/impact.js';
import { coveringTests } from '../engine/test-query.js';
import { loadVulnerabilities, filterBySeverity, resolvePackageTarget, openFixableAdvisories } from './vuln-data.js';
import { attributedInventory } from './attribution.js';
import { computeUpgradeImpact, getChangelogSignals, type VulnSeverity } from '../core-open/index.js';
import { discoverModels } from '../engine/models.js';
import { FREE_PACK } from '../grounding/pack.js';
import { loadCatalog, resolveLib, readDoc, driftFor, resolveVersion, localPackageDocs, localApiSurface } from '../engine/lib.js';
import { selectForBudget, symbolsFromApi } from '../engine/select.js';
import { assessDocQuality } from '../engine/quality.js';
import { fetchHostedDocsCached } from '../engine/hosted-cache.js';
import { resolveDsn } from '../reporting/credentials.js';
import { parseDsn } from '../reporting/commands/push.js';
import { boundList, NODE_EDGE_CAP } from './response.js';
import { searchSymbols } from '../engine/search.js';
import type { VgGraph } from '../schema.js';

/**
 * The read-only tool set for the LOCAL `vg serve` MCP. Every tool is
 * side-effect-free and `readOnlyHint: true` (auto-approvable), and independent of
 * Vibgrate's hosted cloud MCP. The server is local-first; network access is
 * limited to the embedder's one-time model fetch, `upgrade_impact`'s `changelog`
 * option, and `library_docs`' hosted-catalog fall-through on a thin/missing local
 * doc — all disabled under `--local` (the hard airgap).
 *
 * Phase 2/3 add `tests_for`, `get_facts`, `guide_node`, `check_drift`,
 * `list_models`, `resolve_library`, `library_docs`.
 */

export interface ToolContext {
  /** Project root (for filesystem-backed tools: drift, models). */
  root: string;
  /** `--local`: keep the server air-gapped — no model download, lexical only. */
  local?: boolean;
  /** `--dedup`: collapse a node's heavy relation lists on repeat reads this session. */
  dedup?: boolean;
  /** Per-session set of node ids already returned in full (drives `--dedup`). */
  seen?: Set<string>;
}

export interface VgTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (graph: VgGraph, args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
}

/**
 * Embedder shared across calls of a long-running `vg serve` — loaded once
 * (model fetched on first use, then cached/offline), so semantic queries don't
 * re-init the model per request. `null` once we know the backend is unavailable
 * (unsupported platform / no model) so we stop retrying and use lexical.
 */
/**
 * In-memory embedder, loaded from the on-disk cache only (never a network
 * download on the request path). Resolved once and reused; `null` while the
 * model is not yet available.
 */
let warmEmbedder: Promise<Embedder | null> | null = null;
let bgWarmStarted = false;

/**
 * Kick a one-time background model download so future navigation calls can go
 * semantic — without ever blocking the current call on it. Safe to call
 * repeatedly (single-flight) and from server startup. No-op under `--local`.
 */
export function warmEmbedderInBackground(local?: boolean): void {
  if (local || bgWarmStarted || isModelReady()) return;
  bgWarmStarted = true;
  // Allows the network fetch; populates the shared disk cache + the machine
  // readiness marker. Failure just leaves us on the lexical floor.
  loadEmbedder({})
    .then((e) => {
      if (e) warmEmbedder = Promise.resolve(e);
    })
    .catch(() => {
      bgWarmStarted = false; // let a later call retry the warm
    });
}

/**
 * The embedder IF it can be had without a network download — cached in memory,
 * or loadable from the on-disk model cache. When the model isn't ready, returns
 * `null` immediately and starts a background warm. A cold model download can
 * take tens of seconds; blocking a navigation call on it is what made `orient`
 * hang and return nothing in CI, so the request path never waits for it.
 */
function readyEmbedder(local?: boolean): Promise<Embedder | null> {
  if (warmEmbedder) return warmEmbedder;
  if (local) return (warmEmbedder = loadEmbedder({ local, noDownload: true }));
  if (isModelReady()) return (warmEmbedder = loadEmbedder({ noDownload: true }));
  warmEmbedderInBackground(local);
  return Promise.resolve(null);
}

/**
 * Resolve a question to ranked matches: semantic when the embedder is warm, else
 * the deterministic lexical floor.
 *
 * Two guarantees keep this from ever hard-failing a navigation call — the
 * failure mode that made the agent abandon the graph and re-discover by grep
 * (observed in CI: `orient` returned nothing, so the model paid for both):
 *   1. it never waits on a cold model download (readyEmbedder is non-blocking);
 *   2. any fault in the semantic path (embedding, vector I/O) degrades to lexical.
 * Lexical always answers, so orient/query_graph always return content.
 */
async function retrieve(graph: VgGraph, question: string, budget: number, ctx: ToolContext) {
  let mode = 'lexical';
  try {
    const q = await withTimeout(
      (async () => {
        const embedder = await readyEmbedder(ctx.local);
        if (!embedder) return null;
        // First call on a fresh repo embeds every node here; withTimeout does not
        // cancel it, so the work continues in the background and caches to disk —
        // this call answers lexically, the next hits the warm cache and is fast.
        const nodeVectors = await getNodeEmbeddings(graph, embedder, ctx.root);
        const r = await queryGraphSemantic(graph, question, { budget, embedder, nodeVectors });
        mode = `semantic (${embedder.id})`;
        return r;
      })(),
      SEMANTIC_BUDGET_MS,
      'semantic path over budget',
    );
    if (q) return { q, mode };
  } catch {
    // Over the latency budget or a semantic fault — answer from the lexical floor.
  }
  return { q: queryGraph(graph, question, { budget }), mode: 'lexical' };
}

/**
 * Hard latency ceiling for the semantic path on a navigation call. If loading
 * the model into memory + embedding the corpus + the query doesn't finish inside
 * this, we answer lexically now and let the (uncancelled) embedding warm the
 * on-disk cache for the next call. Prevents the first `orient` on a fresh,
 * un-embedded repo from blocking past the MCP client timeout (which surfaced as
 * a zero-length result and made the agent fall back to grep). Override via
 * VG_SEMANTIC_BUDGET_MS.
 */
const SEMANTIC_BUDGET_MS = (() => {
  const n = Number(process.env.VG_SEMANTIC_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
})();

// Schema bytes are billed to the agent on EVERY model step, so this surface is
// kept deliberately lean: short descriptions, param notes only where they
// disambiguate, and no empty `required` arrays. Back-compat alias keys stay in
// the schemas (additionalProperties is false) but carry no descriptions.
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** Concise-by-default response shaping (plan P2): ids/names/counts first;
 * bodies, full context blocks and long relation lists are opt-in per call. */
const RESPONSE_FORMAT = { type: 'string', enum: ['concise', 'detailed'] };
const isDetailed = (args: Record<string, unknown>): boolean => args.response_format === 'detailed';
/** Top-N default for ranked lists under concise (opt up via limit). */
const CONCISE_MATCHES = 5;

/** Evidence tiers an agent can filter edges by (schema.ts EpistemicTier). */
const EPISTEMIC_TIERS = ['observed', 'name-matched', 'declared'] as const;
/** Shared schema fragment: the two optional edge-assurance filters. */
const EDGE_FILTER_SCHEMA = {
  min_edge_confidence: { type: 'number', description: '0..1 — drop edges below this confidence' },
  epistemic: { type: 'string', enum: EPISTEMIC_TIERS, description: 'keep only edges of this evidence tier' },
};
/**
 * Predicate over `{edge}` records for `get_node`'s call/calledBy filtering. Reads
 * `min_edge_confidence` / `epistemic` defensively; absent → keep everything
 * (unchanged behaviour). Lets an agent request only high-assurance edges, e.g.
 * `epistemic:"observed"` for resolver-confirmed calls only.
 */
function edgeRecordFilter(args: Record<string, unknown>): (x: { edge: { confidence: number; epistemic?: string } }) => boolean {
  const min = numOrU(args.min_edge_confidence);
  const tier = (EPISTEMIC_TIERS as readonly string[]).includes(String(args.epistemic)) ? String(args.epistemic) : undefined;
  if (min == null && !tier) return () => true;
  return (x) => (min == null || x.edge.confidence >= min) && (!tier || x.edge.epistemic === tier);
}

export const TOOLS: VgTool[] = [
  {
    name: 'orient',
    description:
      'Start here: one call returns the map overview, ranked matches for your question, and the top hit’s blast radius — replaces summary+query+impact round-trips.',
    // `query` is a no-description back-compat alias for `question`: the sibling
    // discovery tools (search_symbols, resolve_library) take `query`, so an agent
    // naturally reaches for it here too — accepting it turns what was a wasted
    // "question is required" round-trip into a hit. Neither is `required` (either
    // satisfies the in-handler check), matching library_docs/resolve_library.
    inputSchema: obj({
      question: { type: 'string', maxLength: 300 },
      query: { type: 'string', maxLength: 300 },
      scope: { type: 'string', description: 'path prefix to orient within' },
      budget: { type: 'number', description: 'token budget in detailed mode (default 1500)' },
      response_format: RESPONSE_FORMAT,
    }),
    handler: async (graph, args, ctx) => {
      const question = String(args.question ?? args.query ?? '');
      if (!question) return { error: 'bad_request', message: 'question is required' };
      const budget = numOr(args.budget, 1500);
      // Semantic when available, else lexical — and never throws (see retrieve).
      const { q, mode } = await retrieve(graph, question, budget, ctx);
      // Normalise scope. An agent naturally passes "." (or "./") for "here" —
      // but file paths are repo-relative ("src/…"), so a literal startsWith(".")
      // matched nothing and silently zeroed the whole result. Treat ".", "./"
      // and "" as the whole graph; strip a leading "./" from a real subdir.
      const rawScope = String(args.scope ?? '').trim();
      const scope = rawScope === '.' || rawScope === './' ? '' : rawScope.replace(/^\.\//, '');
      const scoped = scope ? q.matches.filter((m) => m.node.file.startsWith(scope)) : q.matches;
      const detailed = isDetailed(args);
      // Blast radius is a `detailed` concern. On the common "find it → read →
      // edit" path the concise caller needs the location, not what a change
      // there would touch — surfacing the ripple invites impact-exploration the
      // task doesn't need. Computing impactOf only when asked also skips the
      // traversal per call.
      let topImpact = null;
      const top = scoped[0]?.node;
      if (detailed && top) {
        const r = impactOf(graph, top.id, { depth: 3 });
        topImpact = { node: top.qualifiedName, direct: r.direct, transitive: r.transitive, affected: r.affected.slice(0, 10).map(stripId) };
      }
      const shown = detailed ? scoped : scoped.slice(0, CONCISE_MATCHES);
      return {
        // Concise "find X" calls need a one-line map (counts + languages), not the
        // full topAreas/topHubs blocks — those were ~half of every orient
        // response's tokens on the hot discovery path and the caller navigates by
        // `matches`. Detailed keeps the full overview.
        summary: detailed ? summarize(graph, 10) : conciseSummary(graph),
        mode,
        // The fact-annotated context block is detail: concise callers navigate
        // by the ranked matches and fetch nodes on demand (plan P2).
        ...(detailed ? { context: q.context } : {}),
        matches: shown.map((m) => ({ name: m.node.qualifiedName, kind: m.node.kind, file: m.node.file, line: m.node.span.start, score: m.score })),
        // A neutral availability flag, not a directive to keep querying: a
        // retrieval tool that coaches "narrow the question / see more" nudges the
        // over-navigation that re-bills the whole context on every extra step.
        ...(scoped.length > shown.length ? { moreAvailable: true } : {}),
        ...(detailed ? { topImpact } : {}),
      };
    },
  },
  {
    name: 'search_symbols',
    description:
      'Find a known name or literal string fast: ranked symbol lookup, plus a complete literal file-search for any quoted, multi-word, or path-like query (config keys, routes, log lines, UI copy). Quote a single name ("AddJwtBearer") to sweep every occurrence of it as text. A sweep reports totalTextMatches so you know you have every occurrence — use it instead of grep. Use first for most discovery; use query_graph for meaning.',
    inputSchema: obj(
      {
        query: { type: 'string', maxLength: 120, description: 'a symbol name, or a literal phrase to sweep for every occurrence of' },
        limit: { type: 'number', description: 'default 8, max 50 (raise it to fetch a whole literal sweep in one call)' },
      },
      ['query'],
    ),
    handler: async (graph, args, ctx) => {
      const limit = Math.min(50, numOr(args.limit, 8));
      return searchSymbols(graph, ctx.root, String(args.query ?? ''), limit);
    },
  },
  {
    name: 'query_graph',
    description: 'Find code by meaning when you don’t know the name: symptoms, relationships, what-breaks-if. For a known name or literal string use search_symbols.',
    // `query` is a no-description back-compat alias for `question` (see orient):
    // sibling tools take `query`, so accept it here rather than reject the call.
    inputSchema: obj({
      question: { type: 'string', maxLength: 300 },
      query: { type: 'string', maxLength: 300 },
      limit: { type: 'number', description: 'ranked matches to return (default 5)' },
      offset: { type: 'number' },
      budget: { type: 'number', description: 'context-block token budget in detailed mode (default 2000)' },
      response_format: RESPONSE_FORMAT,
    }),
    handler: async (graph, args, ctx) => {
      const question = String(args.question ?? args.query ?? '');
      if (!question) return { mode: 'lexical', matches: [], hint: 'question (or query) is required' };
      const budget = numOr(args.budget, 2000);
      // Semantic by default (local model, cached/offline after first use); falls
      // back to the deterministic lexical floor if the backend is unavailable or
      // faults — retrieve() never throws, so the tool never hard-fails.
      const { q: r, mode } = await retrieve(graph, question, budget, ctx);
      // Structured pivot instead of an empty result (plan P2): the model should
      // switch tools, not retry the same query harder.
      if (r.matches.length === 0) {
        return { mode, matches: [], hint: 'no semantic match — for a known name or literal string use search_symbols; otherwise rephrase around the behaviour you observe' };
      }
      const limit = numOr(args.limit, CONCISE_MATCHES);
      const offset = Math.max(0, numOrU(args.offset) ?? 0);
      const page = r.matches.slice(offset, offset + limit);
      return {
        mode,
        summary: `${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}; top: ${r.matches[0]!.node.qualifiedName}`,
        // The fact-annotated context block is detail (plan P2): ranked matches
        // first, fetch nodes on demand.
        ...(isDetailed(args) ? { context: r.context, tokensEstimate: r.tokensEstimate } : {}),
        matches: page.map((m) => ({ name: m.node.qualifiedName, kind: m.node.kind, file: m.node.file, line: m.node.span.start, score: m.score })),
        // Neutral pagination fact (nextOffset if the model genuinely needs more),
        // not a "narrow the question" nudge that invites another discovery round.
        ...(offset + page.length < r.matches.length ? { moreAvailable: true, nextOffset: offset + page.length } : {}),
      };
    },
  },
  {
    name: 'get_node',
    description: 'Inspect one symbol: signature, callers, callees, area. Accepts name, file:line, glob or id.',
    inputSchema: obj(
      {
        name: { type: 'string' },
        pick: { type: 'number', description: 'nth candidate if ambiguous' },
        ...EDGE_FILTER_SCHEMA,
        response_format: RESPONSE_FORMAT,
      },
      ['name'],
    ),
    handler: (graph, args, ctx) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      const index = indexFor(graph);
      // Optional edge-assurance filter: keep only calls/callers at/above a
      // confidence floor and/or of a given evidence tier, before mapping to names.
      const edgeOk = edgeRecordFilter(args);
      const calleeRecs = index.callees(node.id).filter(edgeOk);
      const callerRecs = index.callers(node.id).filter(edgeOk);
      const base = {
        name: node.qualifiedName,
        kind: node.kind,
        file: node.file,
        line: node.span.start,
        signature: node.signature ?? null,
        importance: node.importance,
        isHub: node.isHub,
        area: node.area,
      };
      // `--dedup`: if this exact node (content-addressed id) was already
      // returned in full this session, the model already has its relations —
      // re-sending them just re-bills the same tokens every turn. Return the
      // lightweight identity plus the totals and a `repeat` flag instead.
      if (ctx?.dedup && ctx.seen?.has(node.id)) {
        return { ...base, repeat: true, callsTotal: uniqueNames(calleeRecs.map((x) => x.node.qualifiedName)).length, calledByTotal: uniqueNames(callerRecs.map((x) => x.node.qualifiedName)).length };
      }
      // Bound the relationship arrays: a hub can have hundreds of callers, and
      // every one is paid for on every subsequent turn. Concise shows the top
      // CONCISE_MATCHES with true totals; detailed widens to NODE_EDGE_CAP
      // (the model can widen the blast radius further with `impact_of`).
      const edgeCap = isDetailed(args) ? NODE_EDGE_CAP : CONCISE_MATCHES;
      const calls = boundList(uniqueNames(calleeRecs.map((x) => x.node.qualifiedName)), edgeCap);
      const calledBy = boundList(uniqueNames(callerRecs.map((x) => x.node.qualifiedName)), edgeCap);
      ctx?.seen?.add(node.id);
      return {
        ...base,
        calls: calls.items,
        callsTotal: calls.total,
        calledBy: calledBy.items,
        calledByTotal: calledBy.total,
      };
    },
  },
  {
    name: 'find_path',
    description: 'Shortest connection from a to b.',
    inputSchema: obj(
      {
        a: { type: 'string' },
        b: { type: 'string' },
        pick_a: { type: 'number' },
        pick_b: { type: 'number' },
      },
      ['a', 'b'],
    ),
    handler: (graph, args) => {
      const ra = resolveOne(graph, String(args.a ?? ''), numOrU(args.pick_a));
      const rb = resolveOne(graph, String(args.b ?? ''), numOrU(args.pick_b));
      if (!ra.node) return { endpoint: 'a', ...unresolved(ra.candidates) };
      if (!rb.node) return { endpoint: 'b', ...unresolved(rb.candidates) };
      const result = shortestPath(graph, ra.node.id, rb.node.id);
      if (!result) return { connected: false };
      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      return { connected: true, direction: result.direction, path: result.ids.map((id) => byId.get(id)?.qualifiedName ?? id) };
    },
  },
  {
    name: 'impact_of',
    description: 'Blast radius of a change: what breaks if this symbol changes — dependents, files, covering tests, risk.',
    inputSchema: obj(
      {
        name: { type: 'string' },
        change_type: { type: 'string', enum: ['modify', 'delete', 'rename', 'add_dependency'] },
        depth: { type: 'number', description: 'default 4' },
        pick: { type: 'number', description: 'nth candidate if ambiguous' },
        min_edge_confidence: { type: 'number', description: '0..1 — drop dependents below this (decayed) confidence' },
        response_format: RESPONSE_FORMAT,
      },
      ['name'],
    ),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      const changeType = ['modify', 'delete', 'rename', 'add_dependency'].includes(String(args.change_type))
        ? String(args.change_type)
        : 'modify';
      const r = impactOf(graph, node.id, { depth: numOr(args.depth, 4) });
      // Optional assurance floor: drop dependents whose (distance-decayed) edge
      // confidence is below the requested threshold. Filtered in the handler —
      // impact.ts is unchanged. Recompute the direct/transitive tallies so the
      // decision contract (riskLevel, summary) reflects only the kept rows.
      const minConf = numOrU(args.min_edge_confidence);
      if (minConf != null) {
        const kept = r.affected.filter((a) => a.confidence >= minConf);
        r.affected = kept;
        r.direct = kept.filter((i) => i.depth === 1).length;
        r.transitive = kept.filter((i) => i.depth > 1).length;
        // Keep minEdgeConfidence consistent with the kept rows (never report a
        // confidence below the applied floor).
        r.minEdgeConfidence = kept.length ? Math.min(...kept.map((i) => i.confidence)) : 1;
      }
      const tests = coveringTests(graph, node);
      const filesAffected = [...new Set(r.affected.map((a) => a.file))];
      // Decision-shaped contract (plan P2): a rename/delete makes every
      // dependent a compile-break risk; a modify is weighted by fan-in.
      const heavyChange = changeType === 'delete' || changeType === 'rename';
      const riskLevel =
        node.isHub || r.direct >= 10 || r.transitive >= 50 || (heavyChange && r.direct >= 3)
          ? 'high'
          : r.direct >= 3 || r.transitive >= 10
            ? 'medium'
            : 'low';
      const summary =
        `${changeType} ${r.root.name}: ${r.direct} direct dependent${r.direct === 1 ? '' : 's'}, ` +
        `${r.transitive} transitive across ${filesAffected.length} file${filesAffected.length === 1 ? '' : 's'}; ` +
        `${tests.length} covering test${tests.length === 1 ? '' : 's'} — ${riskLevel} risk.`;
      return {
        root: r.root.name,
        changeType,
        directCallers: r.direct,
        transitiveCount: r.transitive,
        filesAffected: filesAffected.slice(0, 20),
        testsAffected: tests.length,
        riskLevel,
        summary,
        // The full row set is detail; concise callers act on the contract above.
        ...(isDetailed(args)
          ? { affected: r.affected.slice(0, 100).map(stripId) }
          : r.affected.length > 0
            ? { hint: 'response_format:"detailed" lists the affected nodes' }
            : {}),
      };
    },
  },
  {
    name: 'tests_for',
    description: 'Which tests cover this symbol — is a change here tested?',
    inputSchema: obj(
      {
        name: { type: 'string' },
        pick: { type: 'number', description: 'nth candidate if ambiguous' },
        response_format: RESPONSE_FORMAT,
      },
      ['name'],
    ),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      const covers = coveringTests(graph, node);
      return {
        node: node.qualifiedName,
        tested: node.tested,
        coverage: node.coverage ?? null,
        testCount: covers.length,
        covers: isDetailed(args) ? covers : covers.slice(0, 10),
        ...(covers.length > 10 && !isDetailed(args) ? { moreAvailable: true } : {}),
        ...(covers.length === 0 ? { hint: 'no covering tests found — a change here lands untested' } : {}),
      };
    },
  },
  {
    name: 'get_graph_summary',
    description: 'Code map overview: counts, languages, top areas and hubs.',
    inputSchema: obj({}),
    handler: (graph) => summarize(graph),
  },
  {
    name: 'list_areas',
    description: 'Code areas (communities) by size.',
    inputSchema: obj({ limit: { type: 'number' } }),
    // Strip `members` (raw content-hash id arrays): a model cannot use them and
    // on a large repo they ballooned this result past 20k tokens.
    handler: (graph, args) =>
      [...graph.areas]
        .sort((a, b) => b.size - a.size)
        .slice(0, numOr(args.limit, 30))
        .map((a) => ({ id: a.id, label: a.label, size: a.size, cohesion: a.cohesion, externalEdges: a.externalEdges })),
  },
  {
    name: 'list_hubs',
    description: 'Most-depended-on symbols.',
    inputSchema: obj({ limit: { type: 'number' } }),
    handler: (graph, args) =>
      graph.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'external')
        .sort((a, b) => b.importance - a.importance)
        .slice(0, numOr(args.limit, 20))
        .map((n) => ({ name: n.qualifiedName, kind: n.kind, file: n.file, line: n.span.start, importance: n.importance, isHub: n.isHub })),
  },
  {
    name: 'get_facts',
    description: 'Deterministic facts for a node (contract/invariant); needs a --deep build.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return unresolved(candidates);
      if (!graph.facts) return { node: node.qualifiedName, facts: [], note: 'facts require a --deep build' };
      return { node: node.qualifiedName, facts: graph.facts.filter((f) => f.subjectIds.includes(node.id)) };
    },
  },
  {
    name: 'guide_node',
    description: 'Cited standards/practices for a node (OWASP/CWE).',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return unresolved(candidates);
      const entries = new Map(FREE_PACK.entries.map((e) => [e.id, e]));
      return {
        node: node.qualifiedName,
        guidance: (graph.grounding ?? [])
          .filter((g) => g.src === node.id)
          .map((g) => ({ kind: g.kind, rationale: g.rationale, confidence: g.confidence, summary: entries.get(g.packEntryId)?.summary ?? '', citation: g.citation })),
      };
    },
  },
  {
    name: 'check_drift',
    description: 'Offline dependency inventory (npm/pypi/go); attribute:true adds git who-added attribution.',
    inputSchema: obj(
      { attribute: { type: 'boolean' } },
      [],
    ),
    handler: (_graph, args, ctx) => attributedInventory(ctx.root, { attribute: args.attribute === true }),
  },
  {
    name: 'vuln_attribution',
    description: 'Who introduced each open vulnerability, exposure windows, and CRA remediation metrics (MTTR, SLA breaches). Reads the last `vg scan --vulns`.',
    inputSchema: obj({ package: { type: 'string', description: 'restrict to one package' } }, []),
    handler: (_graph, args, ctx) => {
      const data = loadVulnerabilities(ctx.root);
      if (!data) {
        return {
          status: 'not_scanned',
          message: 'No vulnerability data found. Run `vg scan --vulns` first (attribution needs git history at scan time).',
        };
      }
      const only = args.package ? String(args.package) : null;
      const packages = (only ? data.packages.filter((p) => p.package === only) : data.packages).map((p) => ({
        ecosystem: p.ecosystem,
        package: p.package,
        installedVersion: p.version,
        advisories: p.advisories.map((a) => ({
          id: a.id,
          cve: a.aliases.find((x) => x.startsWith('CVE-')) ?? null,
          severity: a.severity,
          cvss: a.cvss,
          exposureDays: a.exposureDays ?? null,
          introduced: a.introduced ?? null,
          fixedVersions: a.fixedVersions,
        })),
      }));
      return { status: 'ok', source: data.source, cra: data.cra ?? null, packages };
    },
  },
  {
    name: 'list_vulnerabilities',
    description: 'Known vulnerabilities from the last `vg scan --vulns`: id/CVE, severity, CVSS, fixed version.',
    inputSchema: obj(
      { severity: { type: 'string', enum: ['low', 'moderate', 'high', 'critical'], description: 'minimum severity' } },
      [],
    ),
    handler: (_graph, args, ctx) => {
      const data = loadVulnerabilities(ctx.root);
      if (!data) {
        return {
          status: 'not_scanned',
          message: 'No vulnerability data found. Run `vg scan --vulns` first (online OSV, or offline with a --package-manifest carrying advisories).',
        };
      }
      const filtered = filterBySeverity(data, args.severity as VulnSeverity | undefined);
      return {
        status: 'ok',
        source: filtered.source,
        totalAdvisories: filtered.totalAdvisories,
        affectedPackages: filtered.packages.length,
        severityCounts: filtered.severityCounts,
        packages: filtered.packages.map((p) => ({
          ecosystem: p.ecosystem,
          package: p.package,
          installedVersion: p.version,
          advisories: p.advisories.map((a) => ({
            id: a.id,
            cve: a.aliases.find((x) => x.startsWith('CVE-')) ?? null,
            severity: a.severity,
            cvss: a.cvss,
            fixedVersions: a.fixedVersions,
            summary: a.summary,
          })),
        })),
      };
    },
  },
  {
    name: 'upgrade_impact',
    description: 'What breaks if you upgrade a package: major distance, import blast radius, vulns fixed, recommended posture. changelog:true adds GitHub breaking-change signals (online).',
    inputSchema: obj(
      {
        package: { type: 'string' },
        changelog: { type: 'boolean' },
      },
      ['package'],
    ),
    handler: async (_graph, args, ctx) => {
      const pkg = String(args.package ?? '');
      if (!pkg) return { error: 'bad_request', message: 'package is required' };
      const target = resolvePackageTarget(ctx.root, pkg);
      const fixesVulnerabilities = openFixableAdvisories(ctx.root, pkg);
      const impact = computeUpgradeImpact(ctx.root, { package: pkg, ...target }, { fixesVulnerabilities });
      // Online breaking-change signals are strictly opt-in and never run under --local.
      const changelog =
        args.changelog === true && !ctx.local && target.ecosystem !== 'unknown'
          ? await getChangelogSignals(target.ecosystem, pkg, target.currentVersion, target.latestVersion)
          : undefined;
      return { status: 'ok', ...impact, ...(changelog ? { changelog } : {}) };
    },
  },
  {
    name: 'list_models',
    description: 'Local models on disk (Ollama / LM Studio / gguf).',
    inputSchema: obj({}),
    handler: () => ({ models: discoverModels() }),
  },
  {
    name: 'resolve_library',
    description:
      'Resolve a library to its canonical id and the version YOUR project uses (drift-annotated). ' +
      'Call once per library and reuse the returned targetId for every library_docs follow-up — never guess an id.',
    // Canonical §4: `query` (+ optional `context_project`). `name` kept as a back-compat alias.
    inputSchema: obj(
      {
        query: {
          type: 'string',
          description: 'the package name as written in the dependency file. Good: "react-hook-form". Bad: "forms"',
        },
        name: { type: 'string' },
        context_project: { type: 'string' },
      },
      [],
    ),
    handler: (_graph, args, ctx) => {
      const query = String(args.query ?? args.name ?? '');
      if (!query) return { error: 'bad_request', message: 'query is required' };
      const ver = resolveVersion(ctx.root, query);
      const entry = resolveLib(loadCatalog(ctx.root), query);
      if (entry) {
        const drift = driftFor(ctx.root, entry);
        return {
          targetId: entry.id,
          id: entry.id, // back-compat
          name: entry.name,
          resolvedVersion: ver.served ?? entry.version,
          version: entry.version, // back-compat
          isInstalled: ver.installed != null,
          driftStatus: driftStatusOf(drift),
          drift,
          version_mismatch: ver.mismatch ?? null,
          source: 'catalog',
        };
      }
      const local = localPackageDocs(ctx.root, query);
      if (local) {
        return {
          targetId: query,
          name: query,
          resolvedVersion: local.version ?? ver.served ?? null,
          isInstalled: true,
          driftStatus: 'unknown',
          version_mismatch: ver.mismatch ?? null,
          source: local.source,
        };
      }
      return { error: 'not_found' };
    },
  },
  {
    name: 'library_docs',
    description:
      'Version-correct usage docs for a library, sliced to a token budget — official content matched to ' +
      'the version this project has installed, not web-search results. Ask a focused question via query; ' +
      'one call usually answers. After 2 calls without the section you need, stop and read the package ' +
      'source under node_modules instead of searching again.',
    // Canonical §4: `targetId`/`query`, `verbosity`, `max_tokens`. `name`/`tokens` kept as aliases.
    inputSchema: obj(
      {
        targetId: { type: 'string', description: 'id from resolve_library (preferred over query)' },
        query: {
          type: 'string',
          description:
            'the library plus the specific need. Good: "zod refine custom error message". Bad: "zod" or "docs"',
        },
        name: { type: 'string' },
        context_project: { type: 'string' },
        verbosity: { type: 'string', enum: ['concise', 'balanced', 'exhaustive'] },
        // Tolerant on purpose: models often send budgets as strings — the
        // handler coerces, so don't fail validation over "4000" vs 4000.
        max_tokens: { type: ['number', 'string'], description: 'token budget (a numeric string is accepted)' },
        tokens: { type: ['number', 'string'] },
        enterprise_strict: { type: 'boolean' },
        follow_up: { type: 'boolean' },
      },
      [],
    ),
    handler: (_graph, args, ctx) => {
      const id = String(args.targetId ?? args.query ?? args.name ?? '');
      if (!id) return { error: 'bad_request', message: 'targetId or query is required' };
      const query = String(args.query ?? args.name ?? '');
      // Adaptive default: a focused question gets a `concise` slice (the ranked
      // sections that answer it); a bare "give me the docs" keeps `balanced` so
      // breadth isn't lost. Either is overridable via `verbosity`/`max_tokens`.
      const verbosity = ['concise', 'balanced', 'exhaustive'].includes(String(args.verbosity))
        ? (String(args.verbosity) as keyof typeof VERBOSITY_BUDGET)
        : query
          ? 'concise'
          : 'balanced';
      const budget = numOrU(args.max_tokens) ?? numOrU(args.tokens) ?? VERBOSITY_BUDGET[verbosity];
      const ver = resolveVersion(ctx.root, id);
      const render = (readme: string, libName: string) => {
        const apiSurface = localApiSurface(ctx.root, libName);
        const sel = selectForBudget({ readme, query, apiSurface, budget });
        // Quality gate (D18): assess the FULL local extraction (README + API surface), not the
        // budget-trimmed slice — this decides whether the local doc can answer at all. When it
        // can't (no example / stub / query keywords absent), the hosted-catalog escalation
        // below answers instead (unless the server runs air-gapped with --local).
        const quality = assessDocQuality([readme, apiSurface].filter(Boolean).join('\n\n'), {
          name: libName,
          query,
          symbols: symbolsFromApi(apiSurface),
        });
        return {
          content: sel.text,
          metadata: {
            verbosity,
            tokens: sel.tokens,
            truncated: sel.truncated,
            quality: { sufficient: quality.sufficient, score: quality.score, reasons: quality.reasons },
            escalate: quality.sufficient ? null : 'hosted',
          },
        };
      };

      // 1. Committed catalog (drift-annotated). 2. Local-first: installed package docs on disk.
      const entry = resolveLib(loadCatalog(ctx.root), id);
      let answer: Record<string, unknown> | null = null;
      let sufficient = false;
      if (entry) {
        const r = render(readDoc(ctx.root, entry), entry.name);
        sufficient = r.metadata.quality.sufficient;
        answer = {
          targetId: entry.id,
          name: entry.name,
          version: entry.version,
          source: 'catalog',
          drift: driftFor(ctx.root, entry),
          version_mismatch: ver.mismatch ?? null,
          content: r.content,
          docs: r.content, // back-compat
          metadata: r.metadata,
        };
      } else {
        const local = localPackageDocs(ctx.root, id);
        if (local) {
          const r = render(local.docs, id);
          sufficient = r.metadata.quality.sufficient;
          answer = {
            targetId: id,
            name: id,
            version: local.version ?? ver.served,
            source: local.source,
            version_mismatch: ver.mismatch ?? null,
            content: r.content,
            docs: r.content, // back-compat
            metadata: r.metadata,
          };
        }
      }

      // Hosted escalation (S2, wired): consulted only when the local answer is missing or
      // insufficient AND the server isn't air-gapped (`--local`). Disk-cached (24h TTL under
      // .vibgrate/cache) so repeat agent lookups answer instantly; fetchHostedDocsCached fails
      // closed to null, so the best local answer (or not_found) is never broken by the
      // network. The escalation branch is the only async path — the local path stays sync.
      if (!sufficient && !ctx.local) {
        return (async () => {
          const dsn = resolveDsn();
          const parsed = dsn ? parseDsn(dsn) : null;
          const hosted = await fetchHostedDocsCached(
            ctx.root,
            { name: entry?.name ?? id, targetId: entry?.id, query: query || undefined, maxTokens: budget },
            { auth: parsed ? { keyId: parsed.keyId, secret: parsed.secret } : undefined },
          );
          if (hosted) {
            return {
              targetId: entry?.id ?? id,
              name: entry?.name ?? id,
              version: hosted.version ?? ver.served ?? null,
              source: 'hosted',
              version_mismatch: ver.mismatch ?? null,
              content: hosted.content,
              docs: hosted.content, // back-compat
              metadata: { verbosity, escalated: true, ...(hosted.metadata ?? {}) },
            };
          }
          return answer ?? { error: 'not_found' };
        })();
      }
      return answer ?? { error: 'not_found' };
    },
  },
];

/** Default token budgets by verbosity (canonical §4) when no explicit `max_tokens` is given. */
const VERBOSITY_BUDGET = { concise: 1500, balanced: 4000, exhaustive: 12000 } as const;

/** The lean one-line map for concise `orient`: counts + languages, no top lists. */
function conciseSummary(graph: VgGraph) {
  return { counts: graph.meta.counts, languages: graph.meta.languages };
}

/** Shared map overview used by both `get_graph_summary` and `orient`. */
function summarize(graph: VgGraph, top = 10) {
  return {
    counts: graph.meta.counts,
    languages: graph.meta.languages,
    cluster: graph.meta.cluster,
    resolver: graph.provenance.resolver,
    generatedAt: graph.generatedAt,
    topAreas: [...graph.areas].sort((a, b) => b.size - a.size).slice(0, top).map((a) => ({ id: a.id, label: a.label, size: a.size })),
    topHubs: graph.nodes
      .filter((n) => n.isHub)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, top)
      .map((n) => ({ name: n.qualifiedName, file: n.file, importance: n.importance })),
  };
}

/** Drop the internal content-hash `id` from an impact item — model noise. */
function stripId<T extends { id?: string }>(item: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = item;
  return rest;
}

/**
 * The shared "could not resolve to one node" payload. Candidates carry
 * kind/file/line — bare qualified names were useless when several nodes share a
 * name (the model saw ten identical strings and had nothing to `pick` by).
 */
function unresolved(candidates: { qualifiedName: string; kind: string; file: string; span: { start: number } }[]) {
  return {
    error: candidates.length ? 'ambiguous' : 'not_found',
    candidates: candidates.slice(0, 10).map((n, i) => ({ pick: i + 1, name: n.qualifiedName, kind: n.kind, file: n.file, line: n.span.start })),
    ...(candidates.length ? { hint: 'call again with pick:<n> or a file:line name' } : {}),
  };
}

/** Map the internal drift note to the canonical §4 driftStatus vocabulary. */
function driftStatusOf(d: { drift: string }): string {
  if (d.drift === 'current') return 'current';
  if (d.drift === 'behind') return 'outdated';
  if (d.drift === 'ahead') return 'ahead';
  return 'unknown';
}

function numOr(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function numOrU(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function uniqueNames(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * The hot navigation core (plan P3, VG-NAVIGATION-PROFILE.md): the tools an
 * agent needs on the common path, kept in model context up front. Everything
 * else is discovered on demand via tool-search, so the per-step schema bill
 * drops to the core only. This is a CLIENT loading configuration over the one
 * server tool set — the server always exposes all of `TOOLS`; deferral-capable
 * hosts load the core and defer the tail. Ordered to match the TOOLS array.
 */
export const HOT_TOOLS = ['orient', 'search_symbols', 'query_graph', 'get_node'] as const;

/** Tools deferred until a task discovers them (everything not in the hot core). */
export function deferredToolNames(): string[] {
  const hot = new Set<string>(HOT_TOOLS);
  return TOOLS.map((t) => t.name).filter((n) => !hot.has(n));
}

/**
 * The Anthropic `mcp_toolset` deferral block for embedding `vg serve` in an
 * agent built on the Claude API: the hot core stays loaded, the rest defer and
 * are found via tool-search. Real, measured lever on hosts that support
 * `defer_loading` (~350–450 schema tokens/step vs 1,881 for the full set);
 * hosts that don't support it simply serve the whole optimized set. The server
 * is unchanged either way — one tool set, no modes.
 */
export function navigationToolsetConfig(serverName = 'vibgrate'): Record<string, unknown> {
  return {
    type: 'mcp_toolset',
    mcp_server_name: serverName,
    default_config: { defer_loading: true },
    configs: Object.fromEntries(HOT_TOOLS.map((n) => [n, { defer_loading: false }])),
  };
}
