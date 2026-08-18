import { c } from './output.js';
import { brandProgressBar } from '../core-open/ui/bar.js';

/**
 * A small progress bar matching the scanner's style
 * (`vibgrate-core-open/src/ui/progress.ts`): a smooth sub-cell gradient bar
 * (shared `brandProgressBar`), a braille spinner, percent, elapsed and ETA.
 * Renders to **stderr** in place, and only when stderr is a TTY — under a
 * pipe/CI it stays silent so logs aren't polluted.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const WIDTH = 30;

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Pure render of one progress line (no I/O, no clock) so it is unit-testable.
 * `elapsedMs` and `frame` are passed in by the caller.
 */
export function formatProgressLine(
  label: string,
  done: number,
  total: number,
  elapsedMs: number,
  frame: number,
): string {
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  const bar = brandProgressBar(ratio, WIDTH);
  const pct = Math.round(ratio * 100);
  const spin = c.cyan(FRAMES[((frame % FRAMES.length) + FRAMES.length) % FRAMES.length]);
  const eta = ratio > 0.02 && ratio < 1 ? ` · eta ${fmtDuration((elapsedMs / ratio) * (1 - ratio))}` : '';
  return `  ${spin} ${label} ${bar} ${c.bold(`${pct}%`)} ${c.dim(`${done}/${total} · ${fmtDuration(elapsedMs)}${eta}`)}`;
}

/** Pure status line (spinner + message + elapsed). Used by {@link LiveStatus}. */
export function formatStatusLine(message: string, elapsedMs: number, frame: number): string {
  const spin = c.cyan(FRAMES[((frame % FRAMES.length) + FRAMES.length) % FRAMES.length]);
  return `  ${spin} ${message} ${c.dim(`· ${fmtDuration(elapsedMs)}`)}`;
}

export interface LiveStatusOptions {
  /** Destination (tests inject a buffer). Default stderr. */
  stream?: { write(chunk: string): unknown; isTTY?: boolean };
  /** Force TTY / non-TTY. Default: stream.isTTY. */
  tty?: boolean;
  /** Spinner cadence in ms (default 120). */
  intervalMs?: number;
  now?: () => number;
}

/**
 * A ticking in-place status line on stderr.
 *
 * `vg ask` used to print nothing until the answer was ready, so a 30s daemon
 * wait looked like a hang — and clearing the terminal left a blank screen
 * because nothing redrew. This line paints immediately, then again every tick,
 * so the user always sees what is happening.
 *
 * Non-TTY (pipe/CI): one line when the message changes, never a spinner.
 */
export class LiveStatus {
  private message = '';
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private stopped = true;
  private readonly stream: { write(chunk: string): unknown; isTTY?: boolean };
  private readonly tty: boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(options: LiveStatusOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.tty = options.tty ?? Boolean(this.stream.isTTY);
    this.intervalMs = options.intervalMs ?? 120;
    this.now = options.now ?? ((): number => Date.now());
  }

  start(message: string): void {
    if (!this.stopped) {
      this.set(message);
      return;
    }
    this.stopped = false;
    this.message = message;
    this.startedAt = this.now();
    this.frame = 0;
    if (this.tty) {
      this.paint();
      this.timer = setInterval(() => this.paint(), this.intervalMs);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    } else {
      this.stream.write(`  ${message}\n`);
    }
  }

  set(message: string): void {
    if (this.stopped || message === this.message) return;
    this.message = message;
    if (this.tty) this.paint();
    else this.stream.write(`  ${message}\n`);
  }

  /** Clear the live line. Optionally leave a final (non-spinner) line. */
  stop(final?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) {
      this.stream.write('\r\x1b[2K');
      if (final) this.stream.write(`${final}\n`);
    } else if (final) {
      this.stream.write(`  ${final}\n`);
    }
  }

  private paint(): void {
    if (this.stopped) return;
    const line = formatStatusLine(this.message, this.now() - this.startedAt, this.frame++);
    this.stream.write(`\r\x1b[2K${line}`);
  }
}

/** Live, in-place progress bar on stderr (no-op when stderr isn't a TTY). */
export class ProgressBar {
  private readonly start = Date.now();
  private frame = 0;
  private readonly tty = Boolean(process.stderr.isTTY);

  constructor(private readonly label: string) {}

  update(done: number, total: number): void {
    if (!this.tty) return;
    const line = formatProgressLine(this.label, done, total, Date.now() - this.start, this.frame++);
    process.stderr.write(`\r\x1b[2K${line}`);
  }

  /** Clear the bar; optionally print a final summary line. */
  done(summary?: string): void {
    if (!this.tty) return;
    process.stderr.write('\r\x1b[2K');
    if (summary) process.stderr.write(`${summary}\n`);
  }
}
