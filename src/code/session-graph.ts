/**
 * Session graph (Fusion Runtime Phase 5).
 *
 * Materializes a code-map **view** that reflects the session overlay:
 * deleted overlay files drop their nodes/edges; written files are re-parsed
 * (when a parser is available) and merged so `search_code` / `graph_impact`
 * see the agent's uncommitted edits, not only the on-disk baseline.
 *
 * Deterministic given (base graph, overlay snapshot, reparses). Failures to
 * reparse a dirty file fall back to stripping that file's prior nodes (never
 * invent symbols).
 */

import { resolve } from '../engine/resolve.js';
import { parseSource } from '../engine/parse.js';
import { langForExtension } from '../engine/languages.js';
import type { FileParse } from '../engine/types.js';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';
import type { OverlayEntry } from './overlay.js';
import type { SessionOverlay } from './overlay.js';

export interface SessionGraphResult {
  graph: VgGraph;
  /** Overlay paths that were deleted in this view. */
  deleted: string[];
  /** Overlay paths that were rewritten (with or without successful reparse). */
  rewritten: string[];
  /** Paths successfully re-parsed into the session graph. */
  reparsed: string[];
}

export type SessionParseFn = (rel: string, source: string, langId: string) => Promise<FileParse>;

/**
 * Build a session-scoped graph from the baseline map + overlay.
 * When `parseFile` is omitted, uses {@link parseSource} (tree-sitter).
 */
export async function materializeSessionGraph(
  base: VgGraph,
  overlay: SessionOverlay,
  options: { parseFile?: SessionParseFn } = {},
): Promise<SessionGraphResult> {
  return applyOverlayToGraph(base, overlay.snapshot(), {
    parseFile: options.parseFile ?? defaultParse,
    readContent: (rel) => {
      const entry = overlay.snapshot().get(normalize(rel));
      if (!entry) return null;
      if (entry.kind === 'delete') return null;
      return entry.content;
    },
  });
}

/**
 * Pure-ish core (async only for parse). `dirty` is the overlay snapshot.
 */
export async function applyOverlayToGraph(
  base: VgGraph,
  dirty: Map<string, OverlayEntry>,
  options: {
    parseFile?: SessionParseFn;
    /** Content for rewritten files (required for reparse). */
    readContent?: (rel: string) => string | null;
  } = {},
): Promise<SessionGraphResult> {
  if (dirty.size === 0) {
    return { graph: base, deleted: [], rewritten: [], reparsed: [] };
  }

  const deleted: string[] = [];
  const rewritten: string[] = [];
  for (const [file, entry] of [...dirty.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.kind === 'delete') deleted.push(file);
    else rewritten.push(file);
  }

  const drop = new Set([...deleted, ...rewritten].map(normalize));

  // 1) Strip every node that lives in a dirty path; drop edges that touch them.
  const keptNodes = base.nodes.filter((n) => !drop.has(normalize(n.file)));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = base.edges.filter((e) => keptIds.has(e.src) && keptIds.has(e.dst));

  // 2) Reparse rewritten files and merge heuristic nodes/edges.
  const reparsed: string[] = [];
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];
  const parseFile = options.parseFile;
  const readContent = options.readContent;

  if (parseFile && readContent) {
    for (const file of rewritten) {
      const content = readContent(file);
      if (content === null) continue;
      const lang = langIdFor(file);
      if (!lang) continue;
      try {
        const fp = await parseFile(file, content, lang);
        const resolved = resolve([fp]);
        // Fill analysis defaults for session-only nodes (base graph already analysed).
        for (const n of resolved.nodes) {
          newNodes.push(withAnalysisDefaults(n));
        }
        for (const e of resolved.edges) {
          newEdges.push(e);
        }
        reparsed.push(file);
      } catch {
        // Reparse failed — file stays stripped (no stale symbols).
      }
    }
  }

  const nodes = [...keptNodes, ...newNodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...keptEdges, ...newEdges].sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgesFinal = edges.filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst));

  const graph: VgGraph = {
    ...base,
    nodes,
    edges: edgesFinal,
    meta: {
      ...base.meta,
      counts: {
        ...base.meta.counts,
        nodes: nodes.length,
        edges: edgesFinal.length,
      },
    },
    provenance: {
      ...base.provenance,
      // Session view fingerprint — not a corpus commit; consumers must not confuse with disk map.
      corpusHash: `${base.provenance.corpusHash}:session:${deleted.length}:${rewritten.length}:${reparsed.join(',')}`,
    },
  };

  return { graph, deleted, rewritten, reparsed };
}

/** Structural-only overlay (no parse) — deletes strip nodes; rewrites strip until reparse. */
export function applyOverlayStructural(base: VgGraph, dirty: Map<string, OverlayEntry>): SessionGraphResult {
  const deleted: string[] = [];
  const rewritten: string[] = [];
  for (const [file, entry] of dirty) {
    if (entry.kind === 'delete') deleted.push(normalize(file));
    else rewritten.push(normalize(file));
  }
  const drop = new Set([...deleted, ...rewritten]);
  const nodes = base.nodes.filter((n) => !drop.has(normalize(n.file)));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = base.edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
  return {
    graph: {
      ...base,
      nodes,
      edges,
      meta: {
        ...base.meta,
        counts: { ...base.meta.counts, nodes: nodes.length, edges: edges.length },
      },
    },
    deleted: deleted.sort(),
    rewritten: rewritten.sort(),
    reparsed: [],
  };
}

async function defaultParse(rel: string, source: string, langId: string): Promise<FileParse> {
  return parseSource(rel, langId, source);
}

function langIdFor(rel: string): string | null {
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')) : '';
  const def = langForExtension(ext);
  return def?.id ?? null;
}

function withAnalysisDefaults(n: GraphNode): GraphNode {
  return {
    ...n,
    importance: n.importance ?? 0.5,
    centrality: n.centrality ?? { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: n.area ?? 0,
    isHub: n.isHub ?? false,
    tested: n.tested ?? false,
  };
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
