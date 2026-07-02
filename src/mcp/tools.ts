import { queryGraph, queryGraphSemantic } from '../engine/query.js';
import { loadEmbedder, getNodeEmbeddings, type Embedder } from '../engine/embeddings.js';
import { resolveOne } from '../engine/lookup.js';
import { GraphIndex } from '../engine/relations.js';
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
import { boundList, NODE_EDGE_CAP } from './response.js';
import type { VgGraph } from '../schema.js';

/**
 * The read-only tool set for the LOCAL `vg serve` MCP. Every tool is
 * side-effect-free and `readOnlyHint: true` (auto-approvable), and independent of
 * Vibgrate's hosted cloud MCP. The server is offline by default; the only network
 * access is explicit opt-in — the embedder's one-time model fetch and
 * `upgrade_impact`'s `changelog` option — and both are disabled under `--local`.
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
    handler: (graph) => summarize(graph),
  },
  {
    name: 'orient',
    description:
      'ONE-SHOT orientation before changing code: the map summary + the most relevant nodes for your question + the blast radius of the top hit, in a single call. Prefer this over separate get_graph_summary + query_graph + impact_of — same answer, far fewer round-trips (each round-trip re-bills the whole conversation).',
    inputSchema: obj(
      {
        question: { type: 'string', description: 'what you are about to do or look for' },
        budget: { type: 'number', description: 'approx token budget for the context block (default 1500)' },
      },
      ['question'],
    ),
    handler: async (graph, args, ctx) => {
      const question = String(args.question ?? '');
      if (!question) return { error: 'bad_request', message: 'question is required' };
      const budget = numOr(args.budget, 1500);
      // Same retrieval path as query_graph: semantic when available, else lexical.
      const embedder = await sharedEmbedder(ctx.local);
      let q;
      let mode = 'lexical';
      if (embedder) {
        const nodeVectors = await getNodeEmbeddings(graph, embedder, ctx.root);
        q = await queryGraphSemantic(graph, question, { budget, embedder, nodeVectors });
        mode = `semantic (${embedder.id})`;
      } else {
        q = queryGraph(graph, question, { budget });
      }
      // Blast radius of the single most relevant hit, so the model sees what a
      // change there would touch without spending a second round-trip on it.
      let topImpact = null;
      const top = q.matches[0]?.node;
      if (top) {
        const r = impactOf(graph, top.id, { depth: 3 });
        topImpact = { node: top.qualifiedName, direct: r.direct, transitive: r.transitive, affected: r.affected.slice(0, 10).map(stripId) };
      }
      return {
        summary: summarize(graph),
        mode,
        context: q.context,
        matches: q.matches.map((m) => ({ name: m.node.qualifiedName, kind: m.node.kind, file: m.node.file, line: m.node.span.start, score: m.score })),
        topImpact,
      };
    },
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
    handler: (graph, args, ctx) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      const index = new GraphIndex(graph);
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
        return { ...base, repeat: true, callsTotal: uniqueNames(index.callees(node.id).map((x) => x.node.qualifiedName)).length, calledByTotal: uniqueNames(index.callers(node.id).map((x) => x.node.qualifiedName)).length };
      }
      // Bound the relationship arrays: a hub can have hundreds of callers, and
      // every one is paid for on every subsequent turn. Cap to the first ranked
      // NODE_EDGE_CAP and report the true totals so nothing is silently dropped
      // (the model can widen the blast radius with `impact_of`).
      const calls = boundList(uniqueNames(index.callees(node.id).map((x) => x.node.qualifiedName)), NODE_EDGE_CAP);
      const calledBy = boundList(uniqueNames(index.callers(node.id).map((x) => x.node.qualifiedName)), NODE_EDGE_CAP);
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
    description: 'Shortest connection between two nodes (how A reaches B).',
    inputSchema: obj(
      {
        a: { type: 'string' },
        b: { type: 'string' },
        pick_a: { type: 'number', description: 'choose nth candidate for a when ambiguous' },
        pick_b: { type: 'number', description: 'choose nth candidate for b when ambiguous' },
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
    description: 'What breaks if a node changes: the reverse-reachability blast radius with per-result depth and confidence.',
    inputSchema: obj(
      {
        name: { type: 'string' },
        depth: { type: 'number', description: 'max depth (default 4)' },
        pick: { type: 'number', description: 'choose nth candidate when ambiguous' },
      },
      ['name'],
    ),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      const r = impactOf(graph, node.id, { depth: numOr(args.depth, 4) });
      // Drop the internal content-hash `id` from each item — the model reasons
      // over name/file/line, and a 32-char blake3 per row is pure overhead.
      return { root: r.root.name, direct: r.direct, transitive: r.transitive, affected: r.affected.slice(0, 100).map(stripId) };
    },
  },
  {
    name: 'list_areas',
    description: 'The natural code groupings (communities), each labelled, sized, with cohesion.',
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
    inputSchema: obj({ name: { type: 'string' }, pick: { type: 'number', description: 'choose nth candidate when ambiguous' } }, ['name']),
    handler: (graph, args) => {
      const { node, candidates } = resolveOne(graph, String(args.name ?? ''), numOrU(args.pick));
      if (!node) return unresolved(candidates);
      return { node: node.qualifiedName, tested: node.tested, coverage: node.coverage ?? null, covers: coveringTests(graph, node) };
    },
  },
  {
    name: 'get_facts',
    description: 'The deterministic open facts for a node (contract/invariant/characterization). Requires a --deep build.',
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
    description: 'Cited relevant standards/practices for a node (OWASP/CWE), honest about recommended vs conjectured.',
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
    description: 'Offline dependency inventory across npm/pypi/go (currency enrichment is the CLI’s --online opt-in). Pass attribute:true to add git "who added this / who set the version" attribution for npm deps.',
    inputSchema: obj(
      { attribute: { type: 'boolean', description: 'enrich npm deps with git introduction attribution (requires git; slower)' } },
      [],
    ),
    handler: (_graph, args, ctx) => attributedInventory(ctx.root, { attribute: args.attribute === true }),
  },
  {
    name: 'vuln_attribution',
    description: 'Who introduced each open vulnerability and how long you have been exposed, plus CRA remediation metrics: open exposure windows, SLA breaches, and real remediation time (MTTR) reconstructed from vulnerable versions that were later bumped out or removed in git history. Offline read of the last `vg scan --vulns`.',
    inputSchema: obj({ package: { type: 'string', description: 'optional: restrict to one package' } }, []),
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
    description: 'Known vulnerabilities for installed dependencies, from the last `vg scan --vulns`. Offline read of the local scan artifact (no network); reports advisory id/CVE, severity, CVSS, and the fixed version.',
    inputSchema: obj(
      { severity: { type: 'string', enum: ['low', 'moderate', 'high', 'critical'], description: 'optional minimum severity to include' } },
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
    description: 'A local "what breaks if I upgrade this" brief for a package: major-version distance + interim majors to step through, source blast radius (how many files import it), open vulnerabilities the upgrade would fix, and a recommended posture. Offline; richest after `vg scan`. Pass changelog:true to also fetch breaking-change signals from the package\'s GitHub releases (online; ignored under --local).',
    inputSchema: obj(
      {
        package: { type: 'string', description: 'package name to assess' },
        changelog: { type: 'boolean', description: 'also fetch breaking-change signals from GitHub releases between your version and latest (online; ignored under --local)' },
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

/** Shared map overview used by both `get_graph_summary` and `orient`. */
function summarize(graph: VgGraph) {
  return {
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
