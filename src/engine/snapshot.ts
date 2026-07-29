import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { Packr } from 'msgpackr';
import { parseGraph } from './serialize.js';
import { VERSION } from '../version.js';
import type { VgGraph } from '../schema.js';

/**
 * Binary graph snapshot — a derived, local **cache** beside `graph.json`.
 *
 * `graph.json` stays the canonical, committed, human-diffable artifact and the
 * only interchange format (`vg export` / `share` / `bundle` are unchanged); the
 * determinism contract attaches to it, not to this file. The snapshot exists
 * purely so hot paths (`vg ask`/`serve`/`code`, vgd session attach) skip the
 * large-string `JSON.parse` on load and the pretty-print on write — measured
 * ~2.6× faster cold load and ~4× faster encode on XL maps, at ~40% of the size.
 *
 * Robustness rules (each one keeps JSON as the unquestioned fallback):
 *   - The loader trusts a snapshot only when its recorded (size, mtimeMs) of
 *     the source `graph.json` still match — any rebuild or hand-edit of the
 *     JSON silently invalidates it. Staleness never needs to parse the JSON.
 *   - A CRC-32 over the payload rejects torn/corrupted files; any decode error
 *     (unknown magic, short file, bad msgpack, version skew) returns null
 *     rather than throwing, and the caller re-reads JSON and rewrites the
 *     snapshot ("self-healing" — first load after upgrade migrates for free).
 *   - Writes are atomic (temp + rename) and best-effort: a full disk or
 *     read-only store must never fail a build or a query.
 *   - The engine VERSION is recorded and must match: the msgpack record layout
 *     tracks the in-memory graph shape, which may change between releases.
 *
 * Format: MAGIC ("VGSNAP1\0") · u32LE header length · msgpack header
 * {engine, sourceSize, sourceMtimeMs, crc32} · msgpack graph payload.
 * Everything is explicit little-endian via DataView/Buffer — no platform
 * variance. msgpackr runs its pure-JS path (its native accelerator is an
 * optional dependency we do not rely on); a fresh Packr per encode/decode
 * keeps record-id assignment deterministic for identical input.
 */

const MAGIC = Buffer.from('VGSNAP1\0', 'latin1');

/** node:zlib gained crc32 in 22.2; fall back to a table crc for 22.0/22.1. */
const crc32: (data: Uint8Array) => number = zlib.crc32 ?? jsCrc32;

let crcTable: Uint32Array | null = null;

function jsCrc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface SnapshotHeader {
  engine: string;
  crc32: number;
  /**
   * True when the snapshot IS the map (global-store mode, no graph.json
   * beside it). False/absent = sidecar of a canonical graph.json, valid only
   * while that JSON's recorded stat still matches.
   */
  standalone?: boolean;
  sourceSize?: number;
  sourceMtimeMs?: number;
}

/** Sidecar path for a map file: `…/graph.json` → `…/graph.snap`. */
export function snapshotPathFor(graphPath: string): string {
  return graphPath.endsWith('.json') ? `${graphPath.slice(0, -5)}.snap` : `${graphPath}.snap`;
}

function newPackr(): Packr {
  return new Packr({ useRecords: true });
}

/** Msgpack payload bytes for a graph (exported for the determinism test). */
export function encodeGraphPayload(graph: VgGraph): Buffer {
  return Buffer.from(newPackr().pack(graph));
}

/**
 * Write the snapshot beside `graphPath`.
 *
 * Sidecar mode (default): call after `graph.json` is on disk — the header
 * records its stat so readers can cheaply detect staleness.
 * `standalone: true` (global-store mode): the snapshot IS the map; no
 * `graph.json` is required or consulted.
 * Best-effort: returns false (never throws) when the file can't be written.
 */
export function writeGraphSnapshot(
  graphPath: string,
  graph: VgGraph,
  opts: { standalone?: boolean } = {},
): boolean {
  try {
    const payload = encodeGraphPayload(graph);
    let header: Buffer;
    if (opts.standalone) {
      header = newPackr().pack({
        engine: VERSION,
        crc32: crc32(payload),
        standalone: true,
      } satisfies SnapshotHeader);
    } else {
      const stat = fs.statSync(graphPath);
      header = newPackr().pack({
        engine: VERSION,
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
        crc32: crc32(payload),
      } satisfies SnapshotHeader);
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(header.length, 0);
    const file = snapshotPathFor(graphPath);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, Buffer.concat([MAGIC, lenBuf, header, payload]));
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the snapshot for `graphPath`, or null when it is absent, stale,
 * or corrupted.
 *
 * Sidecar snapshots additionally require their source `graph.json` to exist
 * with an unchanged stat AND an identical engine version — the JSON fallback
 * is free, so any doubt invalidates. Standalone snapshots are the map itself:
 * they are accepted on magic + CRC + a structural sanity check, including
 * across engine versions (msgpack embeds its record layout, so an older
 * snapshot decodes the same way an older committed graph.json would parse).
 */
export function readGraphSnapshot(graphPath: string): VgGraph | null {
  try {
    const file = snapshotPathFor(graphPath);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const headerLen = raw.readUInt32LE(MAGIC.length);
    const payloadStart = MAGIC.length + 4 + headerLen;
    if (payloadStart > raw.length) return null;
    const header = newPackr().unpack(raw.subarray(MAGIC.length + 4, payloadStart)) as SnapshotHeader;
    if (!header.standalone) {
      if (header.engine !== VERSION) return null;
      const sourceStat = fs.statSync(graphPath); // no source JSON → nothing to be a cache of
      if (header.sourceSize !== sourceStat.size || header.sourceMtimeMs !== sourceStat.mtimeMs) return null;
    }
    const payload = raw.subarray(payloadStart);
    if (crc32(payload) !== header.crc32) return null;
    const graph = newPackr().unpack(payload) as VgGraph;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
    return graph;
  } catch {
    return null;
  }
}

/**
 * Does a map exist at `graphPath` in either representation — the canonical
 * `graph.json`, or a standalone binary snapshot (global-store mode)?
 * Cheap: reads only the snapshot header, never the payload or the JSON.
 */
export function mapFileExists(graphPath: string): boolean {
  if (fs.existsSync(graphPath)) return true;
  return readSnapshotHeader(snapshotPathFor(graphPath))?.standalone === true;
}

/**
 * Stat for "did the map change on disk" mtime tracking: the JSON when
 * present, else the standalone snapshot file. Throws when neither exists —
 * same contract callers had with `fs.statSync(graphPath)`.
 */
export function mapFileStat(graphPath: string): fs.Stats {
  try {
    return fs.statSync(graphPath);
  } catch (err) {
    const snap = snapshotPathFor(graphPath);
    if (fs.existsSync(snap)) return fs.statSync(snap);
    throw err;
  }
}

/** Parse just the envelope header of a snapshot file (null on any problem). */
function readSnapshotHeader(file: string): SnapshotHeader | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const prefix = Buffer.alloc(4096);
    const read = fs.readSync(fd, prefix, 0, prefix.length, 0);
    if (read < MAGIC.length + 4 || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const headerLen = prefix.readUInt32LE(MAGIC.length);
    if (MAGIC.length + 4 + headerLen > read) return null;
    return newPackr().unpack(prefix.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLen)) as SnapshotHeader;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Load a map file, preferring the binary snapshot and self-healing it.
 * Fast path: valid snapshot (sidecar or standalone) → decode it. Fallback:
 * parse `graph.json`, then (best-effort) rewrite the sidecar so the next load
 * takes the fast path. Returns null only when neither representation yields a
 * graph — exactly the cases the pre-snapshot code treated as "no graph".
 */
export function loadGraphFileWithSnapshot(graphPath: string): VgGraph | null {
  const snap = readGraphSnapshot(graphPath);
  if (snap) return snap;
  let json: string;
  try {
    json = fs.readFileSync(graphPath, 'utf8');
  } catch {
    return null;
  }
  let graph: VgGraph;
  try {
    graph = parseGraph(json);
  } catch {
    return null;
  }
  writeGraphSnapshot(graphPath, graph);
  return graph;
}
