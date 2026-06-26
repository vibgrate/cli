import { GraphIndex } from './relations.js';
import type { EdgeKind, VgGraph } from '../schema.js';

/**
 * Deterministic reverse-reachability impact analysis (VG-CLI-SPEC §3.5).
 *
 * "What breaks if `<node>` changes" = everything that (transitively) depends on
 * it: its callers, importers, and subtypes. We BFS *backwards* along dependency
 * edges, bounded by depth, with a confidence that decays with distance (direct =
 * high; transitive lower; ambiguous/dynamic edges already carry lower edge
 * confidence which we fold in). Test-impact selection (`--tests`) lands in
 * Phase 2; this is the structural blast radius.
 */

const DEPEND_EDGES = new Set<EdgeKind>(['call', 'import', 'extends', 'implements', 'references']);

export interface ImpactItem {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  depth: number;
  confidence: number;
}

export interface ImpactResult {
  root: { id: string; name: string };
  depth: number;
  affected: ImpactItem[];
  direct: number;
  transitive: number;
  /** Lowest edge confidence encountered (e.g. a dynamic-dispatch edge). */
  minEdgeConfidence: number;
}

export function impactOf(graph: VgGraph, rootId: string, opts: { depth?: number } = {}): ImpactResult {
  const maxDepth = Math.max(1, opts.depth ?? 4);
  const index = new GraphIndex(graph);
  const root = index.node(rootId);

  const affected = new Map<string, ImpactItem>();
  let minEdgeConfidence = 1;

  // BFS over incoming dependency edges (dependents of the frontier).
  let frontier: { id: string; conf: number }[] = [{ id: rootId, conf: 1 }];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: { id: string; conf: number }[] = [];
    for (const { id, conf } of frontier) {
      for (const e of index.in(id)) {
        if (!DEPEND_EDGES.has(e.kind)) continue;
        minEdgeConfidence = Math.min(minEdgeConfidence, e.confidence);
        const dependentId = e.src;
        if (dependentId === rootId || affected.has(dependentId)) continue;
        const node = index.node(dependentId);
        if (!node) continue;
        const conf2 = round(conf * e.confidence * 0.9); // decay with distance
        affected.set(dependentId, {
          id: node.id,
          name: node.qualifiedName,
          kind: node.kind,
          file: node.file,
          line: node.span.start,
          depth,
          confidence: conf2,
        });
        nextFrontier.push({ id: dependentId, conf: conf2 });
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  const items = [...affected.values()].sort(
    (a, b) => a.depth - b.depth || b.confidence - a.confidence || a.name.localeCompare(b.name),
  );

  return {
    root: { id: rootId, name: root?.qualifiedName ?? rootId },
    depth: maxDepth,
    affected: items,
    direct: items.filter((i) => i.depth === 1).length,
    transitive: items.filter((i) => i.depth > 1).length,
    minEdgeConfidence: round(minEdgeConfidence),
  };
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
