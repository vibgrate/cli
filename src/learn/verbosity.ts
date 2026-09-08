/**
 * Verbosity learner — what output length the user actually consumes.
 *
 * Users rarely *say* how terse they want answers; they show it: they
 * interrupt long replies and answer faster than a long reply could be read.
 * Signals (all measured from transcripts):
 *  - interruptRate  = interrupts / (human turns + interrupts)
 *  - fastSkipRate   = replies arriving in < 50% of the read time (250 wpm) of a ≥ 150-word answer
 *  - longOutputRate = answers ≥ max(200, median words)
 *  - bulletsRatio / codeRatio = structure of assistant text
 *
 * pressure = interruptRate + fastSkipRate → L1 (< 0.10) · L2 (< 0.30) · L3
 * (≥ 0.30, capped). Fewer than 10 human turns → L2 with low confidence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { verbosityProfilePath } from '../compress/paths.js';
import type { Session, VerbosityProfile, VerbosityStats } from './types.js';

export const READING_WPM = 250;
export const SKIP_READ_FRACTION = 0.5;
export const MIN_WORDS_FOR_SKIP = 150;
export const LONG_OUTPUT_FLOOR = 200;
export const MIN_HUMAN_TURNS = 10;
export const HIGH_CONFIDENCE_TURNS = 60;

export type VerbositySignals = VerbosityStats & { sessions: number; humanTurns: number; interrupts: number };

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

/** Aggregate behavioural signals across sessions. Pure. */
export function verbositySignals(sessions: readonly Session[]): VerbositySignals {
  const words: number[] = [];
  let bulletLines = 0;
  let totalLines = 0;
  let codeTurns = 0;
  let responses = 0;
  let humans = 0;
  let interrupts = 0;
  let skipEligible = 0;
  let fastSkips = 0;
  let counted = 0;

  for (const s of sessions) {
    let any = false;
    let last: { words: number; ts?: number } | null = null;
    for (const t of s.turns) {
      if (t.kind === 'assistant') {
        any = true;
        const w = t.words ?? 0;
        if (w > 0 || (t.outputTokens ?? 0) > 0) {
          responses++;
          if (w > 0) words.push(w);
          const text = t.text ?? '';
          if (text) {
            const lines = text.split('\n').filter((l) => l.trim());
            totalLines += lines.length;
            bulletLines += lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l)).length;
            if (text.includes('```')) codeTurns++;
          }
          last = { words: w, ts: t.ts };
        }
      } else if (t.kind === 'interruption') {
        any = true;
        interrupts++;
        last = null;
      } else if (t.kind === 'user') {
        any = true;
        humans++;
        if (last && last.words >= MIN_WORDS_FOR_SKIP && t.ts !== undefined && last.ts !== undefined) {
          skipEligible++;
          const readSecs = (last.words / READING_WPM) * 60;
          if ((t.ts - last.ts) / 1000 < SKIP_READ_FRACTION * readSecs) fastSkips++;
        }
        last = null;
      }
    }
    if (any) counted++;
  }
  const sorted = [...words].sort((a, b) => a - b);
  const med = median(sorted);
  const longThreshold = Math.max(LONG_OUTPUT_FLOOR, med);
  const longOutputs = words.filter((w) => w >= longThreshold).length;
  const mean = words.length ? words.reduce((a, b) => a + b, 0) / words.length : 0;
  return {
    responses,
    medianWords: med,
    meanWords: Math.round(mean),
    bulletsRatio: round4(totalLines ? bulletLines / totalLines : 0),
    codeRatio: round4(responses ? codeTurns / responses : 0),
    longOutputRate: round4(responses ? longOutputs / responses : 0),
    interruptRate: round4(humans + interrupts ? interrupts / (humans + interrupts) : 0),
    fastSkipRate: round4(skipEligible ? fastSkips / skipEligible : 0),
    sessions: counted,
    humanTurns: humans,
    interrupts,
  };
}

/** The `VerbosityStats` subset (what the digest carries). */
export function verbosityStats(sessions: readonly Session[]): VerbosityStats {
  const { responses, medianWords, meanWords, bulletsRatio, codeRatio, longOutputRate, interruptRate, fastSkipRate } = verbositySignals(sessions);
  return { responses, medianWords, meanWords, bulletsRatio, codeRatio, longOutputRate, interruptRate, fastSkipRate };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Heuristic level from signals → (level, confidence, rationale). */
export function recommendLevel(sig: VerbositySignals): { level: number; confidence: VerbosityProfile['confidence']; rationale: string } {
  const turns = sig.humanTurns + sig.interrupts;
  if (turns < MIN_HUMAN_TURNS) return { level: 2, confidence: 'low', rationale: 'Too few human turns to calibrate; defaulting to L2.' };
  const ir = sig.interruptRate;
  const fsr = sig.fastSkipRate;
  const pressure = ir + fsr;
  const confidence: VerbosityProfile['confidence'] = turns >= HIGH_CONFIDENCE_TURNS ? 'high' : 'medium';
  if (pressure < 0.1) return { level: 1, confidence, rationale: `Low push-back (interrupt ${pct(ir)}, fast-skip ${pct(fsr)}); user reads answers — light touch (L1).` };
  if (pressure < 0.3) return { level: 2, confidence, rationale: `Moderate push-back (interrupt ${pct(ir)}, fast-skip ${pct(fsr)}); drop ceremony and echo (L2).` };
  if (pressure < 0.55) return { level: 3, confidence, rationale: `High push-back (interrupt ${pct(ir)}, fast-skip ${pct(fsr)}); user rarely reads long answers — conclusions only (L3).` };
  return { level: 3, confidence, rationale: `Very high push-back (interrupt ${pct(ir)}, fast-skip ${pct(fsr)}); capping at L3 rather than auto-applying L4.` };
}

/** Learn the verbosity profile for these sessions. `learnedAt` is left null until saved. */
export function learnVerbosity(sessions: readonly Session[], opts: { projectPath?: string | null } = {}): VerbosityProfile {
  const signals = verbositySignals(sessions);
  const rec = recommendLevel(signals);
  return {
    projectPath: opts.projectPath ?? sessions.find((s) => s.project)?.project ?? null,
    verbosityLevel: rec.level,
    suggested: `L${rec.level}` as VerbosityProfile['suggested'],
    confidence: rec.confidence,
    source: 'heuristic',
    rationale: rec.rationale,
    signals,
    learnedAt: null,
  };
}

/** Persist to `verbosityProfilePath()` (0600, atomic). Returns the path. */
export function saveVerbosityProfile(profile: VerbosityProfile, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): string {
  const file = verbosityProfilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...profile, learnedAt: profile.learnedAt ?? now }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return file;
}

export function loadVerbosityProfile(env: NodeJS.ProcessEnv = process.env): VerbosityProfile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(verbosityProfilePath(env), 'utf8');
  } catch {
    return null;
  }
  let d: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    d = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = typeof d.verbosityLevel === 'number' ? Math.min(4, Math.max(1, Math.round(d.verbosityLevel))) : 2;
  const conf = d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low';
  const sig = d.signals && typeof d.signals === 'object' ? (d.signals as Record<string, unknown>) : {};
  const num = (k: string): number => (typeof sig[k] === 'number' ? (sig[k] as number) : 0);
  return {
    projectPath: typeof d.projectPath === 'string' ? d.projectPath : null,
    verbosityLevel: level,
    suggested: `L${level}` as VerbosityProfile['suggested'],
    confidence: conf,
    source: 'heuristic',
    rationale: typeof d.rationale === 'string' ? d.rationale : '',
    signals: {
      responses: num('responses'),
      medianWords: num('medianWords'),
      meanWords: num('meanWords'),
      bulletsRatio: num('bulletsRatio'),
      codeRatio: num('codeRatio'),
      longOutputRate: num('longOutputRate'),
      interruptRate: num('interruptRate'),
      fastSkipRate: num('fastSkipRate'),
      sessions: num('sessions'),
      humanTurns: num('humanTurns'),
      interrupts: num('interrupts'),
    },
    learnedAt: typeof d.learnedAt === 'number' ? d.learnedAt : null,
  };
}
