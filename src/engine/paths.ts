import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { buildGraphologyGraph } from './graph-model.js';
import type { VgGraph } from '../schema.js';

/**
 * Shortest connection between two nodes (`vg path`). Uses graphology's
 * bidirectional BFS over the directed graph; falls back to the reverse direction
 * so "how does A connect to B" still answers when the dependency arrow runs B→A.
 */
export interface PathResult {
  ids: string[];
  direction: 'forward' | 'reverse';
}

export function shortestPath(graph: VgGraph, srcId: string, dstId: string): PathResult | null {
  const g = buildGraphologyGraph(graph.nodes, graph.edges);
  if (!g.hasNode(srcId) || !g.hasNode(dstId)) return null;
  const forward = bidirectional(g, srcId, dstId);
  if (forward) return { ids: forward, direction: 'forward' };
  const reverse = bidirectional(g, dstId, srcId);
  if (reverse) return { ids: reverse.slice().reverse(), direction: 'reverse' };
  return null;
}
