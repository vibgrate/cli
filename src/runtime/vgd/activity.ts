/**
 * A visible record of what the local runtime did for one command.
 *
 * When work moves into a daemon it stops being observable: the same `vg ask`
 * either loaded a 90 MB model or reused a warm index, and the output looked
 * identical either way. That is exactly the condition that let a daemon report
 * itself warm while holding nothing for eight hundred seconds. So every step
 * that vgd takes on a command's behalf is recorded here and printed — what was
 * attached, what was published, where the answer's semantic pass came from,
 * and how long each took.
 *
 * The log is also the honest place to say a step was *skipped*, and why: a
 * fallback to the in-process path is a normal outcome, not a failure, and the
 * user should be able to see which one they got.
 */
import { c } from '../../util/output.js';

export type ActivityOutcome = 'ok' | 'skip' | 'warn';

export interface ActivityStep {
  /** Short stable name — `attach`, `publish`, `semantic`, `answer`. */
  step: string;
  outcome: ActivityOutcome;
  /** Human sentence: what happened, in the terms the user thinks in. */
  detail: string;
  /** Wall time for this step, when it is worth knowing. */
  ms?: number;
}

const MARK: Record<ActivityOutcome, string> = { ok: '✔', skip: '·', warn: '!' };

export class ActivityLog {
  private readonly steps: ActivityStep[] = [];
  private readonly clock: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.clock = now;
  }

  add(step: string, outcome: ActivityOutcome, detail: string, ms?: number): void {
    this.steps.push({ step, outcome, detail, ms });
  }

  /** Time an async step and record its outcome from the result. */
  async time<T>(
    step: string,
    run: () => Promise<T>,
    describe: (result: T) => { outcome: ActivityOutcome; detail: string },
  ): Promise<T> {
    const started = this.clock();
    const result = await run();
    const { outcome, detail } = describe(result);
    this.add(step, outcome, detail, this.clock() - started);
    return result;
  }

  get length(): number {
    return this.steps.length;
  }

  /** Machine-readable form for `--json`. */
  toJSON(): ActivityStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  /** Dim, one line per step, under a heading. Empty when nothing was recorded. */
  render(heading = 'runtime'): string[] {
    if (!this.steps.length) return [];
    const lines = [c.dim(`  ${heading}`)];
    for (const s of this.steps) {
      const mark = s.outcome === 'ok' ? c.green(MARK.ok) : s.outcome === 'warn' ? c.yellow(MARK.warn) : c.dim(MARK.skip);
      const took = typeof s.ms === 'number' && s.ms >= 1 ? c.dim(` (${formatMs(s.ms)})`) : '';
      lines.push(`  ${mark} ${c.dim(`${s.step} · ${s.detail}`)}${took}`);
    }
    return lines;
  }
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
