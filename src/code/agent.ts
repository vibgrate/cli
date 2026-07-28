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
import {
  buildTaskCapsule,
  capsuleToCodeContext,
  summarizeCapsule,
  CAPSULE_RANKING_VERSION,
  type CapsuleSummary,
  type TaskCapsule,
} from './capsule.js';
import { buildCapsuleDelta, isEmptyCapsuleDelta, type CapsuleDelta } from './capsule-delta.js';
import {
  createDiscoveryGateState,
  gateDiscoveryTool,
  recordDiscoveryGateOutcome,
} from './advanced-mode.js';
import { materializeWorktreeGraph } from './worktree-overlay.js';
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
import type { ChatMessage, CodeContext, FileChange, Provider, ProviderResult, ToolCall, ToolSpec } from './types.js';
import type { VgGraph } from '../schema.js';
import { redactSecrets } from './providers.js';
import { patchIrGbnf, shouldUsePatchIrGrammar } from './patch-ir-grammar.js';
import {
  answerLocateInstruction,
  isLocateOnlyInstruction,
  sanitizeAgentDisplayText,
} from './locate-answer.js';
import { buildIdentifierTrieFromGraph } from '../runtime/identifier-trie.js';
import type { TrieNode } from '../runtime/identifier-trie.js';
import { graphDraftCandidates, KvBlockRegistry } from '../runtime/kv-cache.js';

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
  | { type: 'tool-result'; name: string; content: string; mutated: boolean }
  | { type: 'change'; change: FileChange }
  | { type: 'compact'; droppedRounds: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'verify'; command: string; passed: boolean }
  | { type: 'ladder'; ok: boolean; summary: string }
  | { type: 'session-graph'; reparsed: number; dirty: number }
  | { type: 'step'; n: number }
  | { type: 'capsule'; summary: CapsuleSummary }
  | { type: 'capsule-delta'; delta: CapsuleDelta }
  | { type: 'failure-capsule'; capsule: FailureCapsule }
  | { type: 'metrics'; metrics: AgentMetrics };

export interface AgentOptions {
  graph: VgGraph;
  root: string;
  instruction: string;
  providers: Provider[];
  fsImpl: CodeFs;
  /** Run a shell command (injected). Prefer {@link executionEnv} when set. */
  run: (command: string) => ShellResult;
  /**
   * Security ladder substrate for shell (ADR-002). When set, `run_command` and
   * verify steps use `executionEnv.run` instead of the bare `run` callback.
   */
  executionEnv?: { tier: string; label: string; reason: string; run: (command: string, opts: { cwd: string }) => ShellResult };
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
  /** Project-configured extra denylist rules for autonomous commands. */
  denyCommands?: string[];
  /** The project's test/verify command, surfaced to the model. */
  testCommand?: string;
  /** Auto-verify: after the model finishes, run this command and make it fix failures. */
  verify?: { command: string; maxRounds?: number };
  /** Stream assistant tokens as they arrive (emits `token` events). */
  stream?: boolean;
  /** A recap of earlier tasks (from `--continue`) to seed continuity. */
  priorSummary?: string;
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
   * Free use of low-level discovery tools. Default true. When false (typical
   * with capsule mode), early discovery is soft-nudged then hard-capped until
   * a mutation or inspect_change (Fusion Phase 4 ZNS@1 path).
   */
  advancedMode?: boolean;
  /**
   * Reparse git-dirty worktree files into the graph before the agent loop
   * (base ⊕ worktree). Default false (tests / CI stay offline-fast). Interactive
   * and stream-json enable this so the map matches uncommitted edits.
   */
  worktreeOverlay?: boolean;
  /**
   * When true (default), pure locate/URL-occurrence asks answer from the hybrid
   * literal sweep without calling the model — avoids PatchIR dumps in the panel.
   */
  deterministicLocate?: boolean;
}

export type AgentStop = 'finished' | 'max-steps' | 'no-tools' | 'no-progress' | 'error';

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

  // Capsule-first runs default to non-advanced discovery (ZNS@1 path).
  const advancedMode = options.advancedMode ?? !options.capsule;
  const discoveryGate = createDiscoveryGateState();

  const allTools = [...AGENT_TOOLS, ...(options.externalTools?.specs ?? [])];
  const built = buildAgentContext(graph, instruction, { ...options, fsImpl, budget });
  const context = built.context;
  let capsule = built.capsule;
  const useLadder = options.verifyLadder ?? !!capsule;
  const messages: ChatMessage[] = buildAgentMessages(context);
  if (options.priorSummary) {
    messages.push({ role: 'user', content: options.priorSummary });
  }
  if (options.testCommand) {
    messages.push({ role: 'user', content: `When you want to verify a change, the project's test command is: \`${options.testCommand}\`` });
  }
  // Locate-only (URL / "where is …?"): never force PatchIR grammar — the model
  // would dump JSON edits into the panel. Prefer a deterministic literal answer.
  const locateOnly = isLocateOnlyInstruction(instruction);
  const spans = buildSpanIndex(graph);

  const changes: FileChange[] = [];
  const repeats = new Map<string, number>();
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

  // Deterministic locate short-circuit: correct file:line without model noise
  // (and without PatchIR / identifier-annotation dumps in the VG Code panel).
  if (locateOnly && options.deterministicLocate !== false) {
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

  const runShell = (command: string): ShellResult => {
    if (options.executionEnv) return options.executionEnv.run(command, { cwd: root });
    return options.run(command);
  };

  const ctx: ToolContext = {
    root,
    graph,
    fsImpl,
    spans,
    run: runShell,
    approve: options.approve,
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
          const nextCapsule = buildTaskCapsule(session.graph, instruction, {
            budget,
            files: options.files,
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
  const verifyOnFinish = (): 'retry' | 'done' => {
    if (changes.length === 0) return 'done';

    if (useLadder && capsule) {
      const steps = compileVerificationLadder(capsule.verificationPlan, {
        testCommand: verifyConfig?.command ?? options.testCommand,
      });
      // Shell steps need real files — flush before the ladder.
      flushOverlay();
      const ladder = runVerificationLadder(steps, {
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
    const res = runShell(v.command);
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
    currentStep = step;
    onEvent({ type: 'step', n: step });

    // Keep the transcript under the budget: preserve the cache-stable prefix
    // (system + graph context + task) and the recent rounds, summarize the rest.
    const compacted = compact(messages, contextBudget, changes);
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
        /* skipPatchIrGrammar */ locateOnly,
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
      onEvent({ type: 'usage', promptTokens: result.usage.promptTokens ?? 0, completionTokens: result.usage.completionTokens ?? 0 });
    }

    const displayText = sanitizeAgentDisplayText(result.text ?? '');
    if (displayText) onEvent({ type: 'assistant', text: displayText });

    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: result.text });
      // Clean prose/Markdown answer (Q&A, explanations) is a successful finish —
      // same as Claude Code free-text, not a failed no-tools dump.
      if (isUserFacingProse(displayText)) {
        return finish('finished', displayText, step);
      }
      return finish('no-tools', displayText || 'done', step);
    }

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
      onEvent({ type: 'tool-result', name: call.name, content, mutated: toolResult.mutated });
      messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });

      if (toolResult.finished) {
        // Auto-verify: on failure, keep going so the model fixes it.
        if (verifyOnFinish() === 'retry') break;
        return finish('finished', toolResult.finalSummary ?? 'done', step);
      }
      if (stopNoProgress) return finish('no-progress', `stopped: the model repeated \`${call.name}\` without making progress`, step);
    }
  }
  return finish('max-steps', 'reached the step limit before finishing', maxSteps);
}

/** Try providers in order, falling back on transport failure. Throws the last actionable error. */
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
  skipPatchIrGrammar = false,
): Promise<{ result: ProviderResult; provider: Provider; fellBack: boolean }> {
  if (providers.length === 0) throw new Error('no model provider available');
  const onToken = stream ? (t: string): void => onEvent({ type: 'token', text: t }) : undefined;
  // Locate/Q&A must not use PatchIR GBNF — that forces edit JSON into the panel.
  const grammar =
    !skipPatchIrGrammar && shouldUsePatchIrGrammar(modelProfile) ? patchIrGbnf() : undefined;
  // Fail-closed on embedded path when pack requires constrained decoding.
  const requireGrammar = !!(
    grammar &&
    modelProfile?.constrainedDecoding &&
    providers.some((p) => p.id === 'llama-cpp')
  );
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      const result = await providers[i].chat(messages, {
        temperature: 0,
        tools,
        stream,
        onToken,
        grammar,
        // Only require grammar on the llama-cpp provider; HTTP providers ignore it.
        requireGrammar: requireGrammar && providers[i].id === 'llama-cpp',
        identifierTrie,
        draftCandidates,
        promptSegments,
      });
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

/**
 * Assemble the first-turn context. Capsule mode injects exact source ranges
 * from graph spans (Fusion Runtime); legacy mode is metadata-only.
 * Returns the capsule when built so the verification ladder can use its plan.
 */
function buildAgentContext(
  graph: VgGraph,
  instruction: string,
  options: AgentOptions,
): { context: CodeContext; capsule: TaskCapsule | null } {
  const budget = options.budget ?? 3000;
  const files = options.files;
  if (!options.capsule) {
    return { context: buildCodeContext(graph, instruction, { budget, files }), capsule: null };
  }
  const capsule = buildTaskCapsule(graph, instruction, {
    budget,
    files,
    readFile: (rel) => options.fsImpl.read(rel),
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
