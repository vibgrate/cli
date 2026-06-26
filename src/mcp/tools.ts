import { queryGraph, queryGraphSemantic } from '../engine/query.js';
import { loadEmbedder, getNodeEmbeddings, type Embedder } from '../engine/embeddings.js';
import { resolveOne } from '../engine/lookup.js';
import { GraphIndex } from '../engine/relations.js';
import { shortestPath } from '../engine/paths.js';
import { impactOf } from '../engine/impact.js';
import { coveringTests } from '../engine/test-query.js';
import { inventory } from '../engine/drift.js';
import { discoverModels } from '../engine/models.js';
import { FREE_PACK } from '../grounding/pack.js';
import { loadCatalog, resolveLib, readDoc, driftFor, resolveVersion, localPackageDocs, localApiSurface } from '../engine/lib.js';
import { selectForBudget, symbolsFromApi } from '../engine/select.js';
import { assessDocQuality } from '../engine/quality.js';
import type { VgGraph } from '../schema.js';

/**
 * The read-only tool set for the LOCAL `vg serve` MCP. Every tool is pure over
 * the in-memory graph, side-effect-free, and `readOnlyHint: true` (auto-
 * approvable). This is a self-contained local server — it never touches the
 * network and is independent of Vibgrate's hosted cloud MCP.
 *
 * Phase 2/3 add `tests_for`, `get_facts`, `guide_node`, `check_drift`,
 * `list_models`, `resolve_library`, `library_docs`.
 */

export interface ToolContext {
  /** Project root (for filesystem-backed tools: drift, models). */
  root: string;
  /** `--local`: keep the server air-gapped — no model download, lexical only. */
  local?: boolean;
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
let embedderPromise: Promise<Embedder | null> | undefined;
function sharedEmbedder(local?: boolean): Promise<Embedder | null> {
  if (!embedderPromise) embedderPromise = loadEmbedder({ local });
  return embedderPromise;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: VgTool[] = [
  {
    name: 'get_graph_summary',
    description: 'High-level summary of the code map: counts, languages, clustering, top areas and hubs.',
    inputSchema: obj({}),
    handler: (graph) => ({
      counts: graph.meta.counts,
      languages: graph.meta.languages,
      cluster: graph.meta.cluster,
      resolver: graph.provenance.resolver,
      generatedAt: graph.generatedAt,
      topAreas: [...graph.areas].sort((a, b) => b.size - a.size).slice(0, 10).map((a) => ({ id: a.id, label: a.label, size: a.size })),
      topHubs: graph.nodes
        .filter((n) => n.isHub)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 10)
        .map((n) => ({ name: n.qualifiedName, file: n.file, importance: n.importance })),
    }),
  },
  {
    name: 'query_graph',
    description: 'Ask the map a natural-language question; returns a budget-bounded, fact-annotated context block plus ranked matches.',
    inputSchema: obj(
      {
        question: { type: 'string', description: 'the question' },
        budget: { type: 'number', description: 'approx token budget (default 2000)' },
      },
      ['question'],
    ),
    handler: async (graph, args, ctx) => {
      const question = String(args.question ?? '');
      const budget = numOr(args.budget, 2000);
      // Semantic by default (local model, cached/offline after first use); falls
      // back to the deterministic lexical floor if the backend is unavailable.
      let r;
      let mode = 'lexical';
      const embedder = await sharedEmbedder(ctx.local);
      if (embedder) {
        const nodeVectors = await getNodeEmbeddings(graph, embedder, ctx.root);
        r = await queryGraphSemantic(graph, question, { budget, embedder, nodeVectors });
        mode = `semantic (${embedder.id})`;
      } else {
        r = queryGraph(graph, question, { budget });
      }
      return {
        mode,
        context: r.context,
        tokensEstimate: r.tokensEstimate,
        matches: r.matches.map((m) => ({ name: m.node.qualifiedName, kind: m.node.kind, file: m.node.file, line: m.node.span.start, score: m.score })),
      };
    },
  },
  {
    name: 'get_node',
    description: 'Explain a node: kind, signature, callers, callees, area, importance. Resolves by qualified/short name, file:line, glob, or id.',
    inputSchema: obj(
      { name: { type: 'string' }, pick: { type: 'number', description: 'choose nth candidate when ambiguous' } },
      ['name'],
    ),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return { error: candidates.length ? 'ambiguous' : 'not_found', candidates: candidates.slice(0, 10).map((n) => n.qualifiedName) };
      const index = new GraphIndex(graph);
      return {
        name: node.qualifiedName,
        kind: node.kind,
        file: node.file,
        line: node.span.start,
        signature: node.signature ?? null,
        importance: node.importance,
        isHub: node.isHub,
        area: node.area,
        calls: uniqueNames(index.callees(node.id).map((x) => x.node.qualifiedName)),
        calledBy: uniqueNames(index.callers(node.id).map((x) => x.node.qualifiedName)),
      };
    },
  },
  {
    name: 'find_path',
    description: 'Shortest connection between two nodes (how A reaches B).',
    inputSchema: obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    handler: (graph, args) => {
      const ra = resolveOne(graph, String(args.a ?? ''));
      const rb = resolveOne(graph, String(args.b ?? ''));
      if (!ra.node || !rb.node) return { error: 'not_found' };
      const result = shortestPath(graph, ra.node.id, rb.node.id);
      if (!result) return { connected: false };
      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      return { connected: true, direction: result.direction, path: result.ids.map((id) => byId.get(id)?.qualifiedName ?? id) };
    },
  },
  {
    name: 'impact_of',
    description: 'What breaks if a node changes: the reverse-reachability blast radius with per-result depth and confidence.',
    inputSchema: obj({ name: { type: 'string' }, depth: { type: 'number', description: 'max depth (default 4)' } }, ['name']),
    handler: (graph, args) => {
      const { node } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return { error: 'not_found' };
      const r = impactOf(graph, node.id, { depth: numOr(args.depth, 4) });
      return { root: r.root.name, direct: r.direct, transitive: r.transitive, affected: r.affected.slice(0, 100) };
    },
  },
  {
    name: 'list_areas',
    description: 'The natural code groupings (communities), each labelled, sized, with cohesion.',
    inputSchema: obj({ limit: { type: 'number' } }),
    handler: (graph, args) => [...graph.areas].sort((a, b) => b.size - a.size).slice(0, numOr(args.limit, 30)),
  },
  {
    name: 'list_hubs',
    description: 'The most-depended-on code (centrality outliers).',
    inputSchema: obj({ limit: { type: 'number' } }),
    handler: (graph, args) =>
      graph.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'external')
        .sort((a, b) => b.importance - a.importance)
        .slice(0, numOr(args.limit, 20))
        .map((n) => ({ name: n.qualifiedName, kind: n.kind, file: n.file, line: n.span.start, importance: n.importance, isHub: n.isHub })),
  },
  {
    name: 'tests_for',
    description: 'Which tests cover a node (static call linkage + runtime coverage), with the linkage basis.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    handler: (graph, args) => {
      const { node } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return { error: 'not_found' };
      return { node: node.qualifiedName, tested: node.tested, coverage: node.coverage ?? null, covers: coveringTests(graph, node) };
    },
  },
  {
    name: 'get_facts',
    description: 'The deterministic open facts for a node (contract/invariant/characterization). Requires a --deep build.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    handler: (graph, args) => {
      const { node } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return { error: 'not_found' };
      if (!graph.facts) return { node: node.qualifiedName, facts: [], note: 'facts require a --deep build' };
      return { node: node.qualifiedName, facts: graph.facts.filter((f) => f.subjectIds.includes(node.id)) };
    },
  },
  {
    name: 'guide_node',
    description: 'Cited relevant standards/practices for a node (OWASP/CWE), honest about recommended vs conjectured.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    handler: (graph, args) => {
      const { node } = resolveOne(graph, String(args.name ?? ''));
      if (!node) return { error: 'not_found' };
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
    description: 'Offline dependency inventory across npm/pypi/go (currency enrichment is the CLI’s --online opt-in).',
    inputSchema: obj({}),
    handler: (_graph, _args, ctx) => inventory(ctx.root),
  },
  {
    name: 'list_models',
    description: 'The local model fleet discovered on disk (Ollama / LM Studio / gguf). Offline, no launch.',
    inputSchema: obj({}),
    handler: () => ({ models: discoverModels() }),
  },
  {
    name: 'resolve_library',
    description: 'Resolve a library name/query to its canonical id + the version for YOUR project (the Context7 resolve_library swap-in, version-correct + drift-annotated).',
    // Canonical §4: `query` (+ optional `context_project`). `name` kept as a back-compat alias.
    inputSchema: obj(
      {
        query: { type: 'string', description: 'library name or natural-language query' },
        name: { type: 'string', description: 'alias for query (back-compat)' },
        context_project: { type: 'string', description: 'optional lockfile/manifest context (informational; the local server uses the project root)' },
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
    description: 'Version-correct, drift-annotated usage docs for a library — from the committed catalog or the installed package on disk (the Context7 library_docs swap-in).',
    // Canonical §4: `targetId`/`query`, `verbosity`, `max_tokens`. `name`/`tokens` kept as aliases.
    inputSchema: obj(
      {
        targetId: { type: 'string', description: 'canonical id from resolve_library' },
        query: { type: 'string', description: 'library name or query' },
        name: { type: 'string', description: 'alias for query (back-compat)' },
        context_project: { type: 'string', description: 'optional project context (informational)' },
        verbosity: { type: 'string', enum: ['concise', 'balanced', 'exhaustive'], description: 'detail level (sets the default token budget)' },
        max_tokens: { type: 'number', description: 'explicit token budget (overrides verbosity)' },
        tokens: { type: 'number', description: 'alias for max_tokens (back-compat)' },
        enterprise_strict: { type: 'boolean', description: 'reserved (enterprise policy enforcement — hosted surface)' },
        follow_up: { type: 'boolean', description: 'reserved (next slice — hosted surface)' },
      },
      [],
    ),
    handler: (_graph, args, ctx) => {
      const id = String(args.targetId ?? args.query ?? args.name ?? '');
      if (!id) return { error: 'bad_request', message: 'targetId or query is required' };
      const verbosity = ['concise', 'balanced', 'exhaustive'].includes(String(args.verbosity))
        ? (String(args.verbosity) as keyof typeof VERBOSITY_BUDGET)
        : 'balanced';
      const budget = numOrU(args.max_tokens) ?? numOrU(args.tokens) ?? VERBOSITY_BUDGET[verbosity];
      const ver = resolveVersion(ctx.root, id);
      const query = String(args.query ?? args.name ?? '');
      const render = (readme: string, libName: string) => {
        const apiSurface = localApiSurface(ctx.root, libName);
        const sel = selectForBudget({ readme, query, apiSurface, budget });
        // Quality gate (D18): assess the FULL local extraction (README + API surface), not the
        // budget-trimmed slice — this decides whether the local doc can answer at all. When it
        // can't (no example / stub / query keywords absent), the hosted catalog (S2) should
        // answer instead. The hosted surface is gated on sign-off and not wired into the open
        // engine, so we serve the best local doc and flag that an upgrade is available.
        const quality = assessDocQuality([readme, apiSurface].filter(Boolean).join('\n\n'), {
          name: libName,
          query,
          symbols: symbolsFromApi(apiSurface),
        });
        // ESCALATION SEAM: if (!quality.sufficient && hostedAvailable(ctx)) return hostedDocs(...); // S2
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
      if (entry) {
        const r = render(readDoc(ctx.root, entry), entry.name);
        return {
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
      }
      const local = localPackageDocs(ctx.root, id);
      if (local) {
        const r = render(local.docs, id);
        return {
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
      return { error: 'not_found' };
    },
  },
];

/** Default token budgets by verbosity (canonical §4) when no explicit `max_tokens` is given. */
const VERBOSITY_BUDGET = { concise: 1500, balanced: 4000, exhaustive: 12000 } as const;

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
