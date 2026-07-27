/**
 * Build-time graph summaries for fast agent answers (hubs + blast radius).
 * Pure and deterministic: same graph → same summaries.
 */

import { indexFor } from './relations.js';
import type { EdgeKind, VgGraph } from '../schema.js';

const DEPEND_EDGES = new Set<EdgeKind>(['call', 'import', 'extends', 'implements', 'references']);

export interface HubBlastSummary {
  id: string;
  name: string;
  kind: string;
  file: string;
  importance: number;
  /** Direct dependents (depth 1). */
  direct: number;
  /** Dependents within depth 2 (includes direct). */
  depth2: number;
  /** Distinct files among depth-2 dependents. */
  files: number;
  tested: boolean | null;
}

export interface GraphSummaries {
  hubs: HubBlastSummary[];
}

const HUB_LIMIT = 40;

/**
 * Precompute blast-radius counts for the top hubs (by importance).
 * Used by MCP/CLI for near-instant "what breaks if this hub changes" answers.
 */
export function buildSummaries(graph: VgGraph): GraphSummaries {
  const index = indexFor(graph);
  const candidates = graph.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'external' && n.kind !== 'document')
    .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, HUB_LIMIT);

  const hubs: HubBlastSummary[] = candidates.map((n) => {
    const d1 = reverseDependents(index, n.id, 1);
    const d2 = reverseDependents(index, n.id, 2);
    const files = new Set<string>();
    for (const id of d2) {
      const node = index.node(id);
      if (node?.file) files.add(node.file);
    }
    return {
      id: n.id,
      name: n.qualifiedName,
      kind: n.kind,
      file: n.file,
      importance: n.importance,
      direct: d1.size,
      depth2: d2.size,
      files: files.size,
      tested: n.tested,
    };
  });

  // Stable order already by importance; re-sort for safety.
  hubs.sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));
  return { hubs };
}

function reverseDependents(
  index: ReturnType<typeof indexFor>,
  rootId: string,
  maxDepth: number,
): Set<string> {
  const affected = new Set<string>();
  let frontier = [rootId];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.in(id)) {
        if (!DEPEND_EDGES.has(e.kind)) continue;
        if (e.src === rootId || affected.has(e.src)) continue;
        affected.add(e.src);
        next.push(e.src);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return affected;
}
