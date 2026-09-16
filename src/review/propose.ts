/**
 * Review → PatchIR adapter.
 *
 * Review reuses the VG Code agent loop (`runAgent`). There is no second loop:
 * this module builds the instruction, pins the backend, and translates the
 * existing result into PatchIR + a tool trace + a stop reason.
 *
 * Contract:
 *   Input  — Analysis Capsule + one `vg.review.findings.v1` finding + policy
 *            snippet + model id (`relay:<slug>` or spark|flow|forge)
 *   Output — `patch-ir/0` + tool trace + stop reason
 *   Rules  — dry-run unless `apply`; never write the default branch;
 *            checkpoints under `refs/vibgrate/checkpoints/*`;
 *            errors never look like success (`ok` is false on every stop
 *            that produced no verified patch).
 */

import { runAgent, AGENT_NO_PROGRESS_STOP_AT, type AgentEvent, type AgentStop } from '../code/agent.js';
import { createCheckpoint, type Checkpoint } from '../code/checkpoint.js';
import { codeEditsToPatchIR, validatePatchIR, type PatchIR } from '../code/patch-ir.js';
import { hostedFallbackIsFailure, resolveProviders } from '../code/router.js';
import { nodeCodeFs, runCodeSession, type CodeFs } from '../code/session.js';
import type { FileChange, Provider } from '../code/types.js';
import type { VgGraph } from '../schema.js';
import { CliError, ExitCode } from '../util/exit.js';
import { defaultRun as defaultGitRun, type GitRunner } from './git.js';
import {
  FINDINGS_SCHEMA,
  type AnalysisCapsule,
  type ReviewFinding,
} from './schemas.js';

/** `--loop` step cap. Same number as the identical-call no-progress stop. */
export const REVIEW_PROPOSE_LOOP_CAP = AGENT_NO_PROGRESS_STOP_AT;

export const CODE_MODES = ['spark', 'flow', 'forge'] as const;
export type CodeModeId = (typeof CODE_MODES)[number];

export type ReviewProposeModel =
  | { kind: 'relay'; model: string }
  | { kind: 'code-mode'; mode: CodeModeId };

export type ReviewProposeStopReason =
  | AgentStop
  | 'default-branch'
  | 'no-patch'
  | 'invalid-model'
  | 'fallback-backend';

export interface ReviewProposeToolEvent {
  name: string;
  args: Record<string, unknown>;
  content?: string;
  mutated?: boolean;
  failed?: boolean;
}

export interface ReviewProposeInput {
  capsule: AnalysisCapsule;
  finding: ReviewFinding;
  policySnippet: string;
  /** `relay:<slug>` or `spark` | `flow` | `forge`. */
  modelId: string;
  root: string;
  graph: VgGraph;
  /** Write the patch. Default false — dry-run. */
  apply?: boolean;
  /** Consent for the write (`--yes`). Apply without consent stays dry-run. */
  consent?: boolean;
  /**
   * Agent loop (`--loop`). Default true — Review reuses `runAgent`.
   * Caps at {@link REVIEW_PROPOSE_LOOP_CAP} and inherits the identical-call
   * no-progress stop. When false, one-shot residual → patch → verify via
   * {@link runCodeSession} (no second loop).
   */
  loop?: boolean;
  /** Injected providers (tests). Skips routing. */
  providers?: Provider[];
  fsImpl?: CodeFs;
  run?: (command: string) => { stdout: string; exitCode: number };
  git?: GitRunner;
  /** Injected HEAD ref (`refs/heads/main` or null when detached). */
  currentRef?: string | null;
  /** Extra default-branch name besides main/master. */
  defaultBranch?: string;
  /** Injectable clock for the correlation id. */
  now?: () => number;
  correlationId?: string;
  sessionId?: string;
  /** Skip the on-disk git checkpoint (tests). */
  noCheckpoint?: boolean;
}

export interface ReviewProposeResult {
  ok: boolean;
  patch: PatchIR | null;
  proposedDiff: string;
  toolTrace: ReviewProposeToolEvent[];
  stopReason: ReviewProposeStopReason;
  applied: boolean;
  checkpoint: { ref: string; commit: string; seq: number } | null;
  provider: { id: string; model: string; fellBack: boolean };
  finalText: string;
  error: string | null;
  correlationId: string;
  steps: number;
}

const DEFAULT_BRANCH_NAMES = new Set(['main', 'master']);

/** Parse `relay:<slug>` or a Code Mode id. Returns null when the id is not one of those. */
export function parseReviewProposeModelId(raw: string): ReviewProposeModel | null {
  const id = (raw ?? '').trim();
  if (!id) return null;
  if (id === 'spark' || id === 'flow' || id === 'forge') return { kind: 'code-mode', mode: id };
  if (id.startsWith('relay:')) {
    const model = id.slice('relay:'.length).trim();
    return model ? { kind: 'relay', model } : null;
  }
  return null;
}

/**
 * True when `ref` names a default branch. Detached HEAD (`null` / empty /
 * literal `HEAD`) is not a default branch — that is the worktree apply surface.
 */
export function isDefaultBranchRef(ref: string | null | undefined, extra?: string): boolean {
  if (!ref || ref === 'HEAD') return false;
  const short = ref.replace(/^refs\/heads\//, '').trim();
  if (!short) return false;
  if (DEFAULT_BRANCH_NAMES.has(short)) return true;
  if (extra) {
    const extraShort = extra.replace(/^refs\/heads\//, '').trim();
    if (extraShort && extraShort === short) return true;
  }
  return false;
}

/** Lift agent file changes into `patch-ir/0`. Empty when nothing mutated. */
export function fileChangesToPatchIR(
  changes: FileChange[],
  options: { modelId?: string | null } = {},
): PatchIR | null {
  const applicable = changes.filter((c) => c.diff !== '');
  if (applicable.length === 0) return null;
  const edits = applicable.map((c) => {
    if (c.before === null && c.after !== null) {
      return { op: 'create' as const, file: c.file, content: c.after };
    }
    if (c.after === null) {
      return { op: 'delete' as const, file: c.file };
    }
    return {
      op: 'replace' as const,
      file: c.file,
      search: c.before ?? '',
      replace: c.after,
    };
  });
  const patch = codeEditsToPatchIR(edits, {
    modelId: options.modelId ?? null,
    format: 'code-edit',
  });
  return patch.operations.length ? patch : null;
}

function fail(
  partial: Partial<ReviewProposeResult> & Pick<ReviewProposeResult, 'stopReason' | 'correlationId'>,
): ReviewProposeResult {
  return {
    ok: false,
    patch: null,
    proposedDiff: '',
    toolTrace: [],
    applied: false,
    checkpoint: null,
    provider: { id: '', model: '', fellBack: false },
    finalText: '',
    error: null,
    steps: 0,
    ...partial,
  };
}

function currentHeadRef(root: string, git: GitRunner): string | null {
  const raw = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout.trim();
  if (!raw || raw === 'HEAD') return null;
  return `refs/heads/${raw}`;
}

function capturingFs(base: CodeFs, persist: boolean): CodeFs {
  return {
    read: (f) => base.read(f),
    write: persist ? (f, c) => base.write(f, c) : () => undefined,
    remove: persist ? (f) => base.remove(f) : () => undefined,
    appendAudit: (line) => base.appendAudit(line),
  };
}

function buildInstruction(input: ReviewProposeInput): string {
  const { finding, capsule, policySnippet } = input;
  const evidence = capsule.evidence.filter((e) => finding.evidence_ids.includes(e.id));
  return [
    'Propose a minimal patch for this Review finding. Do not decide whether the change merges.',
    'Do not claim the result is approved, certified, or vulnerability-free.',
    `Finding ${finding.id} (${finding.kind}, ${finding.severity}, alignment ${finding.target_alignment}): ${finding.claim}`,
    `Remediation: ${finding.remediation}`,
    `Paths: ${finding.paths.join(', ') || '(none)'}`,
    `Schema: ${FINDINGS_SCHEMA}`,
    policySnippet.trim() ? `Policy:\n${policySnippet.trim()}` : 'Policy: (none supplied)',
    `Capsule ${capsule.schema_version} · ${capsule.identity.language} · ${capsule.identity.profile}`,
    evidence.length
      ? `Evidence:\n${evidence.map((e) => `- ${e.id} (${e.kind}${e.path ? ` ${e.path}` : ''})${e.note ? `: ${e.note}` : ''}`).join('\n')}`
      : 'Evidence: (none cited)',
    'Use tools to inspect and edit. When the patch is ready, call finish with a short summary.',
  ].join('\n');
}

/**
 * Route a Review model id. Hosted Review stays on Relay (no local chain).
 * Local Code Modes stay on the Vibgrate manager (no hosted chain).
 */
export function resolveReviewProposeProviders(
  model: ReviewProposeModel,
  deps: { env?: NodeJS.ProcessEnv; modelPath?: string } = {},
): Provider[] {
  const env = deps.env ?? process.env;
  if (model.kind === 'relay') {
    const routed = resolveProviders(
      { provider: 'vibgrate-relay', model: model.model, noFallback: true },
      { env, discover: () => [] },
    );
    // Explicit Relay must not fall through to a local backend — that is the
    // fail-open-to-the-wrong-backend defect Review callers treat as success.
    const primary = routed.providers[0];
    if (!primary || primary.id !== 'vibgrate-relay') {
      throw new CliError(
        `hosted Review expected Vibgrate Relay for relay:${model.model} and did not get it`,
        ExitCode.ENGINE_UNAVAILABLE,
      );
    }
    return [primary];
  }
  const routed = resolveProviders(
    { codeMode: true, model: model.mode, modelPath: deps.modelPath },
    { env },
  );
  const primary = routed.providers[0];
  if (!primary || primary.id !== 'llama-cpp') {
    throw new CliError(
      `local Review expected Code Mode ${model.mode} on the Vibgrate manager and did not get it`,
      ExitCode.ENGINE_UNAVAILABLE,
    );
  }
  return [primary];
}

/**
 * Propose a PatchIR fix for one Review finding by calling {@link runAgent}.
 * Never invents a second loop.
 */
export async function proposeFindingFix(input: ReviewProposeInput): Promise<ReviewProposeResult> {
  const correlationId = input.correlationId ?? `rp-${(input.now ?? Date.now)().toString(36)}`;
  const parsed = parseReviewProposeModelId(input.modelId);
  if (!parsed) {
    return fail({
      stopReason: 'invalid-model',
      correlationId,
      error:
        `unknown model id "${input.modelId}" — use relay:<slug> (hosted Review) or spark|flow|forge (local Code Mode)`,
    });
  }

  const git = input.git ?? defaultGitRun;
  const currentRef = input.currentRef !== undefined ? input.currentRef : currentHeadRef(input.root, git);
  const applyRequested = input.apply === true;
  const consent = input.consent === true;
  const onDefault = isDefaultBranchRef(currentRef, input.defaultBranch);
  const persist = applyRequested && consent && !onDefault;

  let providers: Provider[];
  try {
    providers = input.providers ?? resolveReviewProposeProviders(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail({
      stopReason: 'error',
      correlationId,
      error: msg,
    });
  }

  const baseFs = input.fsImpl ?? nodeCodeFs(input.root);
  const fsImpl = capturingFs(baseFs, persist);

  const toolTrace: ReviewProposeToolEvent[] = [];
  let pendingCall: ReviewProposeToolEvent | undefined;
  let lastCheckpoint: Checkpoint | null = null;
  let seq = 0;
  const sessionId = input.sessionId ?? `review-${correlationId.replace(/[^A-Za-z0-9_-]/g, '')}`;

  const takeCheckpoint = (files: string[]): { ref: string; commit: string; seq: number } | null => {
    if (input.noCheckpoint || !persist) return null;
    seq += 1;
    const cp = createCheckpoint(
      (args) => {
        const r = git(args, input.root);
        return { stdout: r.stdout, exitCode: r.status };
      },
      {
        sessionId,
        seq,
        files,
        indexFile: `${input.root}/.git/vibgrate-review-index`,
        message: `vg review propose checkpoint ${seq}`,
      },
    );
    if (cp) lastCheckpoint = cp;
    return cp;
  };

  const instruction = buildInstruction(input);

  // One-shot residual → patch → verify: the existing governance session.
  // `--loop` (default) reuses runAgent — never a second Review-specific loop.
  if (input.loop === false) {
    const session = await runCodeSession({
      graph: input.graph,
      root: input.root,
      instruction,
      providers,
      apply: persist,
      consent: persist,
      fsImpl,
      capsule: true,
      noAudit: !persist,
      correlationId,
    });
    if (hostedFallbackIsFailure(session.provider)) {
      return fail({
        stopReason: 'fallback-backend',
        correlationId,
        provider: session.provider,
        steps: 1,
        error: `Review refused a fallback backend (${session.provider.id}/${session.provider.model}) — hosted Review stays on Relay; local Review stays on the requested Code Mode`,
      });
    }
    if (persist) {
      takeCheckpoint(session.changes.map((c) => c.file));
    }
    toolTrace.push({ name: 'one-shot-assess', args: { phase: 'inspect-assess-dry-run' } });
    if (persist) toolTrace.push({ name: 'one-shot-verify', args: { ok: session.verification.ok } });
    return finalizePropose({
      input,
      correlationId,
      applyRequested,
      consent,
      onDefault,
      persist,
      currentRef,
      changes: session.changes,
      provider: session.provider,
      finalText: session.verification.detail,
      stopped: session.verification.ok || session.changes.some((c) => c.diff)
        ? 'finished'
        : 'no-patch',
      toolTrace,
      lastCheckpoint,
      steps: 1,
      verifyFailed: persist && !session.verification.ok,
    });
  }

  const agent = await runAgent({
    graph: input.graph,
    root: input.root,
    instruction,
    providers,
    fsImpl,
    run: input.run ?? (() => ({ stdout: '', exitCode: 0 })),
    approve: async () => true,
    maxSteps: REVIEW_PROPOSE_LOOP_CAP,
    overlay: true,
    capsule: true,
    plan: false,
    auto: true,
    noAudit: !persist,
    checkpoint: persist ? takeCheckpoint : undefined,
    onEvent: (e: AgentEvent) => {
      if (e.type === 'tool-call') {
        pendingCall = { name: e.name, args: e.args };
      } else if (e.type === 'tool-result' && pendingCall) {
        toolTrace.push({
          ...pendingCall,
          content: e.content,
          mutated: e.mutated,
          failed: e.failed,
        });
        pendingCall = undefined;
      } else if (e.type === 'checkpoint') {
        lastCheckpoint = { ref: e.ref, commit: e.commit, seq: e.seq, files: e.files };
      }
    },
  });

  return finalizePropose({
    input,
    correlationId,
    applyRequested,
    consent,
    onDefault,
    persist,
    currentRef,
    changes: agent.changes,
    provider: agent.provider,
    finalText: agent.finalText,
    stopped: agent.stopped,
    toolTrace,
    lastCheckpoint,
    steps: agent.steps,
  });
}

function finalizePropose(args: {
  input: ReviewProposeInput;
  correlationId: string;
  applyRequested: boolean;
  consent: boolean;
  onDefault: boolean;
  persist: boolean;
  currentRef: string | null;
  changes: FileChange[];
  provider: { id: string; model: string; fellBack: boolean };
  finalText: string;
  stopped: AgentStop | 'no-patch';
  toolTrace: ReviewProposeToolEvent[];
  lastCheckpoint: Checkpoint | null;
  steps: number;
  verifyFailed?: boolean;
}): ReviewProposeResult {
  const { correlationId, provider, toolTrace, lastCheckpoint } = args;

  if (hostedFallbackIsFailure(provider)) {
    return fail({
      stopReason: 'fallback-backend',
      correlationId,
      provider,
      finalText: args.finalText,
      toolTrace,
      steps: args.steps,
      error: `Review refused a fallback backend (${provider.id}/${provider.model}) — hosted Review stays on Relay; local Review stays on the requested Code Mode`,
    });
  }

  const patch = fileChangesToPatchIR(args.changes, { modelId: args.input.modelId });
  const proposedDiff = args.changes
    .filter((c) => c.diff)
    .map((c) => c.diff)
    .join('\n');
  const validation = patch ? validatePatchIR(patch) : { ok: false, errors: ['no operations'] };

  let stopReason: ReviewProposeStopReason = args.stopped === 'no-patch' ? 'no-patch' : args.stopped;
  let error: string | null = null;
  let ok = false;

  if (args.applyRequested && args.onDefault) {
    stopReason = 'default-branch';
    error = `refused to write the default branch (${args.currentRef ?? 'unknown'}) — propose from a topic branch or a detached worktree (ref ${correlationId})`;
  } else if (args.applyRequested && !args.consent) {
    stopReason = args.stopped === 'finished' && patch && validation.ok ? 'finished' : stopReason;
    error = `apply requested without consent — re-run with --yes to write (ref ${correlationId})`;
  } else if (args.verifyFailed) {
    error = args.finalText || `verify failed (ref ${correlationId})`;
  } else if (args.stopped === 'error' || args.stopped === 'cancelled') {
    error = args.finalText || `agent stopped (${args.stopped}) (ref ${correlationId})`;
  } else if (args.stopped === 'no-tools' || args.stopped === 'no-progress' || args.stopped === 'max-steps') {
    // Edit-ask gate turns plan-only `finish` (0 writes) into agent no-tools.
    // Review's contract for that is no-patch, not a leaked no-tools. Empty
    // replies and no-progress stay themselves.
    const planOnlyFinish =
      args.stopped === 'no-tools' &&
      (!patch || !validation.ok) &&
      args.toolTrace.some((t) => t.name === 'finish');
    if (planOnlyFinish) {
      stopReason = 'no-patch';
      error = `the model finished without a patch (ref ${correlationId})`;
    } else {
      error = args.finalText || `agent stopped (${args.stopped}) (ref ${correlationId})`;
    }
  } else if (!patch || !validation.ok) {
    stopReason = 'no-patch';
    error =
      validation.errors.length && patch
        ? `invalid PatchIR: ${validation.errors.join('; ')} (ref ${correlationId})`
        : `the model finished without a patch (ref ${correlationId})`;
  } else if (args.applyRequested && args.persist && args.stopped === 'finished') {
    ok = true;
  } else if (!args.applyRequested && args.stopped === 'finished') {
    ok = true;
  } else {
    error = args.finalText || `agent stopped (${args.stopped}) (ref ${correlationId})`;
  }

  return {
    ok,
    patch,
    proposedDiff,
    toolTrace,
    stopReason,
    applied: args.persist && ok && !!patch,
    checkpoint: lastCheckpoint ? { ref: lastCheckpoint.ref, commit: lastCheckpoint.commit, seq: lastCheckpoint.seq } : null,
    provider,
    finalText: args.finalText,
    error,
    correlationId,
    steps: args.steps,
  };
}
