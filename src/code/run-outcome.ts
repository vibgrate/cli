/**
 * `vibgrate.run-outcome/1` — the local, append-only record of what a `vg code`
 * run did: what was proposed, what the human decided, and how the run ended.
 *
 * CORRECTION (2026-07-30, maintainer): this module was originally justified by
 * two future consumers — the verify loop and "Relay routing telemetry" (using
 * edit-acceptance data to auto-pick a model per request). The second is now
 * confirmed void: Relay never re-picks a model — the user (or their chosen
 * Code Mode) selects one model for the whole session, and that has never been
 * a requirement for any product in this space. The verify loop, meanwhile, is
 * shipped separately via the extension's LSP round-trip and never depended on
 * this schema. See `docs/VG-RUN-OUTCOME-EVENTS-SPEC.md` for the full record —
 * **this producer currently has no live or committed consumer.**
 *
 * This module only produces; nothing reads or transmits the file yet, and
 * nothing here changes `vg code`'s stdout NDJSON protocol — it is a silent
 * observer wired at the `--stream-json` call site in `commands/code.ts`, built
 * and unit-tested independent of any process, model, or socket, the same way
 * `stream-json.ts` is.
 *
 * Privacy (spec's hard rule): no event carries source code, diffs, file
 * contents, prompts, or file paths. Instructions become a salted hash only;
 * files become a language/kind classification only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { installId } from '../engine/stats-share.js';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';
import { repositoryIdFromRoot } from '../runtime/paths.js';
import type { MutatingAction, PatchFileAction } from './tools.js';
import type { AgentResult } from './agent.js';
import type { StreamJsonOut } from './stream-json.js';

export const RUN_OUTCOME_SCHEMA = 'vibgrate.run-outcome/1';

export type InstructionKind = 'upgrade' | 'fix-vuln' | 'refactor' | 'feature' | 'other';
export type EditKind = 'code' | 'manifest' | 'lockfile' | 'config' | 'docs' | 'test';
export type EditDecision = 'approved' | 'rejected' | 'auto-approved';
export type RunOutcome = 'done' | 'error' | 'cancelled';

interface Envelope {
  schema: typeof RUN_OUTCOME_SCHEMA;
  runId: string;
  ts: string;
  repoId: string;
  gitRef: string | null;
  route: { mode?: string; provider?: string; model?: string };
  securityTier: string;
}

export type RunOutcomeEvent =
  | (Envelope & {
      event: 'run_started';
      instructionHash: string;
      instructionKind: InstructionKind;
      /** Absent (never 0/null-as-zero) — this producer does not trigger a rescan. */
      baseline: { driftScore: number | null; scoreMode: 'verified' | 'estimated' | null; advisories: number | null };
    })
  | (Envelope & {
      event: 'edit_proposed';
      editId: string;
      language: string | null;
      linesAdded: number;
      linesRemoved: number;
      kind: EditKind;
    })
  | (Envelope & { event: 'edit_decision'; editId: string; decision: EditDecision; latencyMs: number })
  | (Envelope & {
      event: 'run_completed';
      outcome: RunOutcome;
      edits: { proposed: number; approved: number; rejected: number; autoApproved: number };
      /** Same reasoning as `baseline` — this producer never triggers a rescan. */
      verify: null;
      /**
       * Last verify-step (the project's configured test/build command) result
       * observed this run. `null` = no verify step ran, never a false pass.
       */
      verifyOk: boolean | null;
      tokens: { input: number; output: number } | null;
    });

export interface RunOutcomeRoute {
  mode?: string;
  provider?: string;
  model?: string;
}

function hash(saltValue: string, value: string): string {
  return createHash('sha256').update(`${saltValue}|${value}`).digest('hex');
}

/**
 * Best-effort, best-guess classification of an instruction's purpose. A
 * heuristic, not a model call — good enough for routing-signal aggregation,
 * not claimed as precise. `fromFinding` is set when the instruction was
 * composed by "Route this fix →" (routeFix.ts), which already know their own
 * kind and skip guessing.
 */
export function classifyInstructionKind(
  instruction: string,
  fromFinding?: 'upgrade' | 'fix-vuln',
): InstructionKind {
  if (fromFinding) return fromFinding;
  const s = instruction.toLowerCase();
  if (/\bupgrade\b/.test(s) || /\bfrom\s+\S+\s+to\s+\S+/.test(s)) return 'upgrade';
  if (/\b(cve|vulnerab|advisor|security fix|exploit)\b/.test(s)) return 'fix-vuln';
  if (/\brefactor\b/.test(s)) return 'refactor';
  if (/\b(add|implement|build|create|feature)\b/.test(s)) return 'feature';
  return 'other';
}

const MANIFEST_BASENAMES = new Set([
  'package.json', 'go.mod', 'cargo.toml', 'pyproject.toml', 'requirements.txt',
  'gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'pubspec.yaml', 'mix.exs',
]);
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock',
  'gemfile.lock', 'composer.lock', 'go.sum', 'pubspec.lock', 'mix.lock',
]);
const MANIFEST_EXTS = new Set(['.csproj', '.fsproj', '.vbproj']);

/** Coarse per-file classification for `edit_proposed.kind` — filename-only, no content read. */
export function classifyEditKind(file: string): EditKind {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  if (MANIFEST_BASENAMES.has(base) || MANIFEST_EXTS.has(ext)) return 'manifest';
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (ext === '.md' || ext === '.mdx' || file.split(/[\\/]/).includes('docs')) return 'docs';
  if (/\.(test|spec)\.[^.]+$/.test(base) || /(^|[\\/])(__tests__|tests|test|spec)([\\/]|$)/.test(file)) return 'test';
  if (base.startsWith('.') || /\.config\.[^.]+$/.test(base) || /\.(ya?ml|toml|ini|env)$/.test(base)) return 'config';
  return 'code';
}

/** Language/extension label only — never a path. Empty extension → null. */
function languageOf(file: string): string | null {
  const ext = path.extname(file).replace(/^\./, '');
  return ext || null;
}

/** Count `+`/`-` content lines in a unified diff (excludes `+++`/`---` headers). */
function diffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

interface EditShape {
  language: string | null;
  linesAdded: number;
  linesRemoved: number;
  kind: EditKind;
}

/** Derive the `edit_proposed` shape from a `MutatingAction`, or null for non-edit actions (`run`/`tool`). */
export function shapeOfAction(action: MutatingAction): EditShape | null {
  switch (action.kind) {
    case 'edit': {
      const { added, removed } = diffLineCounts(action.diff);
      return { language: languageOf(action.file), linesAdded: added, linesRemoved: removed, kind: classifyEditKind(action.file) };
    }
    case 'create':
      return { language: languageOf(action.file), linesAdded: 0, linesRemoved: 0, kind: classifyEditKind(action.file) };
    case 'delete':
      return { language: languageOf(action.file), linesAdded: 0, linesRemoved: 0, kind: classifyEditKind(action.file) };
    case 'patch': {
      let added = 0;
      let removed = 0;
      const kinds = new Set<EditKind>();
      for (const f of action.files as PatchFileAction[]) {
        if (f.diff) {
          const c = diffLineCounts(f.diff);
          added += c.added;
          removed += c.removed;
        }
        kinds.add(classifyEditKind(f.file));
      }
      return { language: null, linesAdded: added, linesRemoved: removed, kind: kinds.size === 1 ? [...kinds][0]! : 'code' };
    }
    case 'run':
    case 'tool':
      return null; // not a file edit — out of scope for this schema
  }
}

function outcomeDir(root: string): string {
  return path.join(root, '.vibgrate');
}

function outcomePath(root: string): string {
  return path.join(outcomeDir(root), 'run-outcomes.jsonl');
}

/** Best-effort append — a read-only checkout just means no local record, never a thrown error. */
function append(root: string, event: RunOutcomeEvent): void {
  try {
    fs.mkdirSync(outcomeDir(root), { recursive: true });
    // First writer into .vibgrate/ in this repo creates its .gitignore (create-once,
    // never overwritten) — protects this file even when `vg code` runs before any
    // `vg scan`/`vg build`/`vg install` has touched the repo.
    ensureVibgrateGitignore(root);
    fs.appendFileSync(outcomePath(root), `${JSON.stringify(event)}\n`);
  } catch {
    /* best-effort only */
  }
}

interface PendingEdit {
  runId: string;
  shape: EditShape;
  proposedAt: number;
}

interface RunTally {
  proposed: number;
  approved: number;
  rejected: number;
  autoApproved: number;
  lastVerifyOk: boolean | null;
}

/**
 * Observes the same `StreamJsonOut` lines already flowing to the host over
 * stdout/stdin (via a transparent tee — see `wireRunOutcome`) and turns them
 * into the envelope above. One instance per `vg code` process; `beginRun` is
 * called once per turn (once for a one-shot run, once per turn in session
 * mode), so `runId` scoping is the caller's — this class never invents one.
 */
export class RunOutcomeRecorder {
  private currentRunId: string | null = null;
  private readonly tallies = new Map<string, RunTally>();
  private readonly pending = new Map<number, PendingEdit>();

  constructor(
    private readonly root: string,
    private readonly repoId: string,
    private readonly gitRef: string | null,
    private readonly route: RunOutcomeRoute,
    private readonly securityTier: string,
    private readonly auto: boolean,
    private readonly now: () => number = Date.now,
    /**
     * Salt for `instructionHash`. Defaults to the real per-install id
     * ({@link installId}) in production; tests should pass a fixed string so
     * they never touch the real machine's `~/.vibgrate/install-id`.
     */
    private readonly saltValue: string = installId(),
  ) {}

  private envelope(runId: string): Envelope {
    return {
      schema: RUN_OUTCOME_SCHEMA,
      runId,
      ts: new Date(this.now()).toISOString(),
      repoId: this.repoId,
      gitRef: this.gitRef,
      route: this.route,
      securityTier: this.securityTier,
    };
  }

  /** Start recording a new run/turn. Call before the instruction is handed to the agent. */
  beginRun(runId: string, instruction: string, fromFinding?: 'upgrade' | 'fix-vuln'): void {
    this.currentRunId = runId;
    this.tallies.set(runId, { proposed: 0, approved: 0, rejected: 0, autoApproved: 0, lastVerifyOk: null });
    append(this.root, {
      ...this.envelope(runId),
      event: 'run_started',
      instructionHash: hash(this.saltValue, instruction),
      instructionKind: classifyInstructionKind(instruction, fromFinding),
      baseline: { driftScore: null, scoreMode: null, advisories: null },
    });
  }

  /**
   * Feed one outgoing protocol line. Transparent — never mutates or drops
   * the line; the caller still writes it to the host exactly as before.
   */
  observe(line: StreamJsonOut): void {
    const runId = this.currentRunId;
    if (!runId) return;
    const tally = this.tallies.get(runId);
    if (!tally) return;

    if (line.event === 'approve-request') {
      const shape = shapeOfAction(line.action);
      if (!shape) return; // run/tool — not a file edit
      tally.proposed++;
      const editId = randomUUID();
      this.pending.set(line.id, { runId, shape, proposedAt: this.now() });
      append(this.root, { ...this.envelope(runId), event: 'edit_proposed', editId, ...shape });
      // Auto-approve resolves synchronously in StreamJsonSession before any
      // host round-trip — record that decision now; no host message arrives.
      if (this.auto) {
        tally.autoApproved++;
        append(this.root, { ...this.envelope(runId), event: 'edit_decision', editId, decision: 'auto-approved', latencyMs: 0 });
        this.pending.delete(line.id);
      } else {
        // Stash the editId against the wire id so `noteDecision` can find it.
        this.editIdByApproveId.set(line.id, editId);
      }
      return;
    }

    if (line.event === 'event' && line.type === 'verify') {
      tally.lastVerifyOk = line.passed;
      return;
    }

    if (line.event === 'done') {
      this.finish(runId, tally, 'done', line.result);
      return;
    }
    if (line.event === 'error') {
      this.finish(runId, tally, 'error', null);
    }
  }

  private readonly editIdByApproveId = new Map<number, string>();

  /**
   * A real (non-auto) approve/reject arrived from the host over stdin. `id`
   * is the same numeric id `StreamJsonSession` put on the `approve-request`
   * line — the natural join key, already unique for the process lifetime.
   */
  noteDecision(approveId: number, approved: boolean): void {
    const editId = this.editIdByApproveId.get(approveId);
    const pending = this.pending.get(approveId);
    if (!editId || !pending) return;
    this.editIdByApproveId.delete(approveId);
    this.pending.delete(approveId);
    const tally = this.tallies.get(pending.runId);
    if (tally) approved ? tally.approved++ : tally.rejected++;
    append(this.root, {
      ...this.envelope(pending.runId),
      event: 'edit_decision',
      editId,
      decision: approved ? 'approved' : 'rejected',
      latencyMs: Math.max(0, this.now() - pending.proposedAt),
    });
  }

  /** The host disconnected / turn was cancelled mid-approval — reject what's left, no hang. */
  cancelPending(): void {
    for (const id of [...this.pending.keys()]) this.noteDecision(id, false);
  }

  private finish(runId: string, tally: RunTally, outcome: RunOutcome, result: AgentResult | null): void {
    append(this.root, {
      ...this.envelope(runId),
      event: 'run_completed',
      outcome,
      edits: { proposed: tally.proposed, approved: tally.approved, rejected: tally.rejected, autoApproved: tally.autoApproved },
      verify: null,
      verifyOk: tally.lastVerifyOk,
      tokens: result ? { input: result.usage.promptTokens, output: result.usage.completionTokens } : null,
    });
    this.tallies.delete(runId);
    if (this.currentRunId === runId) this.currentRunId = null;
  }
}

/** Mint a runId for a one-shot `vg code` invocation (no session). */
export function newOneShotRunId(): string {
  return `r${randomUUID()}`;
}

/** Mint a runId for one turn of a `--session` run. */
export function turnRunId(sessionId: string, turnIndex: number): string {
  return `${sessionId}#${turnIndex}`;
}

export { repositoryIdFromRoot as runOutcomeRepoId };
