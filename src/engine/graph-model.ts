import Graph from 'graphology';
import type { GraphEdge, GraphNode } from '../schema.js';

/**
 * Build the in-memory graphology multigraph from the schema nodes/edges. This is
 * the model the analysis (centrality, clustering), query, and path commands run
 * over. A directed multigraph: multiple typed edges may connect the same pair
 * (e.g. a `call` and an `import`), each keyed by its content id.
 */
export function buildGraphologyGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const g = new Graph({ type: 'directed', multi: true, allowSelfLoops: true });
  for (const n of nodes) {
    g.addNode(n.id, { kind: n.kind, name: n.name });
  }
  for (const e of edges) {
    // Edges can reference nodes that exist; src/dst always come from node ids we
    // created, so both endpoints are present. Guard anyway for robustness.
    if (!g.hasNode(e.src) || !g.hasNode(e.dst)) continue;
    if (g.hasEdge(e.id)) continue;
    g.addDirectedEdgeWithKey(e.id, e.src, e.dst, { kind: e.kind, weight: e.confidence });
  }
  return g;
}
