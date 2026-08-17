/**
 * Stage wall-clock timers for build diagnostics.
 * Pure measurement — never enters the serialized graph artifact.
 */

export type StageName =
  | 'discover'
  | 'hash'
  | 'parse'
  | 'resolve'
  | 'tsc'
  | 'scip'
  | 'tests'
  /** Structural extraction over the infrastructure/CI corpus (engine/toolchain/). */
  | 'toolchain'
  | 'analyze'
  | 'facts'
  | 'ground'
  | 'index'
  | 'total';

export type StageTimings = Partial<Record<StageName, number>>;

export class StageTimer {
  private readonly marks = new Map<string, number>();
  private readonly durations: StageTimings = {};

  start(name: StageName): void {
    this.marks.set(name, nowMs());
  }

  end(name: StageName): number {
    const t0 = this.marks.get(name);
    if (t0 === undefined) return 0;
    const ms = Math.round((nowMs() - t0) * 1000) / 1000;
    this.durations[name] = ms;
    this.marks.delete(name);
    return ms;
  }

  /** Run `fn` under a named stage. */
  async measure<T>(name: StageName, fn: () => T | Promise<T>): Promise<T> {
    this.start(name);
    try {
      return await fn();
    } finally {
      this.end(name);
    }
  }

  snapshot(): StageTimings {
    return { ...this.durations };
  }
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
