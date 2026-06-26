// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';

/**
 * Semantic progress-event recorder for the web CLI simulator.
 *
 * Enabled by setting VIBGRATE_TRACE_EVENTS=<output.json>. ScanProgress calls
 * record() as the scan runs; finish() flushes a single JSON document.
 *
 * IP boundary: a trace contains ONLY what the terminal renderer would have
 * displayed — step labels, timings, counters and stats. It never contains
 * source code, scanner internals, or absolute machine paths (the workspace
 * root is reduced to its basename). The scenario builder applies a second
 * sanitisation pass before anything is published.
 */
export interface TraceEvent {
  /** Milliseconds since trace start */
  t: number;
  op: string;
  [key: string]: unknown;
}

export interface TraceDocument {
  traceVersion: 1;
  cliVersion: string;
  /** Basename of the scanned workspace — never the absolute path */
  workspace: string;
  recordedAt: string;
  durationMs: number;
  events: TraceEvent[];
}

export class ProgressTrace {
  private events: TraceEvent[] = [];
  private start = Date.now();
  private lastThrottled = new Map<string, number>();
  private flushed = false;

  constructor(private outPath: string) {}

  /** Returns a trace when VIBGRATE_TRACE_EVENTS is set, else null. */
  static fromEnv(): ProgressTrace | null {
    const path = process.env.VIBGRATE_TRACE_EVENTS;
    return path ? new ProgressTrace(path) : null;
  }

  record(op: string, data: Record<string, unknown> = {}): void {
    if (this.flushed) return;
    this.events.push({ t: Date.now() - this.start, op, ...data });
  }

  /**
   * Record at most one event per key per interval. Used for high-frequency
   * updates (sub-step progress, live stats) so traces stay compact.
   */
  recordThrottled(key: string, op: string, data: Record<string, unknown> = {}, intervalMs = 120): void {
    if (this.flushed) return;
    const now = Date.now();
    const last = this.lastThrottled.get(key) ?? 0;
    if (now - last < intervalMs) return;
    this.lastThrottled.set(key, now);
    this.record(op, data);
  }

  /** Write the trace document. Safe to call once; later calls are no-ops. */
  flush(meta: { cliVersion: string; rootDir: string }): void {
    if (this.flushed) return;
    this.flushed = true;
    const doc: TraceDocument = {
      traceVersion: 1,
      cliVersion: meta.cliVersion,
      workspace: basename(meta.rootDir) || meta.rootDir,
      recordedAt: new Date().toISOString(),
      durationMs: Date.now() - this.start,
      events: this.events,
    };
    try {
      mkdirSync(dirname(this.outPath), { recursive: true });
      writeFileSync(this.outPath, JSON.stringify(doc));
    } catch {
      // Tracing must never break a real scan; swallow write errors.
    }
  }
}
