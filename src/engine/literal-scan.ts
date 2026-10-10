import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * The uniform literal-search core for `search_symbols` (VG-LITERAL-INDEX-DESIGN.md
 * Stage 1). Reads a set of candidate files and returns every matching line,
 * case-insensitive, deterministically ordered by (file, line).
 *
 * Performance is delivered WITHOUT any external binary or persisted index, so it
 * is identical on Linux, macOS and Windows and needs nothing installed:
 *   - small file sets scan inline (worker startup would cost more than it saves);
 *   - large sets fan out across `worker_threads` — a proven, Node-native way to
 *     use every core. ripgrep, when present, prunes the candidate set upstream so
 *     this scans only a handful of files; when it's absent this is the whole
 *     engine, and the parallel path keeps it fast on big repos.
 *
 * The per-file matcher is one tiny function shared by the inline path and the
 * worker (as a source string) so the two can't drift; a parity test asserts they
 * agree. It leans on V8's native `toLowerCase`/`includes` rather than a
 * hand-rolled byte scan — simpler, and faster than interpreted JS byte loops.
 */

const MAX_FILE_BYTES = 1_000_000;
const PREVIEW_CHARS = 120;
const NUL = '\u0000'; // a NUL byte marks a binary file — skipped, same as ripgrep does
/**
 * Fan out to workers only above this many candidate BYTES. Benchmarking showed
 * that gating on file *count* is wrong: a few thousand small files (≈8 MB) scan
 * ~2× faster inline than across workers, because worker startup + result IPC
 * dwarfs the actual matching. Parallelism only pays once there is real byte
 * volume to amortise it (big monorepos, generated trees). Below the threshold
 * the improved single-thread scan — one lowercase per file, no per-line
 * re-lowercase — is the fastest and has zero worker overhead.
 */
const PARALLEL_MIN_BYTES = 64_000_000;
/**
 * Don't even measure bytes below this file count: a repo with few files can't
 * hold enough work to beat worker startup, and skipping the stat pass keeps
 * typical small repos overhead-free. Above it, `measure` decides by bytes.
 */
const PARALLEL_MIN_FILES = 2000;
/** Hard cap on collected rows so a pathologically common phrase can't blow memory;
 *  the true match count is still tallied exactly and `truncated` is set. */
const ROW_CAP = 10_000;

export interface LiteralHit {
  file: string;
  line: number;
  preview: string;
}

export interface ScanOutcome {
  /** Matching lines, deterministically ordered by (file, line), capped at ROW_CAP. */
  hits: LiteralHit[];
  /** Exact count of all matching lines (counts past ROW_CAP / past `budget`). */
  total: number;
  /** True when rows were capped (ROW_CAP or, in bounded mode, `budget`). */
  truncated: boolean;
}

export interface ScanOptions {
  /** Collect and count every match (a "find every occurrence" sweep). When false,
   *  stop once `budget` rows are collected (a cheap bounded fallthrough). */
  collectAll: boolean;
  /** Row budget for the bounded (`collectAll: false`) mode. */
  budget: number;
}

/**
 * Scan `files` (repo-relative paths under `root`) for `needle`, case-insensitive.
 * Chooses inline vs. parallel by set size; both produce identical output.
 */
export async function scanCandidates(root: string, files: string[], needle: string, opts: ScanOptions): Promise<ScanOutcome> {
  const needleLower = needle.toLowerCase();
  if (!needleLower || files.length === 0) return { hits: [], total: 0, truncated: false };
  // Few files can't out-earn worker startup — inline directly, no stat pass.
  // (Bounded mode additionally early-stops the moment the budget fills.)
  if (files.length < PARALLEL_MIN_FILES && !process.env.VG_PARALLEL_MIN_BYTES) {
    return opts.collectAll
      ? scanInline(root, files, needleLower, ROW_CAP, false, undefined)
      : scanInline(root, files, needleLower, opts.budget, true, undefined);
  }
  // Many files: measure the candidate bytes once, then let workers in only when
  // there's enough volume to amortise them. This now includes the BOUNDED path
  // (a single-name fallthrough): its early-stop only ever helps when the needle
  // is common enough to fill the budget — the expensive case is precisely a RARE
  // needle, where the scan must sweep everything anyway and used to do so
  // single-threaded (the 16s-per-call trace). Sizes from the measure pass are
  // reused by the inline scan (no double-stat).
  const { over, sizes } = measure(root, files);
  if (!over) {
    return opts.collectAll
      ? scanInline(root, files, needleLower, ROW_CAP, false, sizes)
      : scanInline(root, files, needleLower, opts.budget, true, sizes);
  }
  const out = await scanParallel(root, files, needleLower);
  if (!opts.collectAll && out.hits.length > opts.budget) {
    out.hits.length = opts.budget;
    out.truncated = true;
  }
  return out;
}

/** The byte threshold, overridable via VG_PARALLEL_MIN_BYTES (ops knob + tests). */
function parallelMinBytes(): number {
  const v = Number(process.env.VG_PARALLEL_MIN_BYTES);
  return Number.isFinite(v) && v >= 0 ? v : PARALLEL_MIN_BYTES;
}

/** Sum candidate bytes, short-circuiting once the worker threshold is crossed. */
function measure(root: string, files: string[]): { over: boolean; sizes: Map<string, number> } {
  const threshold = parallelMinBytes();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const rel of files) {
    let size: number;
    try {
      size = fs.statSync(path.join(root, rel)).size;
    } catch {
      continue;
    }
    sizes.set(rel, size);
    if (size <= MAX_FILE_BYTES) total += size;
    if (total >= threshold) return { over: true, sizes };
  }
  return { over: false, sizes };
}

/** The one true per-file matcher. Kept trivial so the worker copy stays in sync. */
function matchLines(text: string, needleLower: string): Array<{ line: number; preview: string }> {
  const low = text.toLowerCase();
  if (!low.includes(needleLower)) return [];
  const lowLines = low.split('\n');
  const rawLines = text.split('\n');
  const hits: Array<{ line: number; preview: string }> = [];
  for (let i = 0; i < lowLines.length; i++) {
    if (lowLines[i].includes(needleLower)) hits.push({ line: i + 1, preview: rawLines[i].trim().slice(0, PREVIEW_CHARS) });
  }
  return hits;
}

/**
 * Read one candidate file, applying the size/binary guards. `null` = skip.
 * `knownSize` (from the measure pass) lets us skip a redundant `statSync`.
 */
function readCandidate(abs: string, knownSize?: number): string | null {
  try {
    const size = knownSize ?? fs.statSync(abs).size;
    if (size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(abs, 'utf8');
    return text.includes(NUL) ? null : text;
  } catch {
    return null;
  }
}

function scanInline(root: string, files: string[], needleLower: string, cap: number, stopAtCap: boolean, sizes: Map<string, number> | undefined): ScanOutcome {
  const hits: LiteralHit[] = [];
  let total = 0;
  let truncated = false;
  for (const rel of files) {
    const text = readCandidate(path.join(root, rel), sizes?.get(rel));
    if (text === null) continue;
    for (const h of matchLines(text, needleLower)) {
      total++;
      if (hits.length < cap) hits.push({ file: rel, line: h.line, preview: h.preview });
      else {
        truncated = true;
        if (stopAtCap) return { hits, total, truncated };
      }
    }
  }
  return { hits, total, truncated };
}

/**
 * Fan the candidate files across `worker_threads`. Each worker runs the same
 * matcher over its shard and returns rows + an exact count; the main thread
 * merges, sorts and caps. The worker source is a self-contained CommonJS string
 * (eval worker) so it survives bundling with no separate worker-file path to
 * resolve at runtime. Any worker failure falls back to a correct inline scan —
 * speed is negotiable, completeness is not.
 */
async function scanParallel(root: string, files: string[], needleLower: string): Promise<ScanOutcome> {
  const n = Math.min(files.length, Math.max(2, Math.min(8, os.cpus().length - 1)));
  const shards: string[][] = Array.from({ length: n }, () => []);
  files.forEach((f, i) => shards[i % n].push(f));

  let results: ScanOutcome[];
  try {
    results = await Promise.all(shards.map((shard) => runWorker(root, shard, needleLower)));
  } catch {
    return scanInline(root, files, needleLower, ROW_CAP, false, undefined);
  }

  const hits: LiteralHit[] = [];
  let total = 0;
  let truncated = false;
  for (const r of results) {
    total += r.total;
    truncated = truncated || r.truncated;
    for (const h of r.hits) hits.push(h);
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  if (hits.length > ROW_CAP) {
    hits.length = ROW_CAP;
    truncated = true;
  }
  return { hits, total, truncated };
}

const WORKER_SOURCE = [
  "const { parentPort, workerData } = require('worker_threads');",
  "const fs = require('fs');",
  "const path = require('path');",
  `const MAX = ${MAX_FILE_BYTES};`,
  `const PREVIEW = ${PREVIEW_CHARS};`,
  `const CAP = ${ROW_CAP};`,
  'const NUL = String.fromCharCode(0);',
  'const NL = String.fromCharCode(10);',
  'const { root, files, needleLower } = workerData;',
  'const hits = []; let total = 0, truncated = false;',
  'for (const rel of files) {',
  '  const abs = path.join(root, rel);',
  '  let text;',
  '  try { if (fs.statSync(abs).size > MAX) continue; text = fs.readFileSync(abs, "utf8"); } catch { continue; }',
  '  if (text.includes(NUL)) continue;',
  '  const low = text.toLowerCase();',
  '  if (!low.includes(needleLower)) continue;',
  '  const lowLines = low.split(NL); const rawLines = text.split(NL);',
  '  for (let i = 0; i < lowLines.length; i++) {',
  '    if (!lowLines[i].includes(needleLower)) continue;',
  '    total++;',
  '    if (hits.length < CAP) hits.push({ file: rel, line: i + 1, preview: rawLines[i].trim().slice(0, PREVIEW) });',
  '    else truncated = true;',
  '  }',
  '}',
  'parentPort.postMessage({ hits, total, truncated });',
].join('\n');

/** One shard on one worker; rejects on any worker error so the caller can fall back. */
function runWorker(root: string, files: string[], needleLower: string): Promise<ScanOutcome> {
  return new Promise<ScanOutcome>((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { root, files, needleLower } });
    let settled = false;
    w.once('message', (m: ScanOutcome) => {
      settled = true;
      resolve(m);
    });
    w.once('error', reject);
    w.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`literal-scan worker exited with code ${code}`));
    });
  });
}
