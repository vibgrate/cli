import * as fs from 'node:fs';
import { sanitizeClient, type SavingEntry } from '../engine/savings.js';
import type { SessionStats } from './serve-stats.js';

/**
 * Folds CLI navigation calls into the live `vg serve` status display.
 *
 * An agent that shells out to the CLI (`vg impact <name> --client=claude`)
 * appends a counts-only entry to the local ledger (`.vibgrate/cache/
 * savings.jsonl`, engine/savings.ts) — a different process from the serve one,
 * so the in-memory SessionStats never sees it. This tail polls the ledger for
 * lines appended after serve start and records the `source: 'cli'` ones into
 * the same SessionStats the display renders, so the operator watching
 * `vg serve` sees CLI traffic too.
 *
 * Only `cli` entries are ingested: `mcp` lines are written by a serve process
 * that already recorded them live (its own, or another one — either way,
 * counting them here would double-book).
 *
 * Everything stays in-process and local. Polling (not fs.watch) because watch
 * semantics differ per platform (and are unreliable on Windows/network drives);
 * a 2s stat of one small file is free. The timer is unref'd — the MCP server,
 * not this tail, keeps the process alive.
 */

const POLL_INTERVAL_MS = 2000;

export class LedgerTail {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Byte offset of the next unread ledger byte (always at a line boundary). */
  private offset = 0;

  constructor(
    private readonly file: string,
    private readonly stats: SessionStats,
    private readonly intervalMs = POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    // Start at the current end: only calls made while this serve runs count —
    // the display is a session view, not a history report (`vg savings` is).
    this.offset = this.sizeOf();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle — exposed for tests (deterministic, no timers needed). */
  poll(now: number = Date.now()): void {
    let size: number;
    try {
      size = this.sizeOf();
    } catch {
      return; // never let the display break serving
    }
    // Shrunk file = truncated/rotated ledger — start over from the top.
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;

    let chunk: Buffer;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        chunk = Buffer.alloc(size - this.offset);
        fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    // Consume only whole lines; a partially-flushed last line stays for the
    // next poll (offset advances to just past the final newline).
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const text = chunk.subarray(0, lastNewline).toString('utf8');
    this.offset += lastNewline + 1;
    for (const line of text.split('\n')) ingestLedgerLine(this.stats, line, now);
  }

  private sizeOf(): number {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0; // no ledger yet — nothing recorded so far
    }
  }
}

/**
 * Record one ledger line into the session stats iff it is a CLI-sourced call.
 * Corrupt lines are skipped, same as every other ledger reader.
 */
export function ingestLedgerLine(stats: SessionStats, line: string, now: number): void {
  if (!line.trim()) return;
  let e: SavingEntry;
  try {
    e = JSON.parse(line) as SavingEntry;
  } catch {
    return;
  }
  if (e.source !== 'cli' || typeof e.tool !== 'string') return;
  stats.record(
    {
      tool: e.tool,
      client: sanitizeClient(e.client),
      outcome: e.outcome ?? 'complete',
      source: 'cli',
      // CLI lines carry no wall time — leave ms absent ("not measured").
      vgTokens: e.vgTokens ?? 0,
      baselineTokens: e.baselineTokens ?? 0,
    },
    now,
  );
}
