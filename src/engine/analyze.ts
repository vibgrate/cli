import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import betweenness from 'graphology-metrics/centrality/betweenness.js';
import eigenvector from 'graphology-metrics/centrality/eigenvector.js';
import louvain from 'graphology-communities-louvain';
import { mulberry32, CLUSTER_SEED } from './rng.js';
import type { Area, EdgeKind, GraphEdge, GraphNode } from '../schema.js';

/**
 * Analysis stage: importance, centrality, hubs, communities, and surprise.
 *
 * - **Centrality** blends PageRank + betweenness + eigenvector + degree over the
 *   dependency graph (call/import/extends/implements/references), catching
 *   high-fan-in critical nodes that degree-only ranking (Graphify) misses.
 * - **Communities** via Louvain (`graphology-communities-louvain`, MIT), seeded
 *   and single-pass for determinism. Leiden (via a permissive WASM impl) is a
 *   later enhancement; the cluster mode is reported honestly, never silent.
 * - **Hubs** are centrality outliers (importance ≥ mean + 2σ).
 * - **Surprise** flags improbable cross-area edges (architectural smells),
 *   surfaced by `vg oddities`.
 *
 * Pure and deterministic: identical (nodes, edges) → identical result.
 */

export type ClusterMode = 'leiden' | 'louvain' | 'none';

export interface AnalyzeOptions {
  cluster?: ClusterMode; // default 'louvain'
  /** Skip betweenness above this node count (O(V·E) — too slow for huge graphs). */
  betweennessLimit?: number;
}

export interface AnalyzeResult {
  nodes: GraphNode[];
  edges: GraphEdge[]; // surprise scores attached
  areas: Area[];
  cluster: ClusterMode;
}

// Edges that express dependency/importance (excludes contains/test/coverage).
const DEP_EDGES = new Set<EdgeKind>(['call', 'import', 'extends', 'implements', 'references']);
// Edges that express cohesion for community detection (adds containment).
const CLUSTER_EDGE_KINDS = new Set<EdgeKind>([...DEP_EDGES, 'contains']);

const IMPORTANCE_WEIGHTS = { pagerank: 0.4, betweenness: 0.25, eigenvector: 0.2, degree: 0.15 };
const DEFAULT_BETWEENNESS_LIMIT = 5000;

export function analyze(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: AnalyzeOptions = {},
): AnalyzeResult {
  const mode = options.cluster ?? 'louvain';
  // Sorted for deterministic graph construction (Louvain RNG consumption order).
  const ids = [...nodes.map((n) => n.id)].sort((a, b) => a.localeCompare(b));

  // --- centrality (directed dependency graph) ---
  const dg = simpleGraph(ids, edges, DEP_EDGES, 'directed');
  const pr = safeMetric(() => pagerank(dg), ids);
  const bw =
    dg.order <= (options.betweennessLimit ?? DEFAULT_BETWEENNESS_LIMIT)
      ? safeMetric(() => betweenness(dg), ids)
      : zeros(ids);
  const ev = safeMetric(() => eigenvector(dg), ids);
  const deg = degreeMap(dg, ids);

  const prN = normalize(pr);
  const bwN = normalize(bw);
  const evN = normalize(ev);
  const degN = normalize(deg);

  const importance = new Map<string, number>();
  for (const id of ids) {
    const score =
      IMPORTANCE_WEIGHTS.pagerank * (prN.get(id) ?? 0) +
      IMPORTANCE_WEIGHTS.betweenness * (bwN.get(id) ?? 0) +
      IMPORTANCE_WEIGHTS.eigenvector * (evN.get(id) ?? 0) +
      IMPORTANCE_WEIGHTS.degree * (degN.get(id) ?? 0);
    importance.set(id, score);
  }
  const importanceN = normalize(importance);

  // --- hubs (importance outliers) ---
  const vals = [...importanceN.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1);
  const std = Math.sqrt(variance);
  const hubThreshold = mean + 2 * std;

  // --- communities (undirected cohesion graph) ---
  const { areaByNode, mode: actualMode } = cluster(ids, edges, mode);

  const outNodes: GraphNode[] = nodes
    .map((n) => ({
      ...n,
      centrality: {
        degree: round(degN.get(n.id) ?? 0),
        pagerank: round(prN.get(n.id) ?? 0),
        betweenness: round(bwN.get(n.id) ?? 0),
        eigenvector: round(evN.get(n.id) ?? 0),
      },
      importance: round(importanceN.get(n.id) ?? 0),
      area: areaByNode.get(n.id) ?? -1,
      isHub: (importanceN.get(n.id) ?? 0) >= hubThreshold && (importanceN.get(n.id) ?? 0) > 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // --- areas (with labels, cohesion, external-edge counts) ---
  const areas = buildAreas(outNodes, edges, areaByNode);

  // --- surprise on cross-area dependency edges ---
  const outEdges = scoreSurprise(edges, areaByNode);

  return { nodes: outNodes, edges: outEdges, areas, cluster: actualMode };
}

// --- graph construction ---

function simpleGraph(
  ids: string[],
  edges: GraphEdge[],
  kinds: Set<EdgeKind>,
  type: 'directed' | 'undirected',
): Graph {
  const g = new Graph({ type, multi: false, allowSelfLoops: false });
  for (const id of ids) g.addNode(id);
  for (const e of edges) {
    if (!kinds.has(e.kind)) continue;
    if (e.src === e.dst) continue;
    if (!g.hasNode(e.src) || !g.hasNode(e.dst)) continue;
    const w = (e.confidence || 0.5) * (e.count ?? 1);
    if (type === 'directed') {
      g.updateDirectedEdge(e.src, e.dst, (attr) => ({ weight: (attr?.weight ?? 0) + w }));
    } else {
      g.updateUndirectedEdge(e.src, e.dst, (attr) => ({ weight: (attr?.weight ?? 0) + w }));
    }
  }
  return g;
}

function cluster(
  ids: string[],
  edges: GraphEdge[],
  mode: ClusterMode,
): { areaByNode: Map<string, number>; mode: ClusterMode } {
  if (mode === 'none' || ids.length === 0) {
    return { areaByNode: new Map(ids.map((id) => [id, -1])), mode: 'none' };
  }
  // Leiden is not yet bundled; fall back to Louvain and report it honestly.
  const used: ClusterMode = 'louvain';
  const ug = simpleGraph(ids, edges, CLUSTER_EDGE_KINDS, 'undirected');
  let communities: Record<string, number>;
  try {
    communities = louvain(ug, { rng: mulberry32(CLUSTER_SEED), resolution: 1 });
  } catch {
    return { areaByNode: new Map(ids.map((id) => [id, -1])), mode: 'none' };
  }

  // Remap arbitrary Louvain indices → stable area ids ordered by the lowest
  // member node id, so ids are deterministic and diff-stable across runs.
  const byCommunity = new Map<number, string[]>();
  for (const id of ids) {
    const ci = communities[id] ?? -1;
    const list = byCommunity.get(ci);
    if (list) list.push(id);
    else byCommunity.set(ci, [id]);
  }
  const ordered = [...byCommunity.entries()]
    .map(([, members]) => members.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const areaByNode = new Map<string, number>();
  ordered.forEach((members, areaId) => {
    for (const id of members) areaByNode.set(id, areaId);
  });
  return { areaByNode, mode: used };
}

function buildAreas(
  nodes: GraphNode[],
  edges: GraphEdge[],
  areaByNode: Map<string, number>,
): Area[] {
  const byArea = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const a = areaByNode.get(n.id) ?? -1;
    if (a < 0) continue;
    const list = byArea.get(a);
    if (list) list.push(n);
    else byArea.set(a, [n]);
  }

  // External-edge counts per area (dependency edges crossing area boundaries).
  const externalByArea = new Map<number, number>();
  const internalByArea = new Map<number, number>();
  for (const e of edges) {
    if (!DEP_EDGES.has(e.kind)) continue;
    const sa = areaByNode.get(e.src);
    const da = areaByNode.get(e.dst);
    if (sa === undefined || da === undefined || sa < 0 || da < 0) continue;
    if (sa === da) internalByArea.set(sa, (internalByArea.get(sa) ?? 0) + 1);
    else {
      externalByArea.set(sa, (externalByArea.get(sa) ?? 0) + 1);
      externalByArea.set(da, (externalByArea.get(da) ?? 0) + 1);
    }
  }

  const areas: Area[] = [];
  for (const [id, members] of byArea) {
    const sorted = [...members].sort(
      (a, b) => b.importance - a.importance || a.id.localeCompare(b.id),
    );
    const label = sorted[0]?.qualifiedName ?? `area-${id}`;
    const internal = internalByArea.get(id) ?? 0;
    const external = externalByArea.get(id) ?? 0;
    const cohesion = internal + external > 0 ? internal / (internal + external) : 0;
    areas.push({
      id,
      label,
      size: members.length,
      members: members.map((m) => m.id).sort((a, b) => a.localeCompare(b)),
      cohesion: round(cohesion),
      externalEdges: external,
    });
  }
  return areas.sort((a, b) => a.id - b.id);
}

function scoreSurprise(edges: GraphEdge[], areaByNode: Map<string, number>): GraphEdge[] {
  // Count edges between each unordered pair of distinct areas. Rare connections
  // are more "surprising" (architectural shortcuts).
  const pairCount = new Map<string, number>();
  for (const e of edges) {
    if (!DEP_EDGES.has(e.kind)) continue;
    const sa = areaByNode.get(e.src);
    const da = areaByNode.get(e.dst);
    if (sa === undefined || da === undefined || sa < 0 || da < 0 || sa === da) continue;
    const key = pairKey(sa, da);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  return edges
    .map((e) => {
      if (!DEP_EDGES.has(e.kind)) return e;
      const sa = areaByNode.get(e.src);
      const da = areaByNode.get(e.dst);
      if (sa === undefined || da === undefined || sa < 0 || da < 0 || sa === da) return e;
      const count = pairCount.get(pairKey(sa, da)) ?? 1;
      // Fewer crossings between two areas → higher surprise.
      return { ...e, surprise: round(1 / count) };
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
    );
}

// --- numeric helpers ---

function safeMetric(fn: () => Record<string, number>, ids: string[]): Map<string, number> {
  try {
    const res = fn();
    return new Map(ids.map((id) => [id, res[id] ?? 0]));
  } catch {
    return zeros(ids);
  }
}

function degreeMap(g: Graph, ids: string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, g.hasNode(id) ? g.degree(id) : 0]));
}

function zeros(ids: string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, 0]));
}

function normalize(m: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  if (max <= 0) return new Map(m);
  return new Map([...m].map(([k, v]) => [k, v / max]));
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
