import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from './parse.js';
import { setGrammarsOverride, resetParser } from './grammars.js';
import { checkMemoryBudget, envJobs, envWorkerHeapMb, ResourceLimitError } from './limits.js';
import type { DiscoveredFile } from './discover.js';
import type { FileParse } from './types.js';
import { stampWarning, WARNING_CODES } from '../core-open/warnings.js';
import type { ParseTask } from './parse-worker.js';
import { parsePoolGuard, type ManagedPool } from './pool-guard.js';

/**
 * Parse a set of discovered files into FileParse tables.
 *
 * Parsing is CPU-bound and per-file independent, so it parallelises across a
 * worker_threads pool (tinypool) and scales near-linearly with cores — the
 * direct mechanism behind the "≥5× build" mandate (VG-ENGINE-TEARDOWN §3.10).
 *
 * The result is identical regardless of how work was sharded: every output is
 * sorted by relative path, so the build never depends on scheduling order. A
 * single-threaded inline path is always available (and used for small repos or
 * when the worker module isn't resolvable, e.g. under ts-only test runners),
 * producing byte-identical output to the pooled path.
 */

export interface ParseOptions {
  /** Worker count. Default: min(cores - 1, file count). 1 forces inline. */
  jobs?: number;
  /** Force the single-threaded path (tests, debugging). */
  inline?: boolean;
  /** Below this many files, run inline (worker spin-up isn't worth it). */
  inlineThreshold?: number;
  /** Live progress: called as files finish parsing (done of total). */
  onProgress?: (done: number, total: number) => void;
  /** `--grammars <dir>` override for the grammar .wasm files (offline/air-gapped). */
  grammarsDir?: string;
  /** Heap budget (MiB) checked as parse results accumulate; 0/unset skips. */
  memoryBudgetMb?: number;
  /** Worker module path. Set by tests; production resolves the bundled worker. */
  workerFile?: string;
}

const DEFAULT_INLINE_THRESHOLD = 24;

export async function parseFiles(
  files: DiscoveredFile[],
  options: ParseOptions = {},
): Promise<FileParse[]> {
  const threshold = options.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
  const cores = Math.max(1, os.cpus()?.length ?? 1);
  // Precedence: explicit option (--jobs) → VG_JOBS env → cores - 1. Capping
  // workers caps peak memory too (each worker holds its own grammar set).
  const jobs = Math.max(1, options.jobs ?? envJobs() ?? (Math.min(cores - 1, files.length) || 1));

  const workerFile = resolveWorkerFile(options.workerFile);
  const useInline =
    options.inline === true ||
    jobs <= 1 ||
    files.length < threshold ||
    workerFile === null;

  if (useInline) {
    // Inline runs in this process — apply the override directly.
    if (options.grammarsDir) setGrammarsOverride(options.grammarsDir);
    return sortByRel(await parseInline(files, options));
  }
  return sortByRel(await parsePooled(files, jobs, workerFile, options));
}

/** Check the accumulating heap every this-many completed files — frequent
 * enough to abort before a crash, cheap enough to be free. */
const MEM_CHECK_EVERY = 64;

async function parseInline(files: DiscoveredFile[], options: ParseOptions): Promise<FileParse[]> {
  const { onProgress, memoryBudgetMb = 0 } = options;
  const out: FileParse[] = [];
  onProgress?.(0, files.length);
  for (const file of files) {
    try {
      const source = fs.readFileSync(file.abs, 'utf8');
      out.push(await parseSource(file.rel, file.lang.id, source));
    } catch (err) {
      // A wasm-level parse crash can leave the language's reused parser
      // mid-state; drop it so the failure stays contained to this file.
      resetParser(file.lang.id);
      out.push(emptyParse(file, stampWarning(WARNING_CODES.PARSE_FAILED, `parse failed: ${(err as Error).message}`)));
    }
    onProgress?.(out.length, files.length);
    if (out.length % MEM_CHECK_EVERY === 0) checkMemoryBudget('parse', memoryBudgetMb);
  }
  return out;
}

async function parsePooled(
  files: DiscoveredFile[],
  jobs: number,
  workerFile: string,
  options: ParseOptions,
): Promise<FileParse[]> {
  const { onProgress, grammarsDir, memoryBudgetMb = 0 } = options;
  // Dynamic import so tinypool isn't loaded for inline-only runs.
  const { default: Tinypool } = await import('tinypool');
  // VG_WORKER_HEAP_MB caps each worker's old-generation heap so one runaway
  // parse cannot swallow the whole machine; unset = platform default.
  const workerHeapMb = envWorkerHeapMb();
  const pool = new Tinypool({
    filename: workerFile,
    maxThreads: jobs,
    minThreads: 1,
    // Bound a stuck worker.terminate() so destroy cannot hang forever.
    terminateTimeout: 1_000,
    ...(workerHeapMb ? { resourceLimits: { maxOldGenerationSizeMb: workerHeapMb } } : {}),
  });
  // A worker that dies with no in-flight task emits 'error'. Without a
  // listener that becomes an uncaught exception and skips pool teardown.
  pool.on('error', () => undefined);
  return parsePoolGuard.using(pool as unknown as ManagedPool, async () => {
    try {
      // More, smaller buckets than threads → finer live progress + better load
      // balancing. Round-robin keeps shards balanced; the final sort makes the
      // output independent of bucket count, so determinism is unaffected.
      const total = files.length;
      const buckets = chunk(
        files.map<ParseTask>((f) => ({ rel: f.rel, abs: f.abs, lang: f.lang.id })),
        Math.min(total, jobs * 8),
      );
      let done = 0;
      onProgress?.(0, total);
      const results = await Promise.all(
        buckets.map((b) =>
          (pool.run({ tasks: b, grammarsDir }) as Promise<FileParse[]>).then((r) => {
            done += b.length;
            onProgress?.(done, total);
            // Results accumulate in *this* process; guard its heap as they land.
            checkMemoryBudget('parse', memoryBudgetMb);
            return r;
          }),
        ),
      );
      return results.flat();
    } catch (err) {
      // A signal is already shutting the pool down and will exit. Parking
      // keeps this rejection from being reported as a second, unrelated error
      // or from letting the command finish successfully.
      if (parsePoolGuard.isExiting) await new Promise(() => undefined);
      throw toParseWorkerError(err, workerHeapMb);
    }
  });
}

/** A parse worker failed. The message says what happened and how to re-run. */
export class ParseWorkerError extends Error {
  readonly isParseWorkerError = true;
  constructor(message: string) {
    super(message);
    this.name = 'ParseWorkerError';
  }
}

/** Turn a worker failure into an error the CLI can print as-is. */
export function toParseWorkerError(err: unknown, workerHeapMb?: number): Error {
  if (err instanceof ResourceLimitError || err instanceof ParseWorkerError) return err;
  if (isWorkerOom(err)) {
    return new ResourceLimitError(
      `graph build stopped: a parse worker exceeded its ${workerHeapMb ?? '?'} MiB heap cap ` +
        `(VG_WORKER_HEAP_MB). Raise the cap, exclude the offending files (--exclude), or ` +
        `run single-threaded with --jobs 1.`,
    );
  }
  return new ParseWorkerError(
    `graph build stopped: a parse worker failed (${publicDetail(err)}). ` +
      `Re-run with --jobs 1 to parse in this process, or skip files with --exclude.`,
  );
}

/** One line, no absolute paths — caller-facing, not a stack trace. */
function publicDetail(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : 'the worker stopped unexpectedly';
  let line = raw.replace(/\s+/g, ' ').trim();
  line = line.replace(/file:\/\/\S+/g, 'a file');
  line = line.replace(/(?:[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+)|(?:\/(?:[\w.+@~-]+\/)+[\w.+@~-]+)/g, 'a file');
  if (!line) return 'the worker stopped unexpectedly';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

function isWorkerOom(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(e?.message ?? '');
}

function resolveWorkerFile(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  // Only the compiled .js worker is runnable by a bare worker_thread. Under a
  // TS-only runner (vitest/tsx) the .js won't exist → fall back to inline.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, 'parse-worker.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function chunk<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: Math.min(buckets, items.length || 1) }, () => []);
  if (out.length === 0) return [];
  // Round-robin keeps shard sizes balanced regardless of file ordering.
  items.forEach((item, i) => out[i % out.length].push(item));
  return out.filter((c) => c.length > 0);
}

function sortByRel(parses: FileParse[]): FileParse[] {
  return parses.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function emptyParse(file: DiscoveredFile, warning: string): FileParse {
  return {
    rel: file.rel,
    lang: file.lang.id,
    hash: '',
    bytes: 0,
    defs: [],
    calls: [],
    imports: [],
    heritage: [],
    typeRefs: [],
    guards: [],
    warnings: [warning],
  };
}
