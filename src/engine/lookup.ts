import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Lenient node resolution (VG-CLI-SPEC §3.3): resolve `<name>` by content-hash
 * id, qualified name, `file:line`, short name, or glob. Returns candidates
 * ranked by importance so the best match is first; ambiguity is surfaced (the
 * caller offers `--pick`). Deterministic ordering throughout.
 */
export function findNodes(graph: VgGraph, query: string): GraphNode[] {
  const q = query.trim();
  if (!q) return [];

  // 1. exact content-hash id
  const byId = graph.nodes.filter((n) => n.id === q);
  if (byId.length) return byId;

  // 2. file:line (e.g. src/order.ts:12) → smallest node spanning that line
  const fileLine = /^(.*):(\d+)$/.exec(q);
  if (fileLine) {
    const file = fileLine[1];
    const line = Number(fileLine[2]);
    const spanning = graph.nodes
      .filter((n) => n.file === file && n.span.start <= line && n.span.end >= line && n.kind !== 'file')
      .sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start));
    if (spanning.length) return spanning;
  }

  // 3. glob (contains * or ?)
  if (/[*?]/.test(q)) {
    const re = globToRegExp(q);
    return rank(graph.nodes.filter((n) => re.test(n.qualifiedName) || re.test(n.name) || re.test(n.file)));
  }

  // 4. exact qualified name, then short name, then case-insensitive
  const byQn = graph.nodes.filter((n) => n.qualifiedName === q);
  if (byQn.length) return rank(byQn);
  const byName = graph.nodes.filter((n) => n.name === q);
  if (byName.length) return rank(byName);

  const lower = q.toLowerCase();
  const ci = graph.nodes.filter(
    (n) => n.qualifiedName.toLowerCase() === lower || n.name.toLowerCase() === lower,
  );
  if (ci.length) return rank(ci);

  // 5. substring on qualified name (last resort, ranked)
  return rank(graph.nodes.filter((n) => n.qualifiedName.toLowerCase().includes(lower))).slice(0, 25);
}

/** Resolve to a single node, honoring a 1-based `--pick`. */
export function resolveOne(
  graph: VgGraph,
  query: string,
  pick?: number,
): { node?: GraphNode; candidates: GraphNode[] } {
  const candidates = findNodes(graph, query);
  if (candidates.length === 0) return { candidates };
  if (pick && pick >= 1 && pick <= candidates.length) return { node: candidates[pick - 1], candidates };
  if (candidates.length === 1) return { node: candidates[0], candidates };
  return { candidates }; // ambiguous
}

export function nodeById(graph: VgGraph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

function rank(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort(
    (a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
