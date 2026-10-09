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
 *
 * Workers are stopped on success, on failure, and on SIGINT/SIGTERM. A crashed
 * worker must not dump a stack or leave a Node process behind after `vg build`
 * or `vg scan` returns.
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
  /**
   * Parse-worker module. Tests pass a fixture; production resolves the bundled
   * `parse-worker.js` next to this file.
   */
  workerFile?: string;
  /**
   * `child_process` runs each worker as its own OS process so a crash can be
   * killed by pid. The default `worker_threads` pool is what `vg build` uses.
   */
  workerRuntime?: 'worker_threads' | 'child_process';
}

/** A parse worker died or was stopped. The message is the whole user-facing error. */
export class ParseWorkerFailure extends Error {
  readonly isParseWorkerFailure = true;
  constructor(message: string) {
    super(message);
    this.name = 'ParseWorkerFailure';
  }
}

/** How long `destroy()` may take before workers are killed outright. */
const POOL_SHUTDOWN_MS = 2_000;

interface KillableWorker {
  terminate?: () => Promise<unknown>;
  unref?: () => void;
  /** Set when the worker is a `child_process` (tinypool `ProcessWorker`). */
  process?: { kill: (signal?: NodeJS.Signals | number) => boolean };
}

interface ManagedPool {
  threads: KillableWorker[];
  destroy: () => Promise<void>;
  cancelPendingTasks: () => void;
  on: (event: 'error', listener: (err: unknown) => void) => void;
}

let activePool: ManagedPool | null = null;
let detachSignals: (() => void) | null = null;
let exitHookInstalled = false;

/** Workers still tracked by the live parse pool. Zero after shutdown. */
export function activeParseWorkerCount(): number {
  if (!activePool) return 0;
  try {
    return activePool.threads.length;
  } catch {
    return 0;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` is synchronous. Child workers are not reaped with the parent, so
  // kill them here — including when a signal handler calls `process.exit`.
  process.on('exit', () => {
    if (activePool) killWorkers(activePool);
  });
}

function killWorkers(pool: ManagedPool): void {
  let workers: KillableWorker[] = [];
  try {
    workers = pool.threads;
  } catch {
    return;
  }
  for (const worker of workers) killWorker(worker);
}

function killWorker(worker: KillableWorker): void {
  const child = worker.process;
  if (child && typeof child.kill === 'function') {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already reaped.
    }
    return;
  }
  try {
    worker.unref?.();
  } catch {
    // Already gone.
  }
  try {
    void worker.terminate?.();
  } catch {
    // Already gone.
  }
}

function onStopSignal(signal: NodeJS.Signals): void {
  const pool = activePool;
  if (!pool) return;
  killWorkers(pool);
  const code = signal === 'SIGINT' ? 130 : 143;
  const word = signal === 'SIGINT' ? 'interrupted' : 'terminated';
  const message = `vg: ${word} while parsing. Parse workers were stopped.\n`;
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  try {
    process.stderr.write(message, finish);
  } catch {
    finish();
    return;
  }
  // If stderr never drains, still exit so workers cannot outlive the command.
  setTimeout(finish, 50);
}

function armPool(pool: ManagedPool): void {
  activePool = pool;
  installExitHook();
  if (detachSignals) return;
  const onInt = (): void => onStopSignal('SIGINT');
  const onTerm = (): void => onStopSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  detachSignals = () => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  };
}

function disarmPool(): void {
  // Drop the signal listeners before clearing the pool so a signal delivered
  // in this window still finds the workers and exits, instead of being swallowed.
  if (detachSignals) {
    detachSignals();
    detachSignals = null;
  }
  activePool = null;
}

function isTinypoolShutdownBug(err: unknown): boolean {
  return err instanceof TypeError && err.message.includes('removeListener');
}

async function closePool(pool: ManagedPool): Promise<void> {
  // tinypool's `destroy()` waits on `events.once(worker, 'exit')`. If the
  // worker emits `error` first, that helper throws an uncaught
  // `removeListener` TypeError and the process dumps a stack. Swallow only
  // that bug; the `run()` rejection is the error the caller sees.
  const onUncaught = (err: Error): void => {
    if (isTinypoolShutdownBug(err)) {
      killWorkers(pool);
      return;
    }
    process.removeListener('uncaughtException', onUncaught);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', onUncaught);
  try {
    try {
      pool.cancelPendingTasks();
    } catch {
      // Queue already drained.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        killWorkers(pool);
        resolve();
      }, POOL_SHUTDOWN_MS);
    });
    try {
      await Promise.race([
        pool.destroy().then(
          () => undefined,
          () => {
            killWorkers(pool);
          },
        ),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    killWorkers(pool);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
}

/**
 * Flags that make a worker a second copy of the tool (tsx, a preload, an
 * inspector) rather than a parse process. Heap and V8 flags are kept so a
 * raised `--max-old-space-size` still applies inside the pool.
 */
function workerExecArgv(): string[] {
  const dropValue = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
  const argv = process.execArgv;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const inspect =
      arg === '--inspect' ||
      arg === '--inspect-brk' ||
      arg.startsWith('--inspect=') ||
      arg.startsWith('--inspect-brk') ||
      arg.startsWith('--inspect-port');
    if (inspect) continue;
    if (dropValue.has(arg)) {
      i += 1;
      continue;
    }
    if (
      arg.startsWith('--require=') ||
      arg.startsWith('--import=') ||
      arg.startsWith('--loader=') ||
      arg.startsWith('--experimental-loader=') ||
      arg.includes('tsx')
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function actionableParseError(err: unknown, workerHeapMb: number | undefined): Error {
  if (err instanceof ResourceLimitError || err instanceof ParseWorkerFailure) return err;
  if (isWorkerOom(err)) {
    return new ResourceLimitError(
      `graph build stopped: a parse worker exceeded its ${workerHeapMb ?? '?'} MiB heap cap ` +
        `(VG_WORKER_HEAP_MB). Raise the cap, exclude the offending files (--exclude), or ` +
        `run single-threaded with --jobs 1.`,
    );
  }
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split('\n')[0]?.trim() || 'unknown error';
  const brief = line.length > 200 ? `${line.slice(0, 197)}...` : line;
  const cap = workerHeapMb ? ` (currently ${workerHeapMb} MiB)` : '';
  return new ParseWorkerFailure(
    `graph build stopped: a parse worker failed (${brief}). ` +
      'Re-run with --jobs 1 to parse in this process, exclude the offending files with --exclude, ' +
      `or raise the per-worker heap with VG_WORKER_HEAP_MB${cap}.`,
  );
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

  const workerFile = options.workerFile ?? resolveWorkerFile();
  const useInline =
    options.inline === true ||
    jobs <= 1 ||
    workerFile === null ||
    // An explicit worker module (tests) always uses the pool. Production
    // stays inline below the threshold, where spinning workers up costs more
    // than it saves.
    (options.workerFile === undefined && files.length < threshold);

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
    runtime: options.workerRuntime ?? 'worker_threads',
    terminateTimeout: 1_000,
    execArgv: workerExecArgv(),
    env: workerEnvironment(),
    ...(workerHeapMb ? { resourceLimits: { maxOldGenerationSizeMb: workerHeapMb } } : {}),
  });
  // Without this listener, a worker crash makes `destroy()` throw an uncaught
  // TypeError (`emitter.removeListener is not a function`) and the process
  // prints a stack instead of the message from `run()`.
  pool.on('error', () => undefined);
  armPool(pool);
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
    throw actionableParseError(err, workerHeapMb);
  } finally {
    try {
      await closePool(pool);
    } finally {
      disarmPool();
    }
  }
}

function isWorkerOom(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(e?.message ?? '');
}

function resolveWorkerFile(): string | null {
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
