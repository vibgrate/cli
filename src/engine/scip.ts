/**
 * SCIP ingestion — the precise resolution rung (VG-ENGINE-TEARDOWN §3.2).
 *
 * Reads a real SCIP index (`index.scip`) produced by a language indexer
 * (scip-typescript, scip-python, scip-java, rust-analyzer→SCIP, …) and turns its
 * precise occurrences into call/reference edges at `resolution: "scip"`,
 * confidence 1.0 — the genuine "real SCIP vs Graphify's fake-SCIP" win. vg does
 * NOT bundle indexers; it consumes an index the user/CI generates (deterministic,
 * offline). The heuristic resolver remains the floor for files SCIP didn't cover.
 *
 * A small, dependency-free protobuf reader decodes only the fields we need, so
 * the core stays lean.
 */

import type { EdgeKind, GraphEdge, GraphNode, ResolverKind } from '../schema.js';
import { edgeId } from './ids.js';

// SCIP SymbolRole bitmask (scip.proto).
const ROLE_DEFINITION = 0x1;

export interface ScipOccurrence {
  /** [startLine, startChar, endLine, endChar] or [startLine, startChar, endChar], 0-based. */
  range: number[];
  symbol: string;
  roles: number;
}
export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
}
export interface ScipIndex {
  documents: ScipDocument[];
  toolName?: string;
  toolVersion?: string;
}

// --- minimal protobuf wire reader ---

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift; // avoid <<shift overflow past 31 bits
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: t >>> 3, wire: t & 0x7 };
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
  }
}

const td = new TextDecoder();

export function decodeScipIndex(buf: Uint8Array): ScipIndex {
  const index: ScipIndex = { documents: [] };
  const r = new Reader(buf);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) decodeMetadata(r.bytes(), index); // Index.metadata
    else if (field === 2 && wire === 2) index.documents.push(decodeDocument(r.bytes()));
    else r.skip(wire);
  }
  return index;
}

function decodeMetadata(buf: Uint8Array, index: ScipIndex): void {
  const r = new Reader(buf);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 2 && wire === 2) decodeToolInfo(r.bytes(), index); // Metadata.tool_info
    else r.skip(wire);
  }
}

function decodeToolInfo(buf: Uint8Array, index: ScipIndex): void {
  const r = new Reader(buf);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) index.toolName = td.decode(r.bytes());
    else if (field === 2 && wire === 2) index.toolVersion = td.decode(r.bytes());
    else r.skip(wire);
  }
}

function decodeDocument(buf: Uint8Array): ScipDocument {
  const doc: ScipDocument = { relativePath: '', occurrences: [] };
  const r = new Reader(buf);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) doc.relativePath = td.decode(r.bytes()); // relative_path
    else if (field === 2 && wire === 2) doc.occurrences.push(decodeOccurrence(r.bytes()));
    else r.skip(wire);
  }
  return doc;
}

function decodeOccurrence(buf: Uint8Array): ScipOccurrence {
  const occ: ScipOccurrence = { range: [], symbol: '', roles: 0 };
  const r = new Reader(buf);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1) {
      if (wire === 2) {
        // packed repeated int32
        const sub = new Reader(r.bytes());
        while (!sub.done) occ.range.push(sub.varint());
      } else if (wire === 0) {
        occ.range.push(r.varint());
      } else r.skip(wire);
    } else if (field === 2 && wire === 2) occ.symbol = td.decode(r.bytes());
    else if (field === 3 && wire === 0) occ.roles = r.varint();
    else r.skip(wire);
  }
  return occ;
}

// --- mapping occurrences → edges ---

export interface ScipResult {
  edges: GraphEdge[];
  /** Repo-relative files SCIP covered (it is authoritative for these). */
  coveredFiles: Set<string>;
  /** counts for status/provenance. */
  stats: { documents: number; references: number; resolved: number };
}

/**
 * Build precise edges from a SCIP index, mapped onto our nodes by (file, line).
 * A reference occurrence's enclosing node → the node where its symbol is defined.
 */
export function scipEdges(index: ScipIndex, nodes: GraphNode[], relForScip: (p: string) => string): ScipResult {
  // nodes per repo-relative file, with quick line lookup.
  const nodesByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const list = nodesByFile.get(n.file);
    if (list) list.push(n);
    else nodesByFile.set(n.file, [n]);
  }

  // First pass: symbol → defining node (from Definition occurrences).
  const symbolToNode = new Map<string, GraphNode>();
  const coveredFiles = new Set<string>();
  for (const doc of index.documents) {
    const file = relForScip(doc.relativePath);
    const fileNodes = nodesByFile.get(file);
    if (!fileNodes) continue;
    coveredFiles.add(file);
    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE_DEFINITION) === 0 || !occ.symbol || occ.symbol.startsWith('local ')) continue;
      const line = (occ.range[0] ?? 0) + 1; // SCIP is 0-based; our spans 1-based
      const node = nodeStartingAt(fileNodes, line) ?? enclosing(fileNodes, line);
      if (node) symbolToNode.set(occ.symbol, node);
    }
  }

  // Second pass: reference occurrences → edges.
  const edgeMap = new Map<string, GraphEdge>();
  let references = 0;
  let resolved = 0;
  for (const doc of index.documents) {
    const file = relForScip(doc.relativePath);
    const fileNodes = nodesByFile.get(file);
    if (!fileNodes) continue;
    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE_DEFINITION) !== 0 || !occ.symbol || occ.symbol.startsWith('local ')) continue;
      references++;
      const target = symbolToNode.get(occ.symbol);
      if (!target) continue; // symbol defined outside the repo (external) — skip
      const line = (occ.range[0] ?? 0) + 1;
      const src = enclosing(fileNodes, line);
      if (!src || src.id === target.id) continue;
      const kind: EdgeKind = target.kind === 'function' || target.kind === 'method' ? 'call' : 'references';
      add(edgeMap, kind, src.id, target.id);
      resolved++;
    }
  }

  return {
    edges: [...edgeMap.values()],
    coveredFiles,
    stats: { documents: index.documents.length, references, resolved },
  };
}

function add(map: Map<string, GraphEdge>, kind: EdgeKind, src: string, dst: string): void {
  const id = edgeId(kind, src, dst);
  const existing = map.get(id);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    return;
  }
  const resolution: ResolverKind = 'scip';
  map.set(id, { id, kind, src, dst, resolution, confidence: 1.0, count: 1 });
}

/** Smallest node whose span contains `line`. */
function enclosing(nodes: GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.span.start <= line && n.span.end >= line) {
      if (!best || n.span.end - n.span.start < best.span.end - best.span.start) best = n;
    }
  }
  return best;
}

/** A node whose span starts exactly at `line` (the defined symbol). */
function nodeStartingAt(nodes: GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.span.start === line) {
      if (!best || n.span.end - n.span.start < best.span.end - best.span.start) best = n;
    }
  }
  return best;
}
