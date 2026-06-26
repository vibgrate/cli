import chalk from 'chalk';
import { VERSION } from '../version.js';
import type { StepTiming } from './scan-history.js';

// ── Brand colours (from docs/design logo bundle) ──
const teal = chalk.hex('#3FB0A4');
const mint = chalk.hex('#4FE3C1');

// ── Boxy robot mark — rounded-square badge, square eyes, breakout arrow ──
const ROBOT = [
  '   ' + teal('╭──────╮') + mint('➜'),
  '  ' + chalk.dim('┤') + teal('│') + ' ' + mint('◼') + '  ' + mint('◼') + ' ' + teal('│') + chalk.dim('├'),
  '  ' + chalk.dim('┤') + teal('│') + '  ' + chalk.dim('▁▁') + '  ' + teal('│') + chalk.dim('├'),
  '   ' + teal('╰──────╯'),
];

const BRAND = [
  chalk.bold.white('  vibgrate'),
  chalk.dim(`  Drift Intelligence Engine`) + chalk.dim(` v${VERSION}`),
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface ScanStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  count?: number;
  /** Relative weight of this step for progress calculation (default 1) */
  weight?: number;
  /** Sub-step progress: files or items processed so far */
  subProgress?: number;
  /** Sub-step total: expected total items for this step */
  subTotal?: number;
  /** Current item label (e.g. file path being processed) */
  subLabel?: string;
}

export interface LiveStats {
  projects: number;
  dependencies: number;
  frameworks: number;
  findings: { warnings: number; errors: number; notes: number };
  /** Tree summary from pre-scan discovery */
  treeSummary?: { totalFiles: number; totalDirs: number };
}

/**
 * Zero-dependency live progress renderer for the scan command.
 * Renders to stderr so stdout stays clean for JSON/SARIF output.
 * Gracefully degrades in non-TTY environments (CI).
 */
export class ScanProgress {
  private steps: ScanStep[] = [];
  private stats: LiveStats = {
    projects: 0,
    dependencies: 0,
    frameworks: 0,
    findings: { warnings: 0, errors: 0, notes: 0 },
  };
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRowCount = 0;
  private startTime = Date.now();
  private isTTY: boolean;
  private useLiveUpdates: boolean;
  private rootDir = '';
  /** Last rendered frame content (strip to compare for dirty-checking) */
  private lastFrame = '';
  /** Whether we've hidden the cursor */
  private cursorHidden = false;

  /** Estimated total scan duration in ms (from history or live calculation) */
  private estimatedTotalMs: number | null = null;
  /** Per-step estimated durations from history */
  private stepEstimates = new Map<string, number>();
  /** Per-step actual start times for timing */
  private stepStartTimes = new Map<string, number>();
  /** Per-step recorded durations (completed steps) */
  private stepTimings: StepTiming[] = [];
  /** Last emitted step snapshot for append-only output modes */
  private lastLoggedStates = new Map<string, string>();

  constructor(rootDir: string) {
    this.isTTY = process.stderr.isTTY ?? false;
    this.useLiveUpdates = this.isTTY && process.env.VIBGRATE_PROGRESS_MODE !== 'plain';
    this.rootDir = rootDir;

    // Safety net: restore cursor if the process exits while it's hidden
    if (this.isTTY) {
      const restore = () => {
        if (this.cursorHidden) {
          process.stderr.write('\x1B[?25h');
          this.cursorHidden = false;
        }
      };
      process.on('exit', restore);
      process.on('SIGINT', () => { restore(); process.exit(130); });
      process.on('SIGTERM', () => { restore(); process.exit(143); });
    }
  }

  /** Set the estimated total duration from scan history */
  setEstimatedTotal(estimatedMs: number | null): void {
    this.estimatedTotalMs = estimatedMs;
  }

  /** Set per-step estimated durations from scan history */
  setStepEstimates(estimates: Map<string, number>): void {
    this.stepEstimates = estimates;
  }

  /** Get completed step timings for persisting to history */
  getStepTimings(): StepTiming[] {
    return [...this.stepTimings];
  }

  /** Register all steps up front, optionally with weights */
  setSteps(steps: Array<{ id: string; label: string; weight?: number }>): void {
    this.steps = steps.map((s) => ({ ...s, status: 'pending' as StepStatus, weight: s.weight ?? 1 }));
    if (this.isTTY) {
      // Print the static header once — it stays in terminal scroll history and
      // is never included in the repaint region. This prevents the logo from
      // being duplicated when the frame is taller than the terminal viewport.
      const header = [
        '',
        `  ${ROBOT[0]}  ${BRAND[0]}`,
        `  ${ROBOT[1]}  ${BRAND[1]}`,
        `  ${ROBOT[2]}`,
        `  ${ROBOT[3]}  ${chalk.dim(this.rootDir)}`,
        '',
      ].join('\n') + '\n';
      process.stderr.write(header);
      if (this.useLiveUpdates) {
        this.startSpinner();
      }
    }
    this.render();
  }

  /** Insert a new step before an existing step (used for dynamically discovered items) */
  insertStepBefore(beforeId: string, step: { id: string; label: string; weight?: number }): void {
    const idx = this.steps.findIndex((s) => s.id === beforeId);
    const newStep: ScanStep = { ...step, status: 'pending', weight: step.weight ?? 1 };
    if (idx >= 0) {
      this.steps.splice(idx, 0, newStep);
    } else {
      this.steps.push(newStep);
    }
  }

  /** Mark a step as active (currently running), optionally with expected total */
  startStep(id: string, subTotal?: number): void {
    const step = this.steps.find((s) => s.id === id);
    if (step) {
      step.status = 'active';
      step.detail = undefined;
      step.count = undefined;
      step.subProgress = 0;
      step.subTotal = subTotal;
    }
    this.stepStartTimes.set(id, Date.now());
    this.render();
  }

  /** Mark a step as completed */
  completeStep(id: string, detail?: string, count?: number): void {
    const step = this.steps.find((s) => s.id === id);
    if (step) {
      step.status = 'done';
      step.detail = detail;
      step.count = count;
    }
    // Record timing
    const started = this.stepStartTimes.get(id);
    if (started) {
      this.stepTimings.push({ id, durationMs: Date.now() - started });
    }
    this.render();
  }

  /** Mark a step as skipped */
  skipStep(id: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (step) {
      step.status = 'skipped';
      step.detail = 'disabled';
    }
    this.render();
  }

  /** Update sub-step progress for the active step (files processed, etc.) */
  updateStepProgress(id: string, current: number, total?: number, label?: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (step) {
      step.subProgress = current;
      if (total !== undefined) step.subTotal = total;
      if (label !== undefined) step.subLabel = label;
    }
    this.render();
  }

  /** Update live stats */
  updateStats(partial: Partial<LiveStats>): void {
    Object.assign(this.stats, partial);
    this.render();
  }

  /** Increment stats */
  addProjects(n: number): void {
    this.stats.projects += n;
    this.render();
  }

  addDependencies(n: number): void {
    this.stats.dependencies += n;
    this.render();
  }

  addFrameworks(n: number): void {
    this.stats.frameworks += n;
    this.render();
  }

  addFindings(warnings: number, errors: number, notes: number): void {
    this.stats.findings.warnings += warnings;
    this.stats.findings.errors += errors;
    this.stats.findings.notes += notes;
    this.render();
  }

  /** Stop the progress display and clear it */
  finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      // Build a single atomic write: cursor-up + erase-to-end + show cursor
      let buf = '';
      if (this.lastRowCount > 0) {
        buf += `\x1B[${this.lastRowCount}A`;
        buf += '\x1B[J';
      }
      // Restore cursor visibility
      buf += '\x1B[?25h';
      if (buf) process.stderr.write(buf);
      this.cursorHidden = false;
      this.lastRowCount = 0;
    }
    // Print a compact summary line
    const elapsed = this.formatElapsed(Date.now() - this.startTime);
    const doneCount = this.steps.filter((s) => s.status === 'done').length;
    process.stderr.write(
      chalk.dim(`  ✔ ${doneCount} scanners completed in ${elapsed}\n\n`),
    );

    // On Windows, stdout and stderr can desync, causing subsequent stdout
    // output to overlap with residual progress content. Synchronize by
    // writing an empty ANSI reset sequence to stdout and forcing a flush.
    if (this.isTTY && process.platform === 'win32') {
      // Move cursor to column 0 and clear to end of line on stdout
      process.stdout.write('\x1B[0G\x1B[K');
    }
  }

  // ── Internal rendering ──

  private startSpinner(): void {
    // Hide cursor to prevent flicker from cursor jumping during redraws
    if (!this.cursorHidden) {
      process.stderr.write('\x1B[?25l');
      this.cursorHidden = true;
    }
    // 120ms (≈8fps) is smooth enough and reduces flicker on slower terminals
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 120);
  }

  private clearLines(): void {
    // No-op — clearing is now folded into render() as a single atomic write
  }

  private render(): void {
    if (!this.useLiveUpdates) {
      this.renderCI();
      return;
    }

    // Build the full frame content first (header is printed once in setSteps)
    const lines: string[] = [];

    // Steps
    for (const step of this.steps) {
      lines.push(this.renderStep(step));
    }
    lines.push('');

    // Progress bar — weighted calculation with sub-step interpolation
    const totalWeight = this.steps.reduce((sum, s) => sum + (s.weight ?? 1), 0);
    let completedWeight = 0;
    for (const step of this.steps) {
      const w = step.weight ?? 1;
      if (step.status === 'done' || step.status === 'skipped') {
        completedWeight += w;
      } else if (step.status === 'active' && step.subTotal && step.subTotal > 0 && step.subProgress !== undefined) {
        // Interpolate within active step based on sub-progress
        completedWeight += w * Math.min(step.subProgress / step.subTotal, 0.99);
      } else if (step.status === 'active') {
        // Use historical step estimate for time-based interpolation
        const stepStart = this.stepStartTimes.get(step.id);
        const estimate = this.stepEstimates.get(step.id);
        if (stepStart && estimate && estimate > 0) {
          const stepElapsed = Date.now() - stepStart;
          completedWeight += w * Math.min(stepElapsed / estimate, 0.95);
        }
      }
    }
    const pct = totalWeight > 0 ? Math.min(Math.round((completedWeight / totalWeight) * 100), 99) : 0;
    const barWidth = 30;
    const filled = Math.round((completedWeight / Math.max(totalWeight, 1)) * barWidth);
    const bar =
      chalk.greenBright('━'.repeat(Math.min(filled, barWidth))) +
      chalk.dim('╌'.repeat(Math.max(barWidth - filled, 0)));
    const elapsedMs = Date.now() - this.startTime;
    const elapsedStr = this.formatElapsed(elapsedMs);
    const etaStr = this.computeEtaString(elapsedMs, completedWeight, totalWeight);
    const treePart = this.stats.treeSummary
      ? chalk.dim(` · ${this.stats.treeSummary.totalFiles.toLocaleString()} files · ${this.stats.treeSummary.totalDirs.toLocaleString()} dirs`)
      : '';
    lines.push(`  ${bar} ${chalk.bold.white(`${pct}%`)} ${chalk.dim(elapsedStr)}${etaStr}${treePart}`);
    lines.push('');

    // Live stats dashboard
    lines.push(this.renderStats());
    lines.push('');

    const content = lines.join('\n') + '\n';
    const rowCount = this.countRenderedRows(lines);

    // Dirty-check: skip the write entirely if the frame hasn't changed.
    // We compare the raw content (with ANSI codes) — this is cheap and
    // avoids thousands of identical repaints while the spinner is the
    // only thing that changes (it still changes every tick).
    if (content === this.lastFrame && this.lastRowCount === rowCount) {
      return;
    }
    this.lastFrame = content;

    // Build a single atomic buffer: cursor-up + erase-to-end + new content.
    // Using \x1B[J (erase to end of screen) instead of line-by-line \x1B[2K\n is
    // more robust: if lastLineCount drifts by 1-2 (e.g. due to PTY CRLF translation
    // or OS-level write splitting), \x1B[J still erases all ghost content below.
    let buf = '';
    if (this.lastRowCount > 0) {
      buf += `\x1B[${this.lastRowCount}A`;
      buf += '\x1B[J';
    }
    buf += content;
    process.stderr.write(buf);
    this.lastRowCount = rowCount;
  }

  private countRenderedRows(lines: string[]): number {
    const columns = Math.max(process.stderr.columns ?? 80, 20);
    return lines.reduce((total, line) => total + this.countWrappedRows(line, columns), 0);
  }

  private countWrappedRows(line: string, columns: number): number {
    const visibleWidth = Math.max(this.getDisplayWidth(line), 1);
    return Math.max(1, Math.ceil(visibleWidth / columns));
  }

  private getDisplayWidth(text: string): number {
    const clean = this.stripAnsi(text).replace(/\r/g, '');
    let width = 0;

    for (const char of clean) {
      const code = char.codePointAt(0);
      if (code === undefined) {
        continue;
      }
      if ((code >= 0 && code < 32) || (code >= 127 && code < 160)) {
        continue;
      }

      width += this.isWideCodePoint(code) ? 2 : 1;
    }

    return width;
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '');
  }

  private isWideCodePoint(code: number): boolean {
    return code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    );
  }

  private renderStep(step: ScanStep): string {
    const spinner = SPINNER_FRAMES[this.spinnerFrame]!;
    let icon: string;
    let label: string;
    let detail = '';

    switch (step.status) {
      case 'done':
        icon = chalk.green('✔');
        label = chalk.white(step.label);
        break;
      case 'active':
        icon = chalk.cyan(spinner);
        label = chalk.bold.white(step.label);
        // Show sub-progress for active steps (e.g. "3,421 / 12,340 files")
        if (step.subTotal && step.subTotal > 0 && step.subProgress !== undefined && step.subProgress > 0) {
          detail = chalk.dim(` · ${step.subProgress.toLocaleString()} / ${step.subTotal.toLocaleString()}`);
        }
        // Show current file/folder if available
        if (step.subLabel) {
          // Truncate long paths to fit terminal width (keep last ~50 chars)
          const maxLen = 50;
          const displayPath = step.subLabel.length > maxLen
            ? '…' + step.subLabel.slice(-maxLen + 1)
            : step.subLabel;
          detail += chalk.dim(` ${displayPath}`);
        }
        break;
      case 'skipped':
        icon = chalk.dim('◌');
        label = chalk.dim.strikethrough(step.label);
        break;
      default:
        icon = chalk.dim('○');
        label = chalk.dim(step.label);
        break;
    }

    if (step.detail) {
      detail = chalk.dim(` · ${step.detail}`);
    }
    if (step.count !== undefined && step.count > 0) {
      detail += chalk.cyan(` (${step.count})`);
    }

    return `  ${icon} ${label}${detail}`;
  }

  private renderStats(): string {
    const p = this.stats.projects;
    const d = this.stats.dependencies;
    const f = this.stats.frameworks;
    const w = this.stats.findings.warnings;
    const e = this.stats.findings.errors;
    const n = this.stats.findings.notes;

    const parts: string[] = [
      chalk.bold.white(`  ${p}`) + chalk.dim(` project${p !== 1 ? 's' : ''}`),
      chalk.white(`${d}`) + chalk.dim(` dep${d !== 1 ? 's' : ''}`),
      chalk.white(`${f}`) + chalk.dim(` framework${f !== 1 ? 's' : ''}`),
    ];

    const findingParts: string[] = [];
    if (e > 0) findingParts.push(chalk.red(`${e} ✖`));
    if (w > 0) findingParts.push(chalk.yellow(`${w} ⚠`));
    if (n > 0) findingParts.push(chalk.blue(`${n} ℹ`));

    if (findingParts.length > 0) {
      parts.push(findingParts.join(chalk.dim(' · ')));
    }

    return `  ${chalk.dim('┃')} ${parts.join(chalk.dim(' │ '))}`;
  }

  /** Simple CI-friendly output (no ANSI rewriting) */
  private renderCI(): void {
    for (const step of this.steps) {
      const stateKey = step.status === 'done'
        ? [step.status, step.detail ?? '', step.count?.toString() ?? ''].join('|')
        : step.status;
      if (this.lastLoggedStates.get(step.id) === stateKey) {
        continue;
      }
      this.lastLoggedStates.set(step.id, stateKey);

      if (step.status === 'active') {
        process.stderr.write(`  ◉ ${step.label}...\n`);
        continue;
      }

      if (step.status === 'done') {
        const detail = this.formatLoggedStepDetail(step);
        process.stderr.write(`  ✔ ${step.label}${detail}\n`);
        continue;
      }

      if (step.status === 'skipped') {
        const detail = step.detail ? ` · ${step.detail}` : '';
        process.stderr.write(`  ◌ ${step.label}${detail}\n`);
      }
    }
  }

  private formatLoggedStepDetail(step: ScanStep): string {
    let detail = '';

    if (step.detail) {
      detail += ` · ${step.detail}`;
    }
    if (step.count !== undefined && step.count > 0) {
      detail += ` (${step.count})`;
    }

    return detail;
  }

  // ── Time formatting helpers ──

  /**
   * Format elapsed time:
   * - Under 90s → "12.3s"
   * - 90s and above → "1m 30s"
   */
  private formatElapsed(ms: number): string {
    const totalSecs = ms / 1000;
    if (totalSecs < 90) {
      return `${totalSecs.toFixed(1)}s`;
    }
    const mins = Math.floor(totalSecs / 60);
    const secs = Math.floor(totalSecs % 60);
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }

  /**
   * Compute an ETA string for the progress bar.
   *
   * Uses two sources blended together:
   * 1. **Historical estimate** from `estimatedTotalMs` (if available)
   * 2. **Live rate** — extrapolated from `elapsedMs` and `completedWeight`
   *
   * Returns empty string if not enough data yet (< 3% progress or < 2s elapsed).
   */
  private computeEtaString(
    elapsedMs: number,
    completedWeight: number,
    totalWeight: number,
  ): string {
    if (totalWeight === 0 || elapsedMs < 2000) return '';

    const fraction = completedWeight / totalWeight;
    // Don't show ETA until we have at least 3% progress — avoids wild estimates
    if (fraction < 0.03) {
      // But if we have historical estimate, show that instead
      if (this.estimatedTotalMs !== null && this.estimatedTotalMs > 0) {
        const remaining = Math.max(0, this.estimatedTotalMs - elapsedMs);
        if (remaining > 1000) {
          return chalk.dim(` · ~${this.formatElapsed(remaining)} left`);
        }
      }
      return '';
    }

    // Live rate estimate
    const liveRemaining = (elapsedMs / fraction) * (1 - fraction);

    let remainingMs: number;
    if (this.estimatedTotalMs !== null && this.estimatedTotalMs > 0) {
      const histRemaining = Math.max(0, this.estimatedTotalMs - elapsedMs);
      // Blend: as we progress, trust live rate more than history
      // At 3% → 80% history, at 50% → 50/50, at 80% → 20% history
      const histWeight = Math.max(0.1, 1 - fraction);
      const blended = histRemaining * histWeight + liveRemaining * (1 - histWeight);
      // When fraction is fixed, liveRemaining grows at the same rate histRemaining shrinks,
      // causing the blend to be constant. Clamp to histRemaining so ETA always counts down.
      remainingMs = Math.min(histRemaining, blended);
    } else {
      remainingMs = liveRemaining;
    }

    // Don't show tiny remainders or negatives
    if (remainingMs < 1500) return '';

    return chalk.dim(` · ~${this.formatElapsed(remainingMs)} left`);
  }
}
