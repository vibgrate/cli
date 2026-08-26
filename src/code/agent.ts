/**
 * The VG Code agentic loop (VG-CLI-CODE §12).
 *
 * This is what makes `vg code` a coding *agent* rather than a one-shot proposer:
 * the model is given the tool set (search the graph, read, list, impact, edit,
 * create, delete, run a command) and iterates — call tools, read the results,
 * call more tools — until it calls `finish` (or a step cap is hit). Mutating
 * tools pass through the injected approval gate, so the same governance holds
 * whether you approve each step interactively or run autonomously with `--auto`.
 *
 * For real multi-step sessions it also: writes an append-only, secret-free
 * **audit record** at the end of every run (governance parity with the
 * single-shot path); **compacts the transcript** so a long session stays under
 * the context-rot threshold that is the whole reason the graph exists; and
 * **guards against no-progress loops** so a model that repeats a failing call
 * stops cleanly instead of burning to the step cap.
 *
 * The model is the only non-deterministic seam (behind the provider list, with
 * fallback). Everything else — the loop, tool execution, gating, compaction,
 * guard, audit — is deterministic and unit-tested with a scripted provider.
 */

import { buildCodeContext } from './context.js';
import { rankQuestion, type SanitizedRank } from '../engine/relevance-provider.js';
import { loadTopicTags } from '../engine/relevance-enrich.js';
import {
  buildTaskCapsule,
  capsuleToCodeContext,
  summarizeCapsule,
  CAPSULE_RANKING_VERSION,
  type CapsuleSummary,
  type TaskCapsule,
} from './capsule.js';
import {
  askNamesSymbol,
  buildWholeRepoPacket,
  capsuleMode,
  mappedFilePaths,
  sourceTokenMass,
  type CapsuleMode,
} from './capsule-mode.js';
import { buildCapsuleDelta, isEmptyCapsuleDelta, type CapsuleDelta } from './capsule-delta.js';
import {
  createDiscoveryGateState,
  gateDiscoveryTool,
  recordDiscoveryGateOutcome,
} from './advanced-mode.js';
import { materializeWorktreeGraph } from './worktree-overlay.js';
import { dangerousCommand, readOnlyCommand } from './safety.js';
import { findMatchingRule, ruleLabel, type ApprovalRule } from './approvals.js';
import { buildAgentMessages } from './prompt.js';
import {
  AGENT_TOOLS,
  executeTool,
  type AskUserRequest,
  type MutatingAction,
  type ShellResult,
  type ToolContext,
  type ToolResult,
} from './tools.js';
import { completeOpenProgress } from './progress.js';
import { runShellAsync } from './shell-runner.js';
import { localGraphBackend, type GraphBackend } from './graph-backend.js';
import type { ModelExecutionProfile } from '../runtime/model-execution-profile.js';
import { SessionOverlay } from './overlay.js';
import { materializeSessionGraph } from './session-graph.js';
import { compileVerificationLadder, runVerificationLadder } from './verify-ladder.js';
import { buildFailureCapsule, type FailureCapsule } from './failure-capsule.js';
import {
  createTrajectoryCollector,
  DISCOVERY_TOOLS,
  MUTATION_TOOLS,
  type TrajectoryRecord,
} from './trajectory.js';
import {
  buildRunProvenance,
  CONTEXT_POLICY_VERSION,
  type RunProvenance,
} from './run-provenance.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { repositoryIdFromRoot } from '../runtime/paths.js';
import type { SymbolSpan } from './apply.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, CodeContext, FileChange, ImageAttachment, Provider, ProviderResult, ReasoningEffort, ToolCall, ToolSpec } from './types.js';
import type { VgGraph } from '../schema.js';
import { redactSecrets } from './providers.js';
import {
  answerLocateInstruction,
  isLocateOnlyInstruction,
  sanitizeAgentDisplayText,
} from './locate-answer.js';
import { buildIdentifierTrieFromGraph } from '../runtime/identifier-trie.js';
import type { TrieNode } from '../runtime/identifier-trie.js';
import { graphDraftCandidates, KvBlockRegistry } from '../runtime/kv-cache.js';
import { lookupModelCapabilities } from './model-capabilities.js';
import { userAskFromInstruction } from '../engine/user-ask.js';

export type { CapsuleSummary, RunProvenance };
export { CONTEXT_POLICY_VERSION };

export interface AgentMetrics {
  discoveryToolCalls: number;
  mutationToolCalls: number;
  shellCommands: number;
  znsAt1: boolean;
  usedCapsule: boolean;
  failureCapsuleBuilt: boolean;
  trajectory: TrajectoryRecord;
}

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string; mutated: boolean; failed?: boolean }
  | { type: 'change'; change: FileChange }
  | { type: 'compact'; droppedRounds: number }
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
      /** Prompt tokens served from the provider's cache (absent when unreported). */
      cachedPromptTokens?: number;
    }
  /**
   * Reasoning text from a thinking model, streamed on its own channel so a host
   * can render it as a collapsed trace. Never part of the answer.
   */
  | { type: 'thinking'; text: string }
  | { type: 'verify'; command: string; passed: boolean }
  | { type: 'ladder'; ok: boolean; summary: string }
  | { type: 'session-graph'; reparsed: number; dirty: number }
  | { type: 'step'; n: number }
  | { type: 'capsule'; summary: CapsuleSummary }
  /** Advisory line for the host transcript (e.g. vision downgrade, rules loaded). */
  | { type: 'notice'; text: string }
  /** v4 steer: mid-turn user content joined the transcript at a step boundary. */
  | { type: 'injected'; text: string }
  | { type: 'capsule-delta'; delta: CapsuleDelta }
  | { type: 'failure-capsule'; capsule: FailureCapsule }
  | { type: 'checkpoint'; ref: string; commit: string; seq: number; files: string[] }
  | { type: 'metrics'; metrics: AgentMetrics }
  /** Live shell stream for host UIs (async run_command). */
  | { type: 'command-start'; command: string }
  | { type: 'command-output'; command: string; chunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'command-end'; command: string; exitCode: number; timedOut?: boolean; cancelled?: boolean }
  /** Focus-chain / todo checklist for the panel. */
  | { type: 'progress'; items: Array<{ id: string; title: string; status: string }> };

export interface AgentOptions {
  graph: VgGraph;
  root: string;
  instruction: string;
  providers: Provider[];
  fsImpl: CodeFs;
  /** Run a shell command (injected). Prefer {@link executionEnv} when set. May be async. */
  run: (command: string) => ShellResult | Promise<ShellResult>;
  /**
   * Security ladder substrate for shell (ADR-002). When set, `run_command` and
   * verify steps use `executionEnv.run` instead of the bare `run` callback.
   */
  executionEnv?: {
    tier: string;
    label: string;
    reason: string;
    run: (command: string, opts: { cwd: string }) => ShellResult | Promise<ShellResult>;
  };
  /**
   * When true (default), advertise spawn_subagent and allow one level of child
   * agent under the parent approval gate.
   */
  allowSubagents?: boolean;
  /**
   * When true, `run_command` uses the async streaming shell (live command-output
   * events). Tests that inject a fake `run` leave this false/undefined.
   */
  streamShell?: boolean;
  /**
   * Graph query backend (vgd ActiveGraph when a daemon session is attached).
   * When omitted, tools use the in-process {@link graph}.
   */
  graphBackend?: GraphBackend;
  /** Resolved Model Execution Profile (capsule budget / repair knobs). */
  modelProfile?: ModelExecutionProfile;
  /**
   * Extra pinned facts for Task Capsules (e.g. high-confidence federation
   * bridges). Secret-free strings only.
   */
  extraPinnedFacts?: string[];
  /** Approval gate for mutating actions. */
  approve: (action: MutatingAction) => Promise<boolean>;
  /**
   * Clarifying question for the human (VS Code / stream-json). When omitted,
   * ask_user tells the model to proceed with assumptions.
   */
  askUser?: (req: AskUserRequest) => Promise<string>;
  maxSteps?: number;
  budget?: number;
  /** Approx token budget for the running transcript before it is compacted. */
  contextBudget?: number;
  /** Autonomous mode — enforce the command denylist (no human reviews each call). */
  auto?: boolean;
  /**
   * Plan mode: the run is read-only. Every mutating action is denied engine-side
   * (no approval round-trip), with a tool result telling the model to present a
   * plan instead. Host UIs may additionally prefix the instruction; this flag is
   * the enforcement, the prefix is the styling.
   */
  plan?: boolean;
  /** Images attached to this task (rides on the task turn; multimodal providers encode them). */
  images?: ImageAttachment[];
  /** Project-configured extra denylist rules for autonomous commands. */
  denyCommands?: string[];
  /**
   * Standing allow-always rules (`.vibgrate/code-approvals.json`). Called on
   * every approval — not cached — so an addition ("Always allow") or a
   * revocation (manage UI, editing the file) applies to the very next action.
   * Rules never widen safety: the dangerous-command denylist still screens
   * every match, and plan mode denies before rules are consulted.
   */
  approvalRules?: () => ApprovalRule[];
  /** The project's test/verify command, surfaced to the model. */
  testCommand?: string;
  /** Auto-verify: after the model finishes, run this command and make it fix failures. */
  verify?: { command: string; maxRounds?: number };
  /** Stream assistant tokens as they arrive (emits `token` events). */
  stream?: boolean;
  /** A recap of earlier tasks (from `--continue`) to seed continuity. */
  priorSummary?: string;
  /**
   * The previous turn's instruction (multi-turn REPL / VS Code chat). Feeds
   * capsule seed ranking as damped carry-over vocabulary so a follow-up like
   * "do we support direct debits?" keeps the prior turn's topic; never sent
   * to the model verbatim (priorSummary covers the transcript recap).
   */
  priorInstruction?: string;
  /**
   * When the transcript exceeds the context budget, ask the model to write a
   * structured checkpoint summary of the dropped rounds (Cline/OpenCode-style
   * compaction) instead of the static note. One bounded extra completion per
   * compaction; any failure falls back to the deterministic note. Default off
   * so scripted/offline runs stay deterministic — real-model hosts enable it.
   */
  llmCompaction?: boolean;
  /**
   * Rendered project instructions (AGENTS.md / CLAUDE.md / .vibgrate/rules).
   * Advisory only — see {@link loadProjectRules}; they never widen permissions.
   */
  projectRules?: string;
  /**
   * Take a checkpoint just before an approved change is written, so it can be
   * undone later. Injected, so the loop stays free of git plumbing and testable
   * without a repository. Returning null (no repo, git failure) is normal and
   * never blocks the change.
   */
  checkpoint?: (files: string[]) => { ref: string; commit: string; seq: number } | null;
  /**
   * Cooperative cancellation (VG-CLI-CODE §18.2). Checked between steps, so a
   * host can stop a turn without killing a long-lived session process. Work
   * already approved and applied is kept — this stops the loop, it does not
   * roll back; use a checkpoint to undo.
   */
  signal?: { aborted: boolean };
  /**
   * v4 steer: drain user content injected mid-turn (null when none pending).
   * Checked at each step boundary — the content joins the transcript as a user
   * message before the next model call, announced by an `injected` event, so
   * the user can redirect a running turn without cancelling it.
   */
  takeInjected?: () => string | null;
  /**
   * How hard a reasoning-capable model should think. Passed straight through to
   * the provider, which ignores it when the backend has no such knob — so this
   * is safe to set for every model and the caller never has to detect support.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * External / built-in MCP tools the model may also call (approval-bound for
   * non-read-only remote tools). Always include local `vg serve` tools via
   * {@link createVgBuiltinMcpTools} so the agent has the installed CLI surface.
   */
  externalTools?: {
    specs: ToolSpec[];
    owns: (name: string) => boolean;
    execute: (call: ToolCall, live?: { graph: VgGraph }) => Promise<ToolResult>;
  };
  onEvent?: (e: AgentEvent) => void;
  /** Per-model savings attribution for graph-backed (`search_code`) calls. */
  attribution?: { client: string; provider?: string; model?: string };
  now?: () => number;
  /** Skip the audit record (tests / programmatic dry calls). */
  noAudit?: boolean;
  /**
   * When true (default), build an identifier trie from the graph and pass it to
   * local llama.cpp generations for unknown-identifier annotation.
   */
  identifierMask?: boolean;
  /**
   * Use a source-bearing Task Capsule for the first context (Fusion Runtime
   * Phase 0 A/B). When true, exact source ranges from the graph are included so
   * the model can solve without navigation tool calls (ZNS@1 path). Default
   * false keeps today's metadata-only context.
   */
  capsule?: boolean;
  /**
   * Override auto `off` / `whole-repo` / `compile` (tests and hosts that
   * already decided). When omitted, mass × greppability picks the mode.
   * Ignored unless {@link capsule} is true.
   */
  capsuleMode?: CapsuleMode;
  /** Restrict context seeds to these files (from `--file`), if given. */
  files?: string[];
  /**
   * Buffer mutations in a session overlay (Phase 5). Reads see uncommitted
   * edits; the overlay is flushed before shell commands and when the run ends.
   * Default true under capsule mode, false otherwise. Set false to write the
   * base fs immediately (legacy).
   */
  overlay?: boolean;
  /**
   * Run the graph-derived verification ladder on finish (syntax + optional
   * testCommand). Default true when capsule context is used.
   */
  verifyLadder?: boolean;
  /**
   * Free use of low-level discovery tools. Default **true** (full coding agent).
   * When false, early discovery is soft-nudged then hard-capped until a mutation
   * or inspect_change (legacy capsule-first ZNS@1 path for tiny local models).
   * Task Capsules still ground the first turn either way — they are context, not
   * a substitute for tools.
   */
  advancedMode?: boolean;
  /**
   * Reparse git-dirty worktree files into the graph before the agent loop
   * (base ⊕ worktree). Default false (tests / CI stay offline-fast). Interactive
   * and stream-json enable this so the map matches uncommitted edits.
   */
  worktreeOverlay?: boolean;
  /**
   * When true, pure locate/URL-occurrence asks answer from the hybrid literal
   * sweep without calling the model. Default **false**: VG Code is a full coding
   * agent — build the capsule, send the task to the model, and let it choose
   * tools (search_code, finish, edits). Opt-in only for offline/CI shortcuts.
   */
  deterministicLocate?: boolean;
}

export type AgentStop = 'finished' | 'max-steps' | 'no-tools' | 'no-progress' | 'error' | 'cancelled';

export interface AgentResult {
  finalText: string;
  changes: FileChange[];
  steps: number;
  stopped: AgentStop;
  provider: { id: string; model: string; fellBack: boolean };
  /** Total tokens the model reported over the run (for the cost meter). */
  usage: { promptTokens: number; completionTokens: number };
  /** Trajectory / ZNS metrics for FCS reporting. */
  metrics?: AgentMetrics;
  /** Last Failure Capsule built during this run (if any). */
  failureCapsule?: FailureCapsule | null;
  /** Capsule summary when capsule mode was used. */
  capsuleSummary?: CapsuleSummary | null;
  /**
   * Run provenance (run-provenance/0): policy pin, ranking, model profile,
   * security tier, graph corpus, and content-hashed mutations.
   */
  provenance?: RunProvenance;
}

const DEFAULT_MAX_STEPS = 24;
/** Compact the transcript once it grows past this many estimated tokens. */
const DEFAULT_CONTEXT_BUDGET = 16_000;
/** Rounds (assistant + its tool results) to keep verbatim when compacting. */
const KEEP_ROUNDS = 8;
/** After this many identical, non-progressing repeats, nudge the model. */
const NUDGE_AT = 3;
/** After this many, stop the run as no-progress. */
const STOP_AT = 5;
/** Empty / non-prose no-tool replies tolerated (nudge + retry) before stopping. */
const EMPTY_REPLY_RETRIES = 2;
/**
 * Continuations allowed when the model stops on the output cap rather than
 * because it finished (`finish_reason: 'length'`). Without this the tail of a
 * long answer is simply lost — the user sees a reply that stops mid-sentence
 * and nothing says why. Bounded: a model that cannot finish in three caps'
 * worth of output is not going to, and the partial answer is still shown with
 * an explicit truncation note.
 */
const TRUNCATED_REPLY_CONTINUES = 2;
/**
 * Extra attempts granted when a reply carried *reasoning but no answer*. A
 * reasoning model that spends its output budget thinking is still working, so
 * charging those turns to EMPTY_REPLY_RETRIES ended the run after ~3 steps with
 * nothing on screen but thinking traces. Bounded for the same reason as above:
 * a model that has thought this many times without writing a word is stuck, and
 * the run stops with an explanation rather than an empty reply.
 */
const REASONING_ONLY_RETRIES = 3;

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { root, instruction, providers } = options;
  let graph = options.graph;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  // MEP capsule budget can raise the first-context budget when not explicitly set.
  const budget =
    options.budget ??
    options.modelProfile?.capsuleBudgetTokens ??
    3000;
  const contextBudget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const now = options.now ?? (() => 0);
  const onEvent = options.onEvent ?? (() => {});
  const verifyConfig =
    options.verify && options.modelProfile?.maxRepairRounds != null && options.verify.maxRounds == null
      ? { ...options.verify, maxRounds: options.modelProfile.maxRepairRounds }
      : options.verify;

  // Identifier trie for local constrained backends (Approach B); optional off switch.
  const identifierTrie: TrieNode | undefined =
    options.identifierMask === false ? undefined : buildIdentifierTrieFromGraph(graph);
  // Capsule/system prefix KV plan registry for host-level reuse (planning layer).
  const kvRegistry = new KvBlockRegistry();
  // Speculative drafts: verbatim signatures / qualified names the graph already knows.
  const draftCandidates = graphDraftCandidates(
    graph.nodes
      .flatMap((n) => [n.signature, n.qualifiedName, n.name].filter(Boolean) as string[])
      .filter((s) => s.includes('(') || s.includes('function') || s.includes('class') || s.length > 12),
    12,
  );

  // Worktree overlay: reparse git-dirty files so the map matches the working tree.
  const useWorktree = options.worktreeOverlay === true;
  if (useWorktree) {
    try {
      const wt = await materializeWorktreeGraph(graph, root);
      if (wt.reparsed.length || wt.deleted.length) {
        graph = wt.graph;
        onEvent({
          type: 'session-graph',
          reparsed: wt.reparsed.length,
          dirty: wt.dirtyFiles.length,
        });
      }
    } catch {
      /* worktree overlay is best-effort */
    }
  }

  // Session overlay: tools read/write the overlay; shell + finish flush to base.
  const useOverlay = options.overlay ?? !!options.capsule;
  const overlay = useOverlay ? new SessionOverlay(options.fsImpl) : null;
  const fsImpl: CodeFs = overlay ?? options.fsImpl;
  const flushOverlay = (): void => {
    overlay?.flush();
  };

  // Full coding agent: free discovery by default. Capsule is first-turn evidence,
  // not a lock on tools. Opt into advancedMode:false only for tiny local packs.
  const advancedMode = options.advancedMode ?? true;
  const discoveryGate = createDiscoveryGateState();

  const allowSubagents = options.allowSubagents !== false && !options.plan;
  const agentToolSpecs = allowSubagents
    ? AGENT_TOOLS
    : AGENT_TOOLS.filter((t) => t.name !== 'spawn_subagent');
  const allTools = [...agentToolSpecs, ...(options.externalTools?.specs ?? [])];
  // The relevance module ranks the seeds when installed (auto-provisioned);
  // null → the mechanical fallback. Computed once per run and reused by the
  // capsule-delta recompile below.
  // Ranking sees the user ask only — attachment basenames/paths must not
  // become topics or seeds (same strip as buildCodeContext / literal-locate).
  const topicTags = await loadTopicTags(graph, options.root);
  const ranked = await rankQuestion(graph, userAskFromInstruction(instruction), {
    limit: 48,
    priorQuestion: options.priorInstruction ? userAskFromInstruction(options.priorInstruction) : null,
    topicTags,
  });
  const built = buildAgentContext(graph, instruction, { ...options, fsImpl, budget, ranked });
  const context = built.context;
  let capsule = built.capsule;
  const useLadder = options.verifyLadder ?? !!capsule;
  const messages: ChatMessage[] = buildAgentMessages(context);
  // Attach any user-uploaded images to the task turn; multimodal providers
  // encode them on the wire, text-only backends see the naming text instead.
  // Vision negotiation: when the routed model is *known* to be blind, drop the
  // pixels (some backends reject image parts outright) and say so — the
  // prompt's on-disk reference block still names each attachment. Unknown
  // models get the images; the encoders degrade harmlessly.
  if (options.images?.length) {
    const caps = lookupModelCapabilities(providers[0]?.model);
    if (caps.vision === false) {
      onEvent({
        type: 'notice',
        text: `${providers[0]?.model ?? 'the selected model'} cannot view images — attached image(s) are referenced by name/path only. Pick a vision-capable model to have it read the pixels.`,
      });
    } else {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        messages[messages.length - 1] = { ...last, images: options.images };
      }
    }
  }
  // Project instructions sit after the repo context and before the recap: the
  // model should read house style before it reads what it already did.
  if (options.projectRules) {
    messages.push({ role: 'user', content: options.projectRules });
  }
  if (options.priorSummary) {
    messages.push({ role: 'user', content: options.priorSummary });
  }
  if (options.testCommand) {
    messages.push({ role: 'user', content: `When you want to verify a change, the project's test command is: \`${options.testCommand}\`` });
  }
  const spans = buildSpanIndex(graph);

  const changes: FileChange[] = [];
  const repeats = new Map<string, number>();
  let emptyReplies = 0;
  /** Replies that carried reasoning but no answer and no tool call. */
  let reasoningOnlyReplies = 0;
  /** Continuations spent recovering the tail of cap-truncated replies this run. */
  let truncatedContinues = 0;
  /** Text already emitted for a reply the cap cut short, awaiting its remainder. */
  let truncatedPrefix = '';
  let recordedSearch = false;
  let commandCount = 0;
  let verifyRounds = verifyConfig?.maxRounds ?? 2;
  let lastVerifyPassed = true;
  /** Last verification ladder / command outcomes for run provenance. */
  let lastVerification: Array<{
    kind: string;
    command?: string | null;
    passed: boolean;
    diagnostic?: string | null;
  }> = [];
  let lastFailureCapsule: FailureCapsule | null = null;
  const usage = { promptTokens: 0, completionTokens: 0 };
  let providerInfo = { id: providers[0]?.id ?? 'none', model: providers[0]?.model ?? '', fellBack: false };
  const trajectory = createTrajectoryCollector();
  let currentStep = 0;
  const capsuleSummary = capsule ? summarizeCapsule(capsule) : null;
  if (capsuleSummary) onEvent({ type: 'capsule', summary: capsuleSummary });

  // Opt-in only: short-circuit pure locate asks without a model. Default is off —
  // we never second-guess chat intent; the model + search_code own occurrence Q&A.
  if (options.deterministicLocate === true && isLocateOnlyInstruction(instruction)) {
    try {
      const locate = await answerLocateInstruction(graph, root, instruction, 30);
      providerInfo = { id: 'deterministic-locate', model: 'literal-sweep', fellBack: false };
      onEvent({ type: 'assistant', text: locate.summary });
      const traj = trajectory.finalize({
        taskId: instruction.slice(0, 48),
        arm: capsule ? 'capsule' : 'metadata',
        solved: true,
        verified: true,
        steps: 0,
        stopped: 'finished',
        inferenceTurns: 0,
        filesChanged: 0,
        usedCapsule: !!capsule,
        provider: { id: 'deterministic-locate', model: 'literal-sweep' },
      });
      const earlyMetrics: AgentMetrics = {
        discoveryToolCalls: 0,
        mutationToolCalls: 0,
        shellCommands: 0,
        znsAt1: true,
        usedCapsule: !!capsule,
        failureCapsuleBuilt: false,
        trajectory: traj,
      };
      onEvent({ type: 'metrics', metrics: earlyMetrics });
      return {
        finalText: locate.summary,
        changes: [],
        steps: 0,
        stopped: 'finished',
        provider: providerInfo,
        usage,
        metrics: earlyMetrics,
        failureCapsule: null,
        capsuleSummary,
        provenance: buildRunProvenance({
          modelProfileId: options.modelProfile?.id ?? capsule?.provenance.modelProfileId ?? null,
          securityTier:
            options.executionEnv?.tier ?? options.modelProfile?.securityTier ?? capsule?.provenance.securityTier ?? null,
          graphCorpusHash: capsule?.provenance.graphCorpusHash ?? graph.provenance?.corpusHash ?? null,
          rankingVersion: capsule?.provenance.rankingVersion ?? CAPSULE_RANKING_VERSION,
          policyVersion: capsule?.provenance.policyVersion ?? CONTEXT_POLICY_VERSION,
          changes: [],
          verification: [],
        }),
      };
    } catch {
      /* fall through to the model loop if the tree scan fails */
    }
  }

  const runShell = (command: string): ShellResult | Promise<ShellResult> => {
    if (options.executionEnv) return options.executionEnv.run(command, { cwd: root });
    if (options.streamShell) {
      return runShellAsync(command, {
        cwd: root,
        onChunk: (chunk, stream) => {
          onEvent({ type: 'command-output', command, chunk, stream });
        },
      });
    }
    return options.run(command);
  };

  /** Files a mutating action will touch, for the checkpoint record. */
  const actionFiles = (action: MutatingAction): string[] => {
    if (action.kind === 'patch') return action.files.map((f) => f.file);
    return 'file' in action && action.file ? [action.file] : [];
  };

  /**
   * Approval gate, plus a checkpoint. The snapshot is taken *after* the user
   * consents and *before* the write lands, so restoring returns the tree to
   * the state it was in just before this change — which is what "undo this
   * edit" has to mean. Snapshots only happen for changes that touch files;
   * a command approval has nothing to restore.
   */
  /**
   * Approval short-circuits that never widen safety (P2): a positively
   * read-only command (`git status`) skips the card the way read-only tools
   * always have, and a standing allow-always rule the user created skips it
   * with a visible notice. Both still screen through the dangerous-command
   * denylist, and plan mode denies before this is ever consulted.
   */
  const autoApproval = (action: MutatingAction): { note: string | null } | null => {
    if (action.kind === 'run' && dangerousCommand(action.command, options.denyCommands)) return null;
    if (action.kind === 'run' && readOnlyCommand(action.command)) return { note: null };
    const rules = options.approvalRules?.();
    if (rules?.length) {
      const rule = findMatchingRule(action, rules);
      if (rule) return { note: `Auto-approved by standing rule: ${ruleLabel(rule)}` };
    }
    return null;
  };

  const approveAndCheckpoint = async (action: MutatingAction): Promise<boolean> => {
    // Plan mode is read-only, enforced here — no approval round-trip, no write.
    if (options.plan) return false;
    let approved: boolean;
    const shortCircuit = autoApproval(action);
    if (shortCircuit) {
      approved = true;
      if (shortCircuit.note) onEvent({ type: 'notice', text: shortCircuit.note });
    } else {
      approved = await options.approve(action);
    }
    if (!approved || !options.checkpoint) return approved;
    const files = actionFiles(action);
    if (!files.length) return approved;
    try {
      const cp = options.checkpoint(files);
      if (cp) onEvent({ type: 'checkpoint', ...cp, files });
    } catch {
      /* a checkpoint is a convenience — never fail an approved change over it */
    }
    return approved;
  };

  const ctx: ToolContext = {
    root,
    graph,
    fsImpl,
    spans,
    run: runShell,
    onShellStream: (ev) => {
      if (ev.phase === 'start') onEvent({ type: 'command-start', command: ev.command });
      else if (ev.phase === 'chunk') {
        onEvent({
          type: 'command-output',
          command: ev.command,
          chunk: ev.chunk,
          stream: ev.stream,
        });
      } else if (ev.phase === 'end') {
        onEvent({
          type: 'command-end',
          command: ev.command,
          exitCode: ev.exitCode,
          timedOut: ev.timedOut,
          cancelled: ev.cancelled,
        });
      }
    },
    approve: approveAndCheckpoint,
    askUser: options.askUser,
    auto: options.auto,
    denyCommands: options.denyCommands,
    capsule,
    getTaskCapsule: () => capsule,
    graphBackend: options.graphBackend,
    dirtyFiles: () => (overlay ? overlay.dirtyFiles() : []),
    changedFiles: () => changes.map((c) => c.file),
    // B3: enforce-before-apply against the live graph trie.
    identifierTrie: identifierTrie ?? null,
    enforceIdentifiers: options.identifierMask !== false,
    progress: undefined,
    onProgress: (state) => {
      onEvent({
        type: 'progress',
        items: state.items.map((i) => ({ id: i.id, title: i.title, status: i.status })),
      });
    },
    subagentHost: {
      providers,
      allowSubagents,
      depth: 0,
      onEvent: (e) => {
        if (e.type === 'notice' || e.type === 'tool-call' || e.type === 'tool-result' || e.type === 'change') {
          onEvent(e as AgentEvent);
        }
      },
    },
  };

  /** Recompute the tool-visible graph from the session overlay after mutations. */
  const refreshSessionGraph = async (): Promise<void> => {
    if (!overlay || !overlay.isDirty()) return;
    try {
      const session = await materializeSessionGraph(graph, overlay);
      ctx.graph = session.graph;
      // Uncommitted overlay content is only on the local session graph — not in vgd.
      ctx.graphBackend = localGraphBackend(session.graph);
      // Keep enforce trie aligned with session-visible symbols (new symbols from approved edits become legal).
      if (options.identifierMask !== false) {
        ctx.identifierTrie = buildIdentifierTrieFromGraph(session.graph);
      }
      const next = buildSpanIndex(session.graph);
      ctx.spans.clear();
      for (const [k, v] of next) ctx.spans.set(k, v);
      onEvent({ type: 'session-graph', reparsed: session.reparsed.length, dirty: session.deleted.length + session.rewritten.length });
      // Capsule delta: recompile from session-visible files when capsule mode is on.
      if (options.capsule && capsule) {
        try {
          // Re-rank against the SESSION graph: approved edits may have added
          // or renamed symbols, and seed ids must belong to the graph the
          // capsule is compiled from.
          const nextRanked = await rankQuestion(session.graph, userAskFromInstruction(instruction), {
            limit: 48,
            priorQuestion: options.priorInstruction ? userAskFromInstruction(options.priorInstruction) : null,
            topicTags: await loadTopicTags(session.graph, root),
          });
          const nextCapsule = buildTaskCapsule(session.graph, instruction, {
            budget,
            files: options.files,
            ranked: nextRanked,
            readFile: (rel) => fsImpl.read(rel),
            repositoryId: repositoryIdFromRoot(root),
            provenance: {
              modelProfileId: options.modelProfile?.id ?? null,
              securityTier: options.executionEnv?.tier ?? options.modelProfile?.securityTier ?? null,
            },
          });
          const delta = buildCapsuleDelta(capsule, nextCapsule);
          capsule = nextCapsule;
          ctx.capsule = nextCapsule;
          if (!isEmptyCapsuleDelta(delta)) {
            onEvent({ type: 'capsule-delta', delta });
            messages.push({ role: 'user', content: delta.rendered.slice(0, 6000) });
          }
        } catch {
          /* capsule refresh is best-effort */
        }
      }
    } catch {
      /* session graph is best-effort — keep baseline map */
    }
  };

  const emitFailure = (fc: FailureCapsule): void => {
    lastFailureCapsule = fc;
    trajectory.markFailureCapsule();
    onEvent({ type: 'failure-capsule', capsule: fc });
  };

  /** Single terminal path: flush overlay, write audit once, then return. */
  const finish = (stopped: AgentStop, finalText: string, steps: number): AgentResult => {
    flushOverlay();
    const solved = stopped === 'finished' && lastVerifyPassed;
    const traj = trajectory.finalize({
      taskId: options.attribution?.client ? `${options.attribution.client}:${instruction.slice(0, 40)}` : instruction.slice(0, 48),
      arm: capsule ? 'capsule' : 'metadata',
      solved,
      verified: lastVerifyPassed,
      steps,
      stopped,
      inferenceTurns: currentStep || steps,
      filesChanged: changes.length,
      usedCapsule: !!capsule,
      provider: { id: providerInfo.id, model: providerInfo.model },
    });
    const metrics: AgentMetrics = {
      discoveryToolCalls: traj.discoveryToolCalls,
      mutationToolCalls: traj.mutationToolCalls,
      shellCommands: traj.shellCommands,
      znsAt1: traj.znsAt1,
      usedCapsule: !!capsule,
      failureCapsuleBuilt: traj.failureCapsuleBuilt,
      trajectory: traj,
    };
    onEvent({ type: 'metrics', metrics });
    const result: AgentResult = {
      finalText,
      changes,
      steps,
      stopped,
      provider: providerInfo,
      usage,
      metrics,
      failureCapsule: lastFailureCapsule,
      capsuleSummary: capsule ? summarizeCapsule(capsule) : capsuleSummary,
      provenance: buildRunProvenance({
        modelProfileId: options.modelProfile?.id ?? capsule?.provenance.modelProfileId ?? null,
        securityTier:
          options.executionEnv?.tier ?? options.modelProfile?.securityTier ?? capsule?.provenance.securityTier ?? null,
        graphCorpusHash: capsule?.provenance.graphCorpusHash ?? graph.provenance?.corpusHash ?? null,
        rankingVersion: capsule?.provenance.rankingVersion ?? CAPSULE_RANKING_VERSION,
        policyVersion: capsule?.provenance.policyVersion ?? CONTEXT_POLICY_VERSION,
        changes,
        verification: lastVerification,
      }),
    };
    if (!options.noAudit) {
      writeAgentAudit(
        options.fsImpl,
        {
          instruction,
          providerInfo,
          changes,
          commandCount,
          steps,
          stopped,
          provenance: result.provenance,
        },
        now(),
      );
    }
    return result;
  };

  /**
   * On finish: graph-derived ladder (syntax / hints / testCommand), then optional
   * explicit verify command. Failure feeds a Failure Capsule + retries while rounds remain.
   */
  const verifyOnFinish = async (): Promise<'retry' | 'done'> => {
    if (changes.length === 0) return 'done';

    if (useLadder && capsule) {
      const steps = compileVerificationLadder(capsule.verificationPlan, {
        testCommand: verifyConfig?.command ?? options.testCommand,
      });
      // Shell steps need real files — flush before the ladder.
      flushOverlay();
      const ladder = await runVerificationLadder(steps, {
        readFile: (f) => options.fsImpl.read(f),
        run: runShell,
        // Prefer the dedicated verify command path below when both are set, so we
        // don't double-run the same test command.
        runCommands: !verifyConfig?.command,
      });
      const summary = ladder.steps.map((s) => `${s.ok ? '✔' : '✗'} ${s.message}`).join('\n');
      onEvent({ type: 'ladder', ok: ladder.ok, summary });
      lastVerification = ladder.steps.map((s) => ({
        kind: s.step?.kind ?? 'ladder',
        command: s.step && 'command' in s.step ? (s.step as { command?: string }).command ?? null : null,
        passed: !!s.ok,
        diagnostic: s.message ?? null,
      }));
      if (!ladder.ok) {
        lastVerifyPassed = false;
        const fc = buildFailureCapsule({
          ladderSteps: ladder.steps,
          capsule,
          changedFiles: changes.map((c) => c.file),
          modelId: providerInfo.model,
          policyVersion: CONTEXT_POLICY_VERSION,
        });
        emitFailure(fc);
        if (verifyRounds <= 0) return 'done';
        verifyRounds--;
        messages.push({
          role: 'user',
          content: `The task isn't finished — verification ladder failed.\n\n${fc.rendered.slice(0, 8000)}\n\nFix the issues, then call finish again.${verifyRounds === 0 ? ' (last verification attempt)' : ''}`,
        });
        return 'retry';
      }
    }

    const v = verifyConfig;
    if (!v || verifyRounds <= 0) {
      lastVerifyPassed = true;
      return 'done';
    }
    flushOverlay();
    const res = await Promise.resolve(runShell(v.command));
    onEvent({ type: 'verify', command: v.command, passed: res.exitCode === 0 });
    lastVerification = [
      ...lastVerification,
      {
        kind: 'command',
        command: v.command,
        passed: res.exitCode === 0,
        diagnostic: res.stdout?.slice(0, 4000) ?? null,
      },
    ];
    if (res.exitCode === 0) {
      lastVerifyPassed = true;
      return 'done';
    }
    lastVerifyPassed = false;
    const fc = buildFailureCapsule({
      verify: { command: v.command, exitCode: res.exitCode, stdout: res.stdout },
      capsule,
      changedFiles: changes.map((c) => c.file),
      modelId: providerInfo.model,
      policyVersion: CONTEXT_POLICY_VERSION,
    });
    emitFailure(fc);
    verifyRounds--;
    messages.push({
      role: 'user',
      content: `The task isn't finished — \`${v.command}\` failed (exit ${res.exitCode}).\n\n${fc.rendered.slice(0, 8000)}\n\nFix the failing tests, then call finish again.${verifyRounds === 0 ? ' (last verification attempt)' : ''}`,
    });
    return 'retry';
  };

  for (let step = 1; step <= maxSteps; step++) {
    // Cooperative cancel: checked before any model call or tool, so a stopped
    // turn never starts new work. Applied mutations stay applied.
    if (options.signal?.aborted) {
      return finish('cancelled', 'stopped at your request', step - 1);
    }
    currentStep = step;
    onEvent({ type: 'step', n: step });

    // Steer (v4): content the user sent mid-turn joins the conversation here,
    // before the next model call, so the running turn changes course instead
    // of finishing the stale plan first.
    const injected = options.takeInjected?.();
    if (injected) {
      onEvent({ type: 'injected', text: injected });
      messages.push({
        role: 'user',
        content: `[The user sent this while you were working — factor it in before continuing:]\n${injected}`,
      });
    }

    // Keep the transcript under the budget: preserve the cache-stable prefix
    // (system + graph context + task) and the recent rounds, summarize the rest.
    const compacted = options.llmCompaction
      ? await compactWithModel(messages, contextBudget, changes, (transcript) =>
          summarizeForCompaction(providers, transcript),
        )
      : compact(messages, contextBudget, changes);
    if (compacted.droppedRounds > 0) {
      messages.length = 0;
      messages.push(...compacted.messages);
      onEvent({ type: 'compact', droppedRounds: compacted.droppedRounds });
    }

    let result: ProviderResult;
    try {
      // Mark stable prefix blocks warm after first turn for KV plan metrics (no native KV yet).
      if (kvRegistry.size() === 0 && messages.length >= 2) {
        kvRegistry.commit(
          messages.slice(0, Math.min(3, messages.length)).map((m, i) => ({
            kind: i === 0 ? 'system' : 'context',
            text: typeof m.content === 'string' ? m.content : '',
          })),
        );
      }
      const promptSegments = messages.map((m, i) => ({
        kind: m.role === 'system' ? 'system' : i < 3 ? 'context' : m.role === 'user' ? 'user' : 'assistant',
        text: typeof m.content === 'string' ? m.content : '',
      }));
      // Full agent path: never attach turn-level PatchIR GBNF. Edits go through
      // tools (edit_file / apply_patch); the model chooses answer vs mutate.
      const c = await complete(
        providers,
        messages,
        allTools,
        onEvent,
        options.stream,
        options.modelProfile,
        identifierTrie,
        draftCandidates,
        promptSegments,
        options.reasoningEffort,
      );
      result = c.result;
      providerInfo = { id: c.provider.id, model: c.provider.model, fellBack: c.fellBack };
    } catch (e) {
      const msg = redactSecrets((e as Error).message);
      onEvent({ type: 'assistant', text: `error: ${msg}` });
      return finish('error', msg, step);
    }

    // Accumulate token usage for the cost meter.
    if (result.usage) {
      usage.promptTokens += result.usage.promptTokens ?? 0;
      usage.completionTokens += result.usage.completionTokens ?? 0;
      trajectory.recordUsage(result.usage.promptTokens ?? 0, result.usage.completionTokens ?? 0);
      onEvent({
        type: 'usage',
        promptTokens: result.usage.promptTokens ?? 0,
        completionTokens: result.usage.completionTokens ?? 0,
        ...(result.usage.cachedPromptTokens !== undefined
          ? { cachedPromptTokens: result.usage.cachedPromptTokens }
          : {}),
      });
    }

    const displayText = sanitizeAgentDisplayText(result.text ?? '');
    if (displayText) onEvent({ type: 'assistant', text: displayText });

    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: result.text });

      // The provider stopped on the output cap, so this text is a prefix of the
      // answer rather than the answer. Ask for the remainder and stitch it on —
      // otherwise the reply simply ends mid-sentence with nothing to say why.
      if (result.truncated && truncatedContinues < TRUNCATED_REPLY_CONTINUES && step < maxSteps) {
        truncatedContinues++;
        // Accumulate RAW text, not the trimmed display copy: the continuation
        // resumes mid-sentence, so the whitespace at the seam is part of the
        // answer. Sanitizing per-chunk would glue "starts" to "with".
        truncatedPrefix += result.text ?? '';
        messages.push({
          role: 'user',
          content:
            'Your previous message was cut off at the output limit. Continue it from exactly where it stopped. ' +
            'Do not repeat what you already wrote and do not restart the answer.',
        });
        continue;
      }

      // Whatever survived earlier continuations belongs in front of this reply,
      // sanitized once over the joined text rather than per fragment.
      const fullText = truncatedPrefix
        ? sanitizeAgentDisplayText(truncatedPrefix + (result.text ?? ''))
        : displayText;
      const stillTruncated = !!result.truncated;
      truncatedPrefix = '';

      // Clean prose/Markdown answer (Q&A, explanations) is a successful finish —
      // same as Claude Code free-text, not a failed no-tools dump.
      if (isUserFacingProse(fullText)) {
        return finish(
          'finished',
          stillTruncated
            ? `${fullText}\n\n_(Answer cut short at the model's output limit after ${truncatedContinues + 1} attempts — ask a narrower question, or raise the output cap, to see the rest.)_`
            : fullText,
          step,
        );
      }
      // An empty or non-prose reply (weak/local models do this) is not an
      // answer — the user would see nothing. Nudge and retry before giving up.
      //
      // A reasoning model that returned *only* reasoning is a distinct case: it
      // is thinking, not failing, so it gets its own budget on top of the empty
      // reply retries. Otherwise a run reads as "six thinking blocks and then
      // nothing" — the model never got a turn in which to write the answer.
      const reasoningOnly = displayText.trim().length === 0 && !!result.reasoning?.trim();
      if (reasoningOnly) reasoningOnlyReplies++;
      else emptyReplies++;
      const retriesLeft = reasoningOnly
        ? reasoningOnlyReplies <= REASONING_ONLY_RETRIES
        : emptyReplies <= EMPTY_REPLY_RETRIES;
      if (retriesLeft && step < maxSteps) {
        messages.push({
          role: 'user',
          content: reasoningOnly
            ? 'You produced reasoning but no visible reply. Reasoning is never shown as the answer. ' +
              'Stop thinking and act now: call a tool, or write the answer to the task in plain Markdown.'
            : displayText.trim().length === 0
              ? 'Your last reply was empty. Either call a tool to keep working, or answer the task in plain Markdown now.'
              : 'Your last reply was neither a tool call nor a readable answer. Do not emit raw JSON or templates — call a tool, or answer the task in plain Markdown.',
        });
        continue;
      }
      // Terminal text is never empty: a silent finish is exactly the failure
      // this branch exists to report, and every host renders `finalText`.
      return finish(
        'no-tools',
        fullText ||
          (reasoningOnlyReplies > 0
            ? `The model (${providerInfo.model}) kept reasoning without ever writing an answer (${reasoningOnlyReplies} reasoning-only reply/replies` +
              `${emptyReplies > 0 ? `, ${emptyReplies} empty reply/replies` : ''}). ` +
              'Lower the reasoning effort, raise the output limit, or re-ask with a more specific instruction.'
            : `The model (${providerInfo.model}) returned no usable output after ${emptyReplies} attempt(s). Try a stronger model, or re-ask with a more specific instruction.`),
        step,
      );
    }
    emptyReplies = 0;
    reasoningOnlyReplies = 0;
    truncatedPrefix = '';

    messages.push({ role: 'assistant', content: result.text, toolCalls });

    for (const call of toolCalls) {
      onEvent({ type: 'tool-call', name: call.name, args: call.arguments });
      if (call.name === 'search_code' && options.attribution?.client && !recordedSearch) {
        recordedSearch = true;
        recordSearchSaving(root, context, options.attribution, now());
      }

      // Shell commands see the real tree — flush session overlay first.
      if (call.name === 'run_command') flushOverlay();

      // Capsule-first discovery policy (soft nudge / hard cap).
      if (!options.externalTools?.owns(call.name)) {
        const gate = gateDiscoveryTool(call.name, discoveryGate, { advancedMode });
        if (!gate.allow) {
          const blocked = { content: gate.reason, mutated: false };
          onEvent({ type: 'tool-result', name: call.name, content: blocked.content, mutated: false });
          messages.push({ role: 'tool', content: blocked.content, toolCallId: call.id, name: call.name });
          continue;
        }
        if (gate.note) {
          // Note applied after the tool result below.
          (call as { __gateNote?: string }).__gateNote = gate.note;
        }
      }

      const toolResult = options.externalTools?.owns(call.name)
        ? await options.externalTools.execute(call, { graph: ctx.graph })
        : await executeTool(call, ctx);
      if (!options.externalTools?.owns(call.name)) {
        recordDiscoveryGateOutcome(call.name, discoveryGate, { mutated: toolResult.mutated });
      }
      const gateNote = (call as { __gateNote?: string }).__gateNote;
      if (gateNote) toolResult.content = `${toolResult.content}\n\n${gateNote}`;
      if (call.name === 'run_command' && toolResult.mutated) commandCount++;
      if (toolResult.change) {
        changes.push(toolResult.change);
        onEvent({ type: 'change', change: toolResult.change });
      }
      // After an approved mutation, refresh the session graph so subsequent
      // search_code / graph_impact see uncommitted overlay content.
      if (toolResult.mutated && !toolResult.finished) {
        await refreshSessionGraph();
      }

      // No-progress guard: a mutating call is progress (reset); a repeated
      // non-mutating identical call accumulates → nudge, then stop.
      const sig = `${call.name}:${stableArgs(call.arguments)}`;
      let content = toolResult.content;
      let stopNoProgress = false;
      if (toolResult.mutated || toolResult.finished) {
        repeats.delete(sig);
      } else {
        const n = (repeats.get(sig) ?? 0) + 1;
        repeats.set(sig, n);
        if (n >= STOP_AT) stopNoProgress = true;
        else if (n >= NUDGE_AT) content += `\n\n(note: you have called this exact tool call ${n} times with no change — try a different approach, read more context, or call finish.)`;
      }

      trajectory.recordTool(call.name, step, toolResult.mutated);
      onEvent({ type: 'tool-result', name: call.name, content, mutated: toolResult.mutated, ...(toolResult.failed ? { failed: true } : {}) });
      messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });

      if (toolResult.finished) {
        // Auto-verify: on failure, keep going so the model fixes it.
        if ((await verifyOnFinish()) === 'retry') break;
        // Successful finish: close any open checklist items so the host panel
        // does not stick on "Progress N-1/N" after the answer is already in.
        // Abort keeps open items as-is (work was not completed).
        if (call.name === 'finish' && ctx.progress?.items.length) {
          const completed = completeOpenProgress(ctx.progress);
          if (completed !== ctx.progress) {
            ctx.progress = completed;
            ctx.onProgress?.(completed);
          }
        }
        return finish('finished', toolResult.finalSummary ?? 'done', step);
      }
      if (stopNoProgress) return finish('no-progress', `stopped: the model repeated \`${call.name}\` without making progress`, step);
    }
  }
  return finish(
    'max-steps',
    `Stopped at the step limit (${maxSteps} steps) before the task was finished. ` +
      'Re-run with `--max-steps <n>`, or set `maxSteps` in vibgrate.config.json, to give it more room.',
    maxSteps,
  );
}

/**
 * Try providers in order, falling back on transport failure.
 * Never attaches turn-level PatchIR GBNF — that belongs to tool arguments when
 * the model elects to edit, not to every chat completion (full agent contract).
 */
async function complete(
  providers: Provider[],
  messages: ChatMessage[],
  tools: ToolSpec[],
  onEvent: (e: AgentEvent) => void,
  stream?: boolean,
  modelProfile?: ModelExecutionProfile,
  identifierTrie?: TrieNode,
  draftCandidates?: string[],
  promptSegments?: Array<{ kind: string; text: string }>,
  reasoningEffort?: ReasoningEffort,
): Promise<{ result: ProviderResult; provider: Provider; fellBack: boolean }> {
  if (providers.length === 0) throw new Error('no model provider available');
  const onToken = stream ? (t: string): void => onEvent({ type: 'token', text: t }) : undefined;
  // Reasoning follows the same streaming posture as the answer: streamed, the
  // trace fills the long silence before a thinking model's first answer token;
  // unstreamed, the provider hands back the whole trace and we emit it once
  // below. Exactly one of the two paths runs, so the trace is never doubled.
  const onReasoningToken = stream
    ? (t: string): void => onEvent({ type: 'thinking', text: t })
    : undefined;
  // modelProfile remains available for future temperature / budget knobs; turn-level
  // PatchIR GBNF is never attached (full agent: tools own edit structure).
  void modelProfile;
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      const result = await providers[i].chat(messages, {
        temperature: 0,
        tools,
        stream,
        onToken,
        onReasoningToken,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        identifierTrie,
        draftCandidates,
        promptSegments,
      });
      // A non-streaming backend hands the whole trace back at once; emit it as
      // a single event so the host renders the same block either way. Streamed
      // reasoning already arrived through `onReasoningToken` — don't double it.
      if (!stream && result.reasoning) onEvent({ type: 'thinking', text: result.reasoning });
      return { result, provider: providers[i], fellBack: i > 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr instanceof Error ? redactSecrets(lastErr.message) : String(lastErr));
}

/**
 * Compact the transcript when it exceeds `budget` tokens: keep the first three
 * messages (system + graph context + task — the cache-stable prefix) and the
 * last {@link KEEP_ROUNDS} rounds verbatim, replacing the middle with a short
 * summary. A "round" is an assistant turn plus the tool results it triggered, so
 * an assistant/tool pair is never split (which an OpenAI-compatible API rejects).
 */
export function compact(messages: ChatMessage[], budget: number, changes: FileChange[]): { messages: ChatMessage[]; droppedRounds: number } {
  if (estimateTokens(messages) <= budget) return { messages, droppedRounds: 0 };
  const head = messages.slice(0, 3);
  const body = messages.slice(3);
  const rounds: ChatMessage[][] = [];
  for (const m of body) {
    if (m.role === 'assistant' || rounds.length === 0) rounds.push([m]);
    else rounds[rounds.length - 1].push(m);
  }
  if (rounds.length <= KEEP_ROUNDS) return { messages, droppedRounds: 0 };
  const dropped = rounds.slice(0, rounds.length - KEEP_ROUNDS);
  const kept = rounds.slice(-KEEP_ROUNDS).flat();
  const toolCalls = dropped.flat().reduce((n, m) => n + (m.role === 'assistant' ? (m.toolCalls?.length ?? 0) : 0), 0);
  const filesChanged = [...new Set(changes.map((c) => c.file))];
  const note: ChatMessage = {
    role: 'user',
    content: `[earlier steps summarized to save context: ${dropped.length} round(s), ${toolCalls} tool call(s) omitted.${filesChanged.length ? ` Files changed so far: ${filesChanged.join(', ')}.` : ''} Continue the task.]`,
  };
  return { messages: [...head, note, ...kept], droppedRounds: dropped.length };
}

/** The fixed contract for a compaction summary (structured checkpoint). */
const COMPACTION_PROMPT = [
  'Summarize the following coding-agent transcript into a compact checkpoint the agent can resume from.',
  'Cover, as short labelled lines: Objective; Key findings/decisions; Files read or changed (with paths);',
  'Current state; Next steps. Under 250 words. Plain text only — no code blocks, no tool syntax.',
].join(' ');

/** Render dropped rounds compactly for the summarizer (bounded input). */
function renderDroppedRounds(rounds: ChatMessage[][]): string {
  const lines: string[] = [];
  for (const round of rounds) {
    for (const m of round) {
      if (m.role === 'assistant') {
        if (m.content?.trim()) lines.push(`assistant: ${m.content.trim().slice(0, 400)}`);
        for (const t of m.toolCalls ?? []) {
          lines.push(`tool-call: ${t.name}(${JSON.stringify(t.arguments).slice(0, 200)})`);
        }
      } else if (m.role === 'tool') {
        lines.push(`tool-result[${m.name}]: ${m.content.split('\n')[0].slice(0, 300)}`);
      } else if (m.role === 'user') {
        lines.push(`user: ${m.content.trim().slice(0, 300)}`);
      }
    }
  }
  return lines.join('\n').slice(0, 24_000);
}

/** One bounded summarization completion against the primary provider. */
async function summarizeForCompaction(providers: Provider[], transcript: string): Promise<string | null> {
  const provider = providers[0];
  if (!provider) return null;
  const r = await provider.chat(
    [
      { role: 'system', content: COMPACTION_PROMPT },
      { role: 'user', content: transcript },
    ],
    { temperature: 0, maxTokens: 512, timeoutMs: 60_000 },
  );
  return (r.text ?? '').trim() || null;
}

/** True when a summary is usable prose — not tool markup or a JSON dump. */
function isUsableSummary(text: string | null): text is string {
  const t = (text ?? '').trim();
  return !!t && !t.startsWith('{') && !t.includes('<tool_call>');
}

/**
 * LLM-backed variant of {@link compact}: same prefix/recent-rounds shape, but
 * the middle is replaced by a model-written structured checkpoint (objective,
 * decisions, files, next steps). Any summarizer failure falls back to the
 * deterministic note — compaction never becomes a reason a run fails.
 */
export async function compactWithModel(
  messages: ChatMessage[],
  budget: number,
  changes: FileChange[],
  summarize: (transcript: string) => Promise<string | null>,
): Promise<{ messages: ChatMessage[]; droppedRounds: number }> {
  const deterministic = compact(messages, budget, changes);
  if (deterministic.droppedRounds === 0) return deterministic;
  const head = messages.slice(0, 3);
  const body = messages.slice(3);
  const rounds: ChatMessage[][] = [];
  for (const m of body) {
    if (m.role === 'assistant' || rounds.length === 0) rounds.push([m]);
    else rounds[rounds.length - 1].push(m);
  }
  const dropped = rounds.slice(0, rounds.length - KEEP_ROUNDS);
  const kept = rounds.slice(-KEEP_ROUNDS).flat();
  let summary: string | null = null;
  try {
    summary = await summarize(renderDroppedRounds(dropped));
  } catch {
    summary = null;
  }
  // A summary that itself looks like tool markup or JSON is worse than the note.
  if (!isUsableSummary(summary)) return deterministic;
  const filesChanged = [...new Set(changes.map((c) => c.file))];
  const note: ChatMessage = {
    role: 'user',
    content: `[Earlier steps were compacted to save context. Checkpoint summary:\n${summary.trim().slice(0, 4000)}\n${filesChanged.length ? `Files changed so far: ${filesChanged.join(', ')}. ` : ''}Continue the task.]`,
  };
  return { messages: [...head, note, ...kept], droppedRounds: dropped.length };
}

/**
 * Assemble the first-turn context. Capsule mode injects exact source ranges
 * from graph spans (Fusion Runtime); legacy mode is metadata-only.
 * Returns the capsule when built so the verification ladder can use its plan.
 */
function buildAgentContext(
  graph: VgGraph,
  instruction: string,
  options: AgentOptions & { ranked?: SanitizedRank | null },
): { context: CodeContext; capsule: TaskCapsule | null } {
  const budget = options.budget ?? 3000;
  const files = options.files;
  const ranked = options.ranked;
  if (!options.capsule) {
    return {
      context: buildCodeContext(graph, instruction, { budget, files, ranked }),
      capsule: null,
    };
  }

  const readFile = (rel: string) => options.fsImpl.read(rel);
  const mapped = (files?.length ? files : mappedFilePaths(graph)).map((path) => ({
    path,
    content: readFile(path) ?? '',
  }));
  const mode: CapsuleMode =
    options.capsuleMode ??
    capsuleMode({
      sourceTokens: sourceTokenMass(mapped.map((f) => f.content)),
      askNamesSymbol: askNamesSymbol(graph, instruction),
    });

  if (mode === 'off') {
    return {
      context: buildCodeContext(graph, instruction, { budget, files, ranked }),
      capsule: null,
    };
  }
  if (mode === 'whole-repo') {
    const packet = buildWholeRepoPacket(instruction, mapped, budget);
    return {
      context: {
        instruction,
        seeds: [],
        targetFiles: packet.files,
        impacted: [],
        pinnedFacts: [],
        conceptMap: [],
        rendered: packet.rendered,
        tokensEstimate: packet.tokensEstimate,
      },
      capsule: null,
    };
  }

  const capsule = buildTaskCapsule(graph, instruction, {
    budget,
    files,
    ranked,
    readFile,
    repositoryId: repositoryIdFromRoot(options.root),
    extraPinnedFacts: options.extraPinnedFacts,
    provenance: {
      modelProfileId: options.modelProfile?.id ?? null,
      securityTier: options.executionEnv?.tier ?? options.modelProfile?.securityTier ?? null,
      policyVersion: CONTEXT_POLICY_VERSION,
    },
  });
  return { context: capsuleToCodeContext(capsule), capsule };
}

export { summarizeCapsule } from './capsule.js';
/** Re-export metric helpers used by tools (discovery set). */
export { DISCOVERY_TOOLS, MUTATION_TOOLS };

function recordSearchSaving(root: string, context: CodeContext, attribution: NonNullable<AgentOptions['attribution']>, ts: number): void {
  const files = new Set(context.seeds.map((s) => s.node.file).filter(Boolean));
  recordCliCall(
    root,
    {
      tool: CLI_TOOL_ALIASES.ask,
      client: attribution.client,
      provider: attribution.provider,
      model: attribution.model,
      outcome: context.seeds.length ? 'complete' : 'miss',
      vgTokens: context.tokensEstimate,
      baselineFiles: files.size,
    },
    ts,
  );
}

/** An append-only, secret-free audit record for one agent run (no code, no output, no keys). */
function writeAgentAudit(
  fsImpl: CodeFs,
  rec: {
    instruction: string;
    providerInfo: { id: string; model: string };
    changes: FileChange[];
    commandCount: number;
    steps: number;
    stopped: AgentStop;
    provenance?: RunProvenance;
  },
  ts: number,
): void {
  try {
    fsImpl.appendAudit(
      JSON.stringify({
        ts,
        kind: 'agent',
        instruction: rec.instruction.slice(0, 500),
        provider: rec.providerInfo.id,
        model: rec.providerInfo.model,
        steps: rec.steps,
        stopped: rec.stopped,
        commands: rec.commandCount,
        files: rec.changes.map((c) => ({ file: c.file, statuses: c.outcomes.map((o) => o.status) })),
        // Content hashes only — never file bodies or secrets.
        provenance: rec.provenance
          ? {
              schemaVersion: rec.provenance.schemaVersion,
              policyVersion: rec.provenance.policyVersion,
              rankingVersion: rec.provenance.rankingVersion,
              modelProfileId: rec.provenance.modelProfileId,
              securityTier: rec.provenance.securityTier,
              graphCorpusHash: rec.provenance.graphCorpusHash,
              mutationsRootHash: rec.provenance.mutationsRootHash,
              verificationRootHash: rec.provenance.verificationRootHash ?? null,
              mutationCount: rec.provenance.mutations.length,
              verificationCount: rec.provenance.verification?.length ?? 0,
            }
          : undefined,
      }),
    );
  } catch {
    /* audit is best-effort — never fail a run on a logging problem */
  }
}

/** True when model text is a real answer, not empty/PatchIR/tool JSON. */
function isUserFacingProse(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 12) return false;
  if (/"schemaVersion"\s*:\s*"patch-ir\/0"/i.test(t)) return false;
  if (/^\s*\{[\s\S]*"operations"\s*:/.test(t)) return false;
  if (!/[A-Za-z]{4,}/.test(t)) return false;
  return true;
}

/** Deterministic argument signature for the repeat guard (order-independent). */
function stableArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

/** ~4 chars/token estimate over the transcript, including serialized tool calls. */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.role === 'assistant' && m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

/** Per-file symbol spans, so an agent edit lands in the right place when its SEARCH is ambiguous. */
function buildSpanIndex(graph: VgGraph): Map<string, SymbolSpan[]> {
  const map = new Map<string, SymbolSpan[]>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const file = n.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const list = map.get(file) ?? [];
    list.push({ qualifiedName: n.qualifiedName, file, start: n.span.start, end: n.span.end });
    map.set(file, list);
  }
  return map;
}
