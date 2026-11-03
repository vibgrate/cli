/**
 * Per-turn profiling and audit tracing for `vg code` (parity spec Phase 0).
 *
 * Off by default, and observation-only: it never changes what the agent does
 * or what a host receives. Switches (flag, or env for hosts that spawn us):
 *
 *   --profile            VG_CODE_PROFILE=1      one-line summary on stderr per turn
 *   --profile-out <f>    VG_CODE_PROFILE_OUT    append one JSON record per turn (JSONL)
 *   --trace-out <f>      VG_CODE_TRACE_OUT      append every protocol frame, timestamped (NDJSON)
 *   --acp-log <f>        VG_CODE_ACP_LOG        append the raw ACP wire (JSON-RPC lines, ACP backend only)
 *
 * Everything written to a file passes through {@link redactSecrets} first
 * (GUARDRAILS §1.1: redact at ingest, never persist a credential). Profile
 * records hold counts, timings and file paths — never file contents.
 *
 * The visible-transcript numbers (activity lines, Changes cards) come from the
 * same reference renderer the tests use (host-transcript.ts), so a profile
 * answers "how quiet was this turn" with the number a HOST_UI.md host shows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSecrets } from './providers.js';
import { visibleTranscript } from './host-transcript.js';

export const PROFILE_SCHEMA = 'vg-code-profile/1';

export interface ProfileSwitches {
  /** Print the one-line summary to stderr after each turn. */
  print: boolean;
  /** JSONL file for per-turn profile records. */
  profileOut?: string;
  /** NDJSON file for the timestamped frame trace. */
  traceOut?: string;
  /** NDJSON file for the raw ACP wire log. */
  acpLog?: string;
}

/** Resolve the switches from flags first, then the environment. */
export function resolveProfileSwitches(
  flags: { profile?: boolean; profileOut?: string; traceOut?: string; acpLog?: string },
  env: NodeJS.ProcessEnv = process.env,
): ProfileSwitches {
  const on = (v: string | undefined): boolean => !!v && v !== '0' && v.toLowerCase() !== 'false';
  return {
    print: !!flags.profile || on(env.VG_CODE_PROFILE),
    profileOut: flags.profileOut || env.VG_CODE_PROFILE_OUT || undefined,
    traceOut: flags.traceOut || env.VG_CODE_TRACE_OUT || undefined,
    acpLog: flags.acpLog || env.VG_CODE_ACP_LOG || undefined,
  };
}

export function profilingEnabled(s: ProfileSwitches): boolean {
  return s.print || !!s.profileOut || !!s.traceOut;
}

/** One turn's profile record (the JSONL row written to --profile-out). */
export interface TurnProfile {
  schema: typeof PROFILE_SCHEMA;
  /** `native` (the VG Code loop) or the ACP backend id (`grok-build`, `acp`). */
  backend: string;
  provider: string;
  model: string;
  turn: number;
  /** First 200 chars of the instruction, redacted. */
  instruction: string;
  startedAt: string;
  steps: number | null;
  stopReason: string | null;
  /** Wall time from turn start to the terminal frame (`done` / `error`). */
  wallMs: number;
  /** Engine-reported loop wall time (metrics.wallMs), when the engine sent it. */
  engineWallMs: number | null;
  toolCalls: number;
  changes: number;
  filesChanged: string[];
  /** Visible lines under HOST_UI.md defaults. */
  activityLines: number;
  changesCards: number;
  permissionCards: number;
  questions: number;
  /** Raw frames a default host hides (debug-only noise), by type. */
  hiddenFrames: Record<string, number>;
  timeToFirstTokenMs: number | null;
  timeToFirstToolMs: number | null;
  timeToFirstActivityMs: number | null;
  /** Finished, with a non-empty answer and no error frame. */
  concludedCleanly: boolean;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
}

type Line = Record<string, unknown>;

/** The one-line `--profile` summary. */
export function formatProfileLine(p: TurnProfile): string {
  const s = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`);
  return (
    `profile: steps=${p.steps ?? '-'} stop=${p.stopReason ?? '-'} wall=${s(p.wallMs)} tools=${p.toolCalls} ` +
    `changes=${p.changes} activity=${p.activityLines} cards=${p.changesCards} ttft=${s(p.timeToFirstTokenMs)} ` +
    `clean=${p.concludedCleanly ? 'yes' : 'no'} backend=${p.backend}`
  );
}

function append(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* profiling never fails a run */
  }
}

/**
 * Observes the protocol frames of a session, one turn at a time. Feed it every
 * line written to the host (`observe`); call `beginTurn` before a turn and
 * `endTurn` after its terminal frame.
 */
export class ProfileRecorder {
  private turnNo = 0;
  private lines: Line[] = [];
  private t0 = 0;
  private startedAt = '';
  private instruction = '';
  private firstToken: number | null = null;
  private firstTool: number | null = null;
  private firstActivity: number | null = null;

  constructor(
    private readonly switches: ProfileSwitches,
    private meta: { backend: string; provider: string; model: string },
    private readonly clock: () => number = Date.now,
    private readonly stderr: (s: string) => void = (s) => process.stderr.write(s),
  ) {}

  /** Update the model label once it is known (an ACP agent reports it on initialize). */
  setModel(model: string): void {
    this.meta = { ...this.meta, model };
  }

  beginTurn(instruction: string): void {
    this.turnNo++;
    this.lines = [];
    this.t0 = this.clock();
    this.startedAt = new Date(this.t0).toISOString();
    this.instruction = redactSecrets(instruction).slice(0, 200);
    this.firstToken = this.firstTool = this.firstActivity = null;
  }

  /** Observe one protocol frame (exactly what the host receives). */
  observe(line: Line): void {
    // Frames before the first turn (session-start, map build) are traced only.
    if (!this.turnNo) {
      if (this.switches.traceOut) append(this.switches.traceOut, redactSecrets(JSON.stringify({ turn: 0, t: 0, line })));
      return;
    }
    const t = this.clock() - this.t0;
    this.lines.push(line);
    if (line.event === 'event') {
      const type = line.type;
      if ((type === 'token' || type === 'assistant') && this.firstToken === null) this.firstToken = t;
      if (type === 'tool-call' && this.firstTool === null) this.firstTool = t;
      if (type === 'activity' && this.firstActivity === null) this.firstActivity = t;
    }
    if (this.switches.traceOut) {
      append(this.switches.traceOut, redactSecrets(JSON.stringify({ turn: this.turnNo, t, line })));
    }
  }

  /** Close the turn: compute, print and persist its profile. */
  endTurn(): TurnProfile {
    const wallMs = Math.max(0, this.clock() - this.t0);
    const view = visibleTranscript(this.lines);
    const done = [...this.lines].reverse().find((l) => l.event === 'done') as { result?: Record<string, unknown> } | undefined;
    const errorLine = [...this.lines].reverse().find((l) => l.event === 'error') as { message?: unknown } | undefined;
    const metricsLine = [...this.lines]
      .reverse()
      .find((l) => l.event === 'event' && l.type === 'metrics') as { metrics?: Record<string, unknown> } | undefined;
    const m = metricsLine?.metrics ?? {};
    const result = done?.result ?? {};
    const changes = Array.isArray(result.changes) ? (result.changes as Array<{ file?: unknown }>) : [];
    const usage = (result.usage ?? {}) as { promptTokens?: number; completionTokens?: number };
    const stopReason = typeof result.stopped === 'string' ? result.stopped : typeof m.stopReason === 'string' ? m.stopReason : errorLine ? 'error' : null;
    const toolCalls = typeof m.toolCalls === 'number' ? m.toolCalls : this.lines.filter((l) => l.event === 'event' && l.type === 'tool-call').length;
    const profile: TurnProfile = {
      schema: PROFILE_SCHEMA,
      backend: this.meta.backend,
      provider: this.meta.provider,
      model: this.meta.model,
      turn: this.turnNo,
      instruction: this.instruction,
      startedAt: this.startedAt,
      steps: typeof result.steps === 'number' ? result.steps : typeof m.steps === 'number' ? m.steps : null,
      stopReason,
      wallMs,
      engineWallMs: typeof m.wallMs === 'number' ? m.wallMs : null,
      toolCalls,
      changes: changes.length,
      filesChanged: [...new Set(changes.map((c) => String(c.file ?? '')).filter(Boolean))],
      activityLines: view.activityLines,
      changesCards: view.changesCards,
      permissionCards: view.permissionCards,
      questions: view.items.filter((i) => i.kind === 'question').length,
      hiddenFrames: view.hidden,
      timeToFirstTokenMs: this.firstToken,
      timeToFirstToolMs: this.firstTool,
      timeToFirstActivityMs: this.firstActivity,
      concludedCleanly: stopReason === 'finished' && !!view.answer && !errorLine,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      error: errorLine ? redactSecrets(String(errorLine.message ?? '')).slice(0, 500) : null,
    };
    if (this.switches.print) this.stderr(formatProfileLine(profile) + '\n');
    if (this.switches.profileOut) append(this.switches.profileOut, redactSecrets(JSON.stringify(profile)));
    return profile;
  }
}

/** A raw ACP wire logger for `--acp-log` (redacted, timestamped NDJSON). */
export function acpWireLogger(file: string, clock: () => number = Date.now): (dir: string, line: string) => void {
  return (dir, line) => append(file, redactSecrets(JSON.stringify({ ts: new Date(clock()).toISOString(), dir, line })));
}
