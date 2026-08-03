/**
 * Graph enrichment via the optional relevance provider: per-node TOPIC TAGS,
 * stored as a binary sidecar BOUND TO ONE EXACT GRAPH.
 *
 * When the installed provider exposes `tagNode`, every graph node gets a
 * deterministic topic tag set derived from path/identifier evidence
 * ("src/payments/DirectDebitMandate.ts" → ["payments"]). Query-time ranking
 * then adds a bounded affinity bonus when the question's inferred topics
 * intersect a node's tags.
 *
 * Storage contract (the part that keeps everything in step):
 *
 *  - Tags NEVER enter `graph.json` — byte-identical output for identical
 *    input is a hard invariant of `vg build`.
 *  - The sidecar lives BESIDE the resolved graph artifact
 *    (`<id>.graph.tags.snap` next to `<id>.graph.json` / `.graph.snap`).
 *    Graphs are branch-keyed in the global repository store (Fusion §4.1.1),
 *    so switching branches resolves a different graph file — and therefore a
 *    different sidecar — with zero extra bookkeeping. Legacy in-repo maps get
 *    `.vibgrate/graph.tags.snap` (gitignored alongside `graph.snap`).
 *  - The binding is CONTENT identity, not path or time: the header records
 *    the graph's `provenance.corpusHash` (blake3 over the included file set)
 *    and is trusted only when it matches the LOADED graph. A rebuild, a
 *    branch switch served through the same path, or a hand-swapped file all
 *    invalidate it exactly; anything published downstream (vgd scans) that
 *    carries the graph's corpusHash can verify the tags belong to it.
 *  - The provider version and engine VERSION are recorded and must match — a
 *    kernel/pack or CLI upgrade recomputes cleanly.
 *  - Any mismatch, torn file (CRC), decode error, or provider fault degrades
 *    to recompute-or-null; a sidecar problem must never break ranking.
 *  - Writes are atomic (temp + rename) and best-effort; the graph write path
 *    (engine/artifacts.ts) deletes the sidecar whenever the graph at that
 *    path is rewritten or removed, so an orphaned sidecar cannot outlive its
 *    graph.
 *
 * Format (mirrors engine/snapshot.ts conventions): MAGIC ("VGTAGS1\0") ·
 * u32LE header length · msgpack header {engine, provider, corpusHash, crc32}
 * · msgpack payload (node id → tags, sorted by id). Explicit little-endian,
 * pure-JS msgpackr, fresh Packr per encode/decode — no platform variance.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Packr } from 'msgpackr';
import { loadRelevanceProvider } from './relevance-provider.js';
import { resolveGraphPath } from './artifacts.js';
import { VERSION } from '../version.js';
import type { VgGraph } from '../schema.js';

const MAGIC = Buffer.from('VGTAGS1\0', 'latin1');

/** node:zlib gained crc32 in 22.2; engines pins Node >= 22 so it's present,
 *  but guard anyway (same posture as engine/snapshot.ts). */
const crc32: (data: Uint8Array) => number = zlib.crc32 ?? (() => 0);

interface TagsHeader {
  engine: string;
  provider: string;
  corpusHash: string;
  crc32: number;
}

function newPackr(): Packr {
  return new Packr({ useRecords: true });
}

/** Sidecar path for a resolved graph artifact path. */
export function tagsSidecarPathFor(graphPath: string): string {
  return graphPath.endsWith('.json') ? `${graphPath.slice(0, -5)}.tags.snap` : `${graphPath}.tags.snap`;
}

/** Remove the tags sidecar for a graph path (graph rewrite/removal hook). */
export function deleteTagsSidecarFor(graphPath: string): void {
  try {
    fs.rmSync(tagsSidecarPathFor(graphPath), { force: true });
  } catch {
    /* best-effort — a locked file self-invalidates via corpusHash anyway */
  }
}

function readSidecar(file: string, expect: { provider: string; corpusHash: string }): Record<string, string[]> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const headerLen = raw.readUInt32LE(MAGIC.length);
    const headerStart = MAGIC.length + 4;
    if (raw.length < headerStart + headerLen) return null;
    const header = newPackr().unpack(raw.subarray(headerStart, headerStart + headerLen)) as TagsHeader;
    if (header.engine !== VERSION) return null;
    if (header.provider !== expect.provider) return null;
    if (header.corpusHash !== expect.corpusHash) return null;
    const payload = raw.subarray(headerStart + headerLen);
    if ((crc32(payload) >>> 0) !== (header.crc32 >>> 0)) return null;
    const tags = newPackr().unpack(payload) as Record<string, string[]>;
    return tags && typeof tags === 'object' ? tags : null;
  } catch {
    return null;
  }
}

function writeSidecar(file: string, meta: { provider: string; corpusHash: string }, tags: Record<string, string[]>): void {
  try {
    // Deterministic payload: sorted node ids.
    const sorted = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1)));
    const payload = newPackr().pack(sorted);
    const header = newPackr().pack({
      engine: VERSION,
      provider: meta.provider,
      corpusHash: meta.corpusHash,
      crc32: crc32(payload) >>> 0,
    } satisfies TagsHeader);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(header.length);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([MAGIC, lenBuf, Buffer.from(header), Buffer.from(payload)]));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort: a full disk or read-only store never fails a query.
  }
}

/**
 * Topic tags for every scorable node of THIS graph, computed through the
 * provider and cached in the graph's own sidecar. Returns `null` when no
 * provider (or none with `tagNode`) is active — callers treat that as "no
 * enrichment" and proceed unchanged.
 *
 * `graphPath` should be the path the graph was actually loaded from (the MCP
 * server and `vg ask` pass it); when omitted it is re-resolved from the root
 * with the same branch-keyed rules `loadGraph` uses, so the sidecar always
 * sits beside the graph the current workspace state resolves to.
 */
export async function loadTopicTags(
  graph: VgGraph,
  root: string,
  graphPath?: string,
): Promise<Map<string, readonly string[]> | null> {
  const provider = await loadRelevanceProvider();
  if (!provider?.tagNode) return null;
  let providerVersion: string;
  try {
    providerVersion = provider.version();
  } catch {
    return null;
  }
  const corpusHash = graph.provenance?.corpusHash;
  if (!corpusHash) return null; // no content identity → no cacheable binding

  const file = tagsSidecarPathFor(graphPath?.trim() ? path.resolve(graphPath) : resolveGraphPath(root));
  const cached = readSidecar(file, { provider: providerVersion, corpusHash });
  if (cached) {
    const tags = new Map<string, readonly string[]>();
    for (const [id, t] of Object.entries(cached)) if (t.length) tags.set(id, t);
    return tags;
  }

  const record: Record<string, string[]> = {};
  const tags = new Map<string, readonly string[]>();
  try {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const computed = provider.tagNode({ qualifiedName: node.qualifiedName, file: node.file }) ?? [];
      // Sanitize at the trust boundary: strings only, lowercased, capped.
      const clean = computed
        .filter((t) => typeof t === 'string' && t.length > 0)
        .map((t) => t.toLowerCase())
        .slice(0, 3);
      record[node.id] = clean;
      if (clean.length) tags.set(node.id, clean);
    }
  } catch {
    return null; // a faulting provider must never break ranking
  }
  writeSidecar(file, { provider: providerVersion, corpusHash }, record);
  return tags;
}
