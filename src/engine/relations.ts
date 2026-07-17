import type { EdgeKind, GraphEdge, GraphNode, VgGraph } from '../schema.js';

/** Indexes over a graph for O(1) neighbor lookups (built once per command). */
export class GraphIndex {
  readonly nodeById = new Map<string, GraphNode>();
  private outById = new Map<string, GraphEdge[]>();
  private inById = new Map<string, GraphEdge[]>();

  constructor(readonly graph: VgGraph) {
    for (const n of graph.nodes) this.nodeById.set(n.id, n);
    for (const e of graph.edges) {
      push(this.outById, e.src, e);
      push(this.inById, e.dst, e);
    }
  }

  out(id: string, kind?: EdgeKind): GraphEdge[] {
    const all = this.outById.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  in(id: string, kind?: EdgeKind): GraphEdge[] {
    const all = this.inById.get(id) ?? [];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  node(id: string): GraphNode | undefined {
    return this.nodeById.get(id);
  }

  /**
   * Resolved nodes called by `id` — invocations (`call`) plus structural
   * dependency references (`references`, e.g. a constructor-injected field's
   * type), since both represent real usage a caller/impact question cares
   * about. `references` is otherwise only emitted by the precise SCIP/tsc
   * rungs and (for Java DI wiring) the heuristic rung — never a guess.
   */
  callees(id: string): { edge: GraphEdge; node: GraphNode }[] {
    return this.resolveTargets(this.out(id).filter(isUsageEdge), 'dst');
  }

  /** Resolved nodes that call or structurally reference `id`. */
  callers(id: string): { edge: GraphEdge; node: GraphNode }[] {
    return this.resolveTargets(this.in(id).filter(isUsageEdge), 'src');
  }

  private resolveTargets(edges: GraphEdge[], end: 'src' | 'dst') {
    const out: { edge: GraphEdge; node: GraphNode }[] = [];
    for (const e of edges) {
      const node = this.nodeById.get(e[end]);
      if (node) out.push({ edge: e, node });
    }
    return out;
  }
}

const USAGE_KINDS: ReadonlySet<EdgeKind> = new Set(['call', 'references']);
function isUsageEdge(e: GraphEdge): boolean {
  return USAGE_KINDS.has(e.kind);
}

function push(map: Map<string, GraphEdge[]>, key: string, value: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Memoized `GraphIndex`, keyed on the graph object's identity.
 *
 * The index (node-by-id + in/out adjacency) is a pure function of the graph's
 * content, and every read path rebuilds it from scratch — an O(nodes + edges)
 * pass that, on a large map, costs hundreds of milliseconds *per query*. Under
 * `vg serve` the same parsed graph object is reused across many tool calls
 * (`GraphSource` caches it by file mtime and only replaces the reference when
 * `graph.json` actually changes), so rebuilding the index on every call is pure
 * waste. Keying a `WeakMap` on that object identity builds the index once and
 * reuses it until the file is rebuilt — at which point `GraphSource` hands back a
 * *new* object, this map misses, and the stale index is collected with the old
 * graph. Correct and stale-safe by construction: a different graph is a
 * different object, so there is no cross-graph reuse and nothing to invalidate.
 *
 * `GraphIndex` is read-only (no method mutates its maps), so sharing one
 * instance across callers is safe.
 */
const INDEX_CACHE = new WeakMap<VgGraph, GraphIndex>();

export function indexFor(graph: VgGraph): GraphIndex {
  let idx = INDEX_CACHE.get(graph);
  if (!idx) {
    idx = new GraphIndex(graph);
    INDEX_CACHE.set(graph, idx);
  }
  return idx;
}
