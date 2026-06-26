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

  /** Resolved nodes called by `id`. */
  callees(id: string): { edge: GraphEdge; node: GraphNode }[] {
    return this.resolveTargets(this.out(id, 'call'), 'dst');
  }

  /** Resolved nodes that call `id`. */
  callers(id: string): { edge: GraphEdge; node: GraphNode }[] {
    return this.resolveTargets(this.in(id, 'call'), 'src');
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

function push(map: Map<string, GraphEdge[]>, key: string, value: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
