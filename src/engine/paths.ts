import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { buildGraphologyGraph } from './graph-model.js';
import { indexFor } from './relations.js';
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

/** One-hop usage neighbors used when endpoints are not connected. */
export interface EndpointNeighborhood {
  name: string;
  calls: string[];
  calledBy: string[];
  imports: string[];
  importedBy: string[];
}

/**
 * Actionable disconnect context for `vg path` / `find_path` when BFS finds no
 * route. Agents otherwise treat a bare "no path" as a dead end; neighbors make
 * the next query (`show` / `impact` / a different endpoint) obvious.
 */
export interface PathDisconnect {
  connected: false;
  from: EndpointNeighborhood;
  to: EndpointNeighborhood;
  hint: string;
}

const NEIGHBOR_CAP = 6;

export function pathDisconnect(graph: VgGraph, srcId: string, dstId: string): PathDisconnect {
  const idx = indexFor(graph);
  const from = neighborhood(idx, srcId);
  const to = neighborhood(idx, dstId);
  const hint =
    from.calls.length || from.calledBy.length || to.calls.length || to.calledBy.length
      ? 'No direct call/import chain links these symbols. Try `vg show` / `vg impact` on each end, or path via a shared hub.'
      : 'Neither endpoint has call/import neighbors in the map — they may be isolated docs/externals, or the link needs a more precise build.';
  return { connected: false, from, to, hint };
}

function neighborhood(
  idx: ReturnType<typeof indexFor>,
  id: string,
): EndpointNeighborhood {
  const node = idx.node(id);
  const name = node?.qualifiedName ?? id;
  const calls = uniqueNames(idx.callees(id).map((x) => x.node.qualifiedName));
  const calledBy = uniqueNames(idx.callers(id).map((x) => x.node.qualifiedName));
  const imports = uniqueNames(
    idx
      .out(id, 'import')
      .map((e) => idx.node(e.dst)?.qualifiedName)
      .filter((n): n is string => !!n),
  );
  const importedBy = uniqueNames(
    idx
      .in(id, 'import')
      .map((e) => idx.node(e.src)?.qualifiedName)
      .filter((n): n is string => !!n),
  );
  return { name, calls, calledBy, imports, importedBy };
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, NEIGHBOR_CAP);
}
