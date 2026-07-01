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
