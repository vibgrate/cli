/**
 * SQLite serve index for large maps (scale past flat-JSON-only serve).
 *
 * The canonical artifact remains `graph.json` (determinism / git). The index
 * at `.vibgrate/cache/graph.db` is a derived, gitignored structure built after
 * every successful build:
 *   - denormalized name/edge columns for O(log n) lookup
 *   - full node/edge/area JSON for reconstructing a `VgGraph` without parsing
 *     the pretty-printed graph.json (faster cold serve on XL maps)
 *
 * Uses Node's built-in `node:sqlite` (Node ≥22) — no native npm dependency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheDir } from './cache.js';
import { loadGraphFileWithSnapshot } from './snapshot.js';
import type {
  Area,
  EpistemicTier,
  GraphEdge,
  GraphNode,
  ResolverKind,
  VgGraph,
} from '../schema.js';
import { SCHEMA_VERSION } from '../schema.js';

export interface IndexWriteResult {
  path: string;
  nodes: number;
  edges: number;
  /** False when node:sqlite is unavailable — callers should not fail the build. */
  ok: boolean;
  reason?: string;
}

export function indexDbPath(root: string): string {
  return path.join(cacheDir(root), 'graph.db');
}

/** Write (replace) the SQLite index from a built graph. Never throws to callers. */
export function writeGraphIndex(root: string, graph: VgGraph): IndexWriteResult {
  const file = indexDbPath(root);
  try {
     
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }

    const db = new DatabaseSync(tmp);
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        importance REAL NOT NULL,
        area INTEGER NOT NULL,
        is_hub INTEGER NOT NULL,
        lang TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        resolution TEXT NOT NULL,
        confidence REAL NOT NULL,
        epistemic TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE areas (
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE INDEX idx_nodes_name ON nodes(name);
      CREATE INDEX idx_nodes_qn ON nodes(qualified_name);
      CREATE INDEX idx_nodes_file ON nodes(file);
      CREATE INDEX idx_edges_src ON edges(src);
      CREATE INDEX idx_edges_dst ON edges(dst);
      CREATE INDEX idx_edges_kind ON edges(kind);
    `);

    const insMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    insMeta.run('corpusHash', graph.provenance.corpusHash);
    insMeta.run('schemaVersion', graph.schemaVersion);
    insMeta.run('generatedAt', graph.generatedAt);
    insMeta.run('nodeCount', String(graph.nodes.length));
    insMeta.run('edgeCount', String(graph.edges.length));
    insMeta.run('analysisTier', graph.meta.analysisTier ?? 'full');
    insMeta.run('indexVersion', 'vg-graph-index/2');
    // Full meta + provenance for reconstruct without graph.json parse.
    insMeta.run('graphMeta', JSON.stringify(graph.meta));
    insMeta.run('graphProvenance', JSON.stringify(graph.provenance));
    if (graph.facts) insMeta.run('factsJson', JSON.stringify(graph.facts));
    if (graph.grounding) insMeta.run('groundingJson', JSON.stringify(graph.grounding));
    if (graph.summaries) insMeta.run('summariesJson', JSON.stringify(graph.summaries));
    if (graph.unknowns) insMeta.run('unknownsJson', JSON.stringify(graph.unknowns));

    const insNode = db.prepare(
      `INSERT INTO nodes(id, name, qualified_name, kind, file, line, importance, area, is_hub, lang, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of graph.nodes) {
      insNode.run(
        n.id,
        n.name,
        n.qualifiedName,
        n.kind,
        n.file,
        n.span.start,
        n.importance,
        n.area,
        n.isHub ? 1 : 0,
        n.lang,
        JSON.stringify(n),
      );
    }

    const insEdge = db.prepare(
      `INSERT INTO edges(id, kind, src, dst, resolution, confidence, epistemic, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of graph.edges) {
      insEdge.run(
        e.id,
        e.kind,
        e.src,
        e.dst,
        e.resolution,
        e.confidence,
        e.epistemic ?? 'observed',
        JSON.stringify(e),
      );
    }

    const insArea = db.prepare('INSERT INTO areas(id, json) VALUES (?, ?)');
    for (const a of graph.areas) {
      insArea.run(a.id, JSON.stringify(a));
    }

    db.close();
    fs.renameSync(tmp, file);
    return { path: file, nodes: graph.nodes.length, edges: graph.edges.length, ok: true };
  } catch (err) {
    return {
      path: file,
      nodes: 0,
      edges: 0,
      ok: false,
      reason: (err as Error).message,
    };
  }
}

export interface NameHit {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  importance: number;
}

/** Fast name / prefix lookup against the index. Empty if index missing. */
export function lookupNameIndex(root: string, query: string, limit = 20): NameHit[] {
  const file = indexDbPath(root);
  if (!fs.existsSync(file) || !query.trim()) return [];
  try {
     
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const q = query.trim();
    const rows = db
      .prepare(
        `SELECT id, name, qualified_name, kind, file, line, importance
         FROM nodes
         WHERE name = ? OR qualified_name = ? OR name LIKE ? OR qualified_name LIKE ?
         ORDER BY
           CASE WHEN name = ? OR qualified_name = ? THEN 0
                WHEN name LIKE ? THEN 1
                ELSE 2 END,
           importance DESC
         LIMIT ?`,
      )
      .all(q, q, `${q}%`, `%${q}%`, q, q, `${q}%`, limit) as Record<string, unknown>[];
    db.close();
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      qualifiedName: String(r.qualified_name),
      kind: String(r.kind),
      file: String(r.file),
      line: Number(r.line),
      importance: Number(r.importance),
    }));
  } catch {
    return [];
  }
}

/** Neighbor edges for a node id (src or dst). Empty if index missing. */
export function lookupNeighbors(
  root: string,
  nodeId: string,
  direction: 'out' | 'in' | 'both' = 'both',
  limit = 50,
): GraphEdge[] {
  const file = indexDbPath(root);
  if (!fs.existsSync(file) || !nodeId) return [];
  try {
     
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    let rows: Record<string, unknown>[] = [];
    if (direction === 'out' || direction === 'both') {
      rows = rows.concat(
        db
          .prepare(`SELECT json FROM edges WHERE src = ? LIMIT ?`)
          .all(nodeId, limit) as Record<string, unknown>[],
      );
    }
    if (direction === 'in' || direction === 'both') {
      rows = rows.concat(
        db
          .prepare(`SELECT json FROM edges WHERE dst = ? LIMIT ?`)
          .all(nodeId, limit) as Record<string, unknown>[],
      );
    }
    db.close();
    const byId = new Map<string, GraphEdge>();
    for (const r of rows) {
      try {
        const e = JSON.parse(String(r.json)) as GraphEdge;
        byId.set(e.id, e);
      } catch {
        /* skip bad row */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** Read index meta (corpusHash etc.) or null if missing. */
export function readIndexMeta(root: string): Record<string, string> | null {
  const file = indexDbPath(root);
  if (!fs.existsSync(file)) return null;
  try {
     
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    db.close();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return null;
  }
}

/**
 * Reconstruct a full `VgGraph` from the SQLite index (indexVersion ≥ 2).
 * Returns null if the index is missing, stale schema, or incomplete.
 * Prefer this over JSON.parse of pretty graph.json for cold serve on large maps.
 */
export function loadGraphFromIndex(root: string): VgGraph | null {
  const file = indexDbPath(root);
  if (!fs.existsSync(file)) return null;
  try {
     
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as {
      key: string;
      value: string;
    }[];
    const meta: Record<string, string> = {};
    for (const r of metaRows) meta[r.key] = r.value;

    if (meta.indexVersion !== 'vg-graph-index/2' || !meta.graphMeta || !meta.graphProvenance) {
      db.close();
      return null;
    }

    const nodeRows = db.prepare('SELECT json FROM nodes ORDER BY id').all() as {
      json: string;
    }[];
    const edgeRows = db.prepare('SELECT json FROM edges ORDER BY id').all() as {
      json: string;
    }[];
    const areaRows = db.prepare('SELECT json FROM areas ORDER BY id').all() as {
      json: string;
    }[];
    db.close();

    const nodes = nodeRows.map((r) => JSON.parse(r.json) as GraphNode);
    const edges = edgeRows.map((r) => JSON.parse(r.json) as GraphEdge);
    const areas = areaRows.map((r) => JSON.parse(r.json) as Area);

    // Stable sorts match serialize contract (ids already ordered by SQL, re-sort for safety).
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
    );
    areas.sort((a, b) => a.id - b.id);

    const graph: VgGraph = {
      schemaVersion: (meta.schemaVersion as typeof SCHEMA_VERSION) || SCHEMA_VERSION,
      generatedAt: meta.generatedAt ?? new Date(0).toISOString(),
      provenance: JSON.parse(meta.graphProvenance),
      meta: JSON.parse(meta.graphMeta),
      nodes,
      edges,
      areas,
    };
    if (meta.factsJson) graph.facts = JSON.parse(meta.factsJson);
    if (meta.groundingJson) graph.grounding = JSON.parse(meta.groundingJson);
    if (meta.summariesJson) graph.summaries = JSON.parse(meta.summariesJson);
    if (meta.unknownsJson) graph.unknowns = JSON.parse(meta.unknownsJson);

    // Lightweight integrity: edge resolution types stay valid.
    for (const e of edges) {
      if (!e.resolution) e.resolution = 'heuristic' as ResolverKind;
      if (!e.epistemic) e.epistemic = 'observed' as EpistemicTier;
    }
    return graph;
  } catch {
    return null;
  }
}

/**
 * Load the graph preferring the SQLite index when its corpusHash matches the
 * committed graph.json provenance (or when only the index exists). Falls back
 * to graph.json. Returns null if neither is usable.
 */
export function loadGraphPreferIndex(
  root: string,
  graphJsonPath: string,
): { graph: VgGraph; source: 'index' | 'json' } | null {
  // Snapshot-first: skips the large-string JSON.parse when a fresh binary
  // snapshot exists (sidecar or store-mode standalone), and self-heals the
  // sidecar when not (see engine/snapshot.ts).
  const jsonGraph: VgGraph | null = loadGraphFileWithSnapshot(graphJsonPath);

  const fromIndex = loadGraphFromIndex(root);
  if (fromIndex) {
    if (!jsonGraph || fromIndex.provenance.corpusHash === jsonGraph.provenance.corpusHash) {
      return { graph: fromIndex, source: 'index' };
    }
    // Index stale vs graph.json — prefer canonical JSON and let next build refresh.
  }
  if (jsonGraph) return { graph: jsonGraph, source: 'json' };
  return null;
}
