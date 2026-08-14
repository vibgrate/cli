/**
 * Machine-readable event protocol for `vg code --stream-json` (VG-CLI-CODE §18).
 *
 * A host UI (the VS Code VG Code panel) can't drive the agent through the human
 * TTY renderer, so this exposes the agent as a line protocol: every
 * {@link AgentEvent} is emitted as one NDJSON object on stdout, and each
 * approval / user question is a round-trip — an event out, a decision/answer
 * line in. This keeps the governance gate intact across the process boundary
 * (the host's Approve/Reject and question UI fulfil the same contracts the CLI
 * would — no quick-apply back-door), while the host stays a pure relay.
 *
 * Pure over an injected `emit` + the decision channel, so the protocol is
 * unit-tested without a process, model, or socket.
 */

import { runAgent, type AgentEvent, type AgentOptions, type AgentResult } from './agent.js';
import type { AskUserRequest, MutatingAction } from './tools.js';
import { sanitizeAttachments, type SessionAttachment } from './session-store.js';
import type { ImageAttachment, ReasoningEffort } from './types.js';

/**
 * Version of this NDJSON protocol, carried on `session-start`. Hosts use it to
 * fail closed (e.g. disable features that need a newer engine) instead of
 * silently assuming the engine honours frames it may not know. Bump when a
 * frame is added or its meaning changes.
 *
 *  - 1 (implicit): the original protocol; `session-start` had no version field.
 *  - 2: `session-start` reports sessionDir/engineVersion/protocolVersion/
 *       provider/model; `--continue` accepts an explicit session id; checkpoint
 *       restore is available out-of-band via `vg code --restore-checkpoint`.
 *  - 3: approvals accept `always: true` (persist a standing allow rule from
 *       `.vibgrate/code-approvals.json`); a completed plan turn emits
 *       `plan-ready` before `idle` so hosts can offer Approve plan / Keep
 *       planning; read-only commands auto-approve engine-side.
 *  - 4: `inject` steers the running turn (content lands at the next step
 *       boundary, announced by an `injected` event); `rename` titles the live
 *       session; the session store keeps an `index.json` (list without parsing
 *       every session) and supports rename/delete/fork/rewind out-of-band;
 *       `session-start` reports `worktree` when the run is rooted in one.
 *  - 5: reasoning models are visible — a `thinking` event streams the model's
 *       reasoning channel separately from its answer, and `submit` carries an
 *       optional `reasoningEffort`. The `usage` event reports
 *       `cachedPromptTokens` when the provider says how much of the prompt it
 *       served from cache, so a host can price a turn instead of guessing.
 *       `submit` also carries `attachments` metadata, so a restored chat can
 *       show what was attached to a turn (names and sizes, never the bytes).
 */
export const STREAM_JSON_PROTOCOL_VERSION = 5;

/** Environment facts a `session-start` frame reports to the host (all optional for older callers). */
export interface SessionStartInfo {
  /** Absolute directory session files live in — the single source of truth for history UIs. */
  sessionDir?: string;
  /** Engine (CLI) version string, for host version reports. */
  engineVersion?: string;
  protocolVersion?: number;
  provider?: string;
  model?: string;
  /** v4: set when this session runs inside an isolated git worktree. */
  worktree?: { path: string; base: string };
}

/** Per-turn approval posture a host can send with `submit` (session mode). */
export type TurnAgentMode = 'agent' | 'plan' | 'auto';

/** One queued task from the host: instruction plus optional mode/attachments. */
export interface TurnRequest {
  instruction: string;
  /** Overrides the spawn-time posture for this turn only (plan blocks writes engine-side). */
  agentMode?: TurnAgentMode;
  /** Images attached to this turn (multimodal providers encode them). */
  images?: ImageAttachment[];
  /** v5: reasoning budget for this turn (ignored by models without the knob). */
  reasoningEffort?: ReasoningEffort;
  /**
   * v5: what the user attached, as metadata only (name/kind/size). The bytes
   * travel separately on `images` (or already folded into the instruction for
   * text); this exists so the stored session can show a restored chat what was
   * attached without carrying the payload.
   */
  attachments?: SessionAttachment[];
}

/** A single line written to the host. Discriminated by `event`. */
export type StreamJsonOut =
  | ({ event: 'event' } & AgentEvent)
  | { event: 'approve-request'; id: number; action: MutatingAction }
  /** Clarifying question for the human — host shows a prompt and answers via stdin. */
  | { event: 'user-question'; id: number; question: string; options?: string[] }
  | { event: 'done'; result: AgentResult }
  | { event: 'error'; message: string }
  /** Session mode only: the process is up and owns this session id. */
  | ({ event: 'session-start'; sessionId: string; resumed: boolean } & SessionStartInfo)
  /** Session mode only: the turn ended; send another `submit` or `end`. */
  | { event: 'idle'; turns: number }
  /**
   * Session mode only (v3): a plan-mode turn just completed. Emitted before
   * `idle` so a host can paint an Approve plan / Keep planning affordance;
   * hosts that don't know the frame ignore it and see `idle` as before.
   */
  | { event: 'plan-ready'; turns: number }
  /** Outcome of a checkpoint restore the host asked for. */
  | {
      event: 'checkpoint-restored';
      commit: string;
      restored: string[];
      removed: string[];
      failed: string[];
    };

/**
 * A line read from the host. Approvals and answers fulfil an open round-trip;
 * `submit` starts the next turn in a session; `cancel` stops the running turn
 * without killing the process; `end` closes the session.
 */
export type HostMessage =
  | { kind: 'approve'; id: number; approve: boolean; always?: boolean }
  | { kind: 'answer'; id: number; answer: string }
  | {
      kind: 'submit';
      instruction: string;
      agentMode?: TurnAgentMode;
      images?: ImageAttachment[];
      /** v5: reasoning budget for this turn (ignored by models without the knob). */
      reasoningEffort?: ReasoningEffort;
      /** v5: attachment metadata for the session record (never the bytes). */
      attachments?: SessionAttachment[];
    }
  | { kind: 'restore'; commit: string; files: string[] }
  /** Manual compaction: condense the stored session so the recap shrinks. */
  | { kind: 'compact' }
  /**
   * v4 steer: mid-turn user content for the *running* turn, applied at the next
   * step boundary (unlike `submit`, which queues a whole next turn). Buffered —
   * an inject racing the turn's end is delivered at the start of the next turn
   * rather than dropped.
   */
  | { kind: 'inject'; text: string }
  /** v4: title the live session (empty text clears back to the derived name). */
  | { kind: 'rename'; title: string }
  | { kind: 'cancel' }
  | { kind: 'end' };

/**
 * Parse one host line. Returns null for malformed input or an unknown shape, so
 * a garbled line is ignored rather than taking the session down.
 */
export function parseHostMessage(raw: string): HostMessage | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.approveId === 'number') {
    // v3: `always: true` on an approval asks the engine to persist a standing
    // allow rule for this action shape. Only meaningful with approve: true.
    return {
      kind: 'approve',
      id: msg.approveId,
      approve: !!msg.approve,
      ...(msg.always === true && msg.approve ? { always: true } : {}),
    };
  }
  if (typeof msg.answerId === 'number') {
    return { kind: 'answer', id: msg.answerId, answer: String(msg.answer ?? '') };
  }
  if (typeof msg.submit === 'string' && msg.submit.trim()) {
    const agentMode =
      msg.agentMode === 'plan' || msg.agentMode === 'auto' || msg.agentMode === 'agent'
        ? msg.agentMode
        : undefined;
    const images = Array.isArray(msg.images)
      ? (msg.images as unknown[])
          .filter(
            (a): a is ImageAttachment =>
              !!a &&
              typeof a === 'object' &&
              typeof (a as ImageAttachment).name === 'string' &&
              typeof (a as ImageAttachment).mediaType === 'string' &&
              typeof (a as ImageAttachment).dataBase64 === 'string',
          )
          .slice(0, 8)
      : undefined;
    const reasoningEffort =
      msg.reasoningEffort === 'low' || msg.reasoningEffort === 'medium' || msg.reasoningEffort === 'high'
        ? msg.reasoningEffort
        : undefined;
    const attachments = sanitizeAttachments(msg.attachments);
    return {
      kind: 'submit',
      instruction: msg.submit.trim(),
      ...(agentMode ? { agentMode } : {}),
      ...(images?.length ? { images } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  }
  if (
    msg.restore &&
    typeof msg.restore === 'object' &&
    typeof (msg.restore as Record<string, unknown>).commit === 'string'
  ) {
    const r = msg.restore as { commit: string; files?: unknown };
    const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : [];
    if (files.length) return { kind: 'restore', commit: r.commit, files };
    return null;
  }
  if (msg.compactSession === true) return { kind: 'compact' };
  if (typeof msg.inject === 'string' && msg.inject.trim()) {
    return { kind: 'inject', text: msg.inject.trim() };
  }
  if (typeof msg.renameSession === 'string') {
    return { kind: 'rename', title: msg.renameSession.trim() };
  }
  if (msg.cancel === true) return { kind: 'cancel' };
  if (msg.end === true) return { kind: 'end' };
  return null;
}

/**
 * Owns the NDJSON protocol for one run: serializes agent events, and turns each
 * approval / user question into a host round-trip via {@link submitDecision} /
 * {@link submitAnswer}. Under `auto`, approvals resolve true immediately (still
 * announced, for the log); user questions get a default "proceed" answer.
 */
export class StreamJsonSession {
  private nextId = 1;
  private readonly pendingApprove = new Map<
    number,
    { resolve: (approve: boolean) => void; action: MutatingAction }
  >();
  private readonly pendingAnswer = new Map<number, (answer: string) => void>();
  /** Cancellation for the turn currently running (session mode). */
  private turnSignal: { aborted: boolean } = { aborted: false };
  /**
   * v4 steer: user content injected mid-turn, drained by the agent loop at its
   * next step boundary. Deliberately NOT cleared between turns — an inject that
   * races the turn's end should land at the start of the next turn, not vanish.
   */
  private injected: string[] = [];
  /**
   * v3: called when the host approved with `always: true` — the owner persists
   * a standing rule derived from the approved action. Injected (not imported)
   * so this protocol class stays free of filesystem concerns.
   */
  onAlwaysRule?: (action: MutatingAction) => void;

  constructor(
    private readonly emit: (line: StreamJsonOut) => void,
    private auto = false,
  ) {}

  /**
   * Per-turn approval posture (session mode): a host `submit` can flip auto on
   * or off for the coming turn without respawning the process.
   */
  setAuto(auto: boolean): void {
    this.auto = auto;
  }

  /** The agent's onEvent → one NDJSON line per event. */
  readonly onEvent = (e: AgentEvent): void => {
    this.emit({ event: 'event', ...e });
  };

  /** The agent's approval gate → an approve-request the host answers. */
  readonly approve = (action: MutatingAction): Promise<boolean> => {
    const id = this.nextId++;
    if (this.auto) {
      this.emit({ event: 'approve-request', id, action });
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pendingApprove.set(id, { resolve, action });
      this.emit({ event: 'approve-request', id, action });
    });
  };

  /** Clarifying question → user-question the host answers with free text. */
  readonly askUser = (req: AskUserRequest): Promise<string> => {
    const id = this.nextId++;
    const question = req.question.trim();
    const options = req.options?.filter(Boolean);
    if (this.auto) {
      this.emit({ event: 'user-question', id, question, options });
      return Promise.resolve(
        'Autonomous mode: no human. Proceed with safest defaults and state assumptions.',
      );
    }
    return new Promise<string>((resolve) => {
      this.pendingAnswer.set(id, resolve);
      this.emit({ event: 'user-question', id, question, options });
    });
  };

  /** Host → agent: resolve a pending approval. Unknown ids are ignored. */
  submitDecision(id: number, approve: boolean, always = false): void {
    const pending = this.pendingApprove.get(id);
    if (pending) {
      this.pendingApprove.delete(id);
      // Persist the standing rule before resolving, so the rule exists by the
      // time the approved action (and any follow-up like it) executes.
      if (approve && always) this.onAlwaysRule?.(pending.action);
      pending.resolve(approve);
    }
  }

  /** Host → agent: resolve a pending user-question. Unknown ids are ignored. */
  submitAnswer(id: number, answer: string): void {
    const resolve = this.pendingAnswer.get(id);
    if (resolve) {
      this.pendingAnswer.delete(id);
      resolve(answer ?? '');
    }
  }

  /** Host → agent (v4): steer the running turn with more user content. */
  inject(text: string): void {
    const t = text.trim();
    if (t) this.injected.push(t);
  }

  /**
   * Drain pending steer content (joined, oldest first) for the agent loop's
   * next step. Null when nothing is pending.
   */
  drainInjected(): string | null {
    if (!this.injected.length) return null;
    const text = this.injected.join('\n\n');
    this.injected = [];
    return text;
  }

  /** Start a turn: fresh cancellation signal, handed to the agent loop. */
  beginTurn(): { aborted: boolean } {
    this.turnSignal = { aborted: false };
    return this.turnSignal;
  }

  /**
   * Host → agent: stop the running turn. Sets the cooperative signal *and*
   * rejects anything the turn is blocked on, so a turn waiting at an approval
   * gate unblocks instead of hanging until the process dies.
   */
  cancelTurn(): void {
    this.turnSignal.aborted = true;
    this.cancelPending();
  }

  /** Reject any still-pending approvals/questions (e.g. the host disconnected). */
  cancelPending(): void {
    for (const pending of this.pendingApprove.values()) pending.resolve(false);
    this.pendingApprove.clear();
    for (const resolve of this.pendingAnswer.values()) resolve('');
    this.pendingAnswer.clear();
  }
}

export interface StreamJsonOptions extends Omit<AgentOptions, 'approve' | 'onEvent' | 'askUser'> {
  emit: (line: StreamJsonOut) => void;
  /** Register the stdin decision reader; the returned session accepts decisions. */
  bindDecisions?: (session: StreamJsonSession) => void;
}

/** One turn of a session: what the host asked, and how it ended. */
export interface StreamJsonTurn {
  instruction: string;
  result: AgentResult | null;
}

export interface StreamJsonSessionRunOptions {
  emit: (line: StreamJsonOut) => void;
  /** Bound once for the whole session, not per turn. */
  bindDecisions?: (session: StreamJsonSession) => void;
  auto?: boolean;
  sessionId: string;
  /** True when this session was reloaded from disk (`--continue`). */
  resumed: boolean;
  /** Environment facts to report on `session-start` (dir, versions, model). */
  sessionInfo?: SessionStartInfo;
  /** Instruction for the first turn. Omit to wait for the host's first `submit`. */
  instruction?: string;
  /** Spawn-time approval posture; per-turn `agentMode` on `submit` overrides it. */
  spawnAuto?: boolean;
  /** Await the host's next task; resolve null to end the session. */
  nextTurn: () => Promise<TurnRequest | null>;
  /**
   * Run one turn. Injected so the heavy agent wiring (graph, providers, MCP,
   * sandbox) is built once by the caller and reused across turns — the whole
   * point of session mode.
   */
  runTurn: (turn: {
    instruction: string;
    priorSummary?: string;
    signal: { aborted: boolean };
    session: StreamJsonSession;
    /** Per-turn posture from the host (plan blocks writes engine-side). */
    agentMode?: TurnAgentMode;
    /** Effective auto for this turn (spawn flag overridden by agentMode). */
    auto: boolean;
    images?: ImageAttachment[];
    /** v5: per-turn reasoning budget, straight from the host's `submit`. */
    reasoningEffort?: ReasoningEffort;
    /** v5: attachment metadata for the session record (never the bytes). */
    attachments?: SessionAttachment[];
  }) => Promise<AgentResult>;
  /**
   * Record a finished turn. Returns the recap to seed the next turn, so
   * continuity is the caller's policy (session store, summarizer) not ours.
   */
  onTurnEnd?: (turn: StreamJsonTurn) => string | undefined;
}

/**
 * Session mode for `vg code --stream-json --session`: hold the process open and
 * run turn after turn against warm state, instead of paying a cold start (graph
 * load, overlay rebuild, MCP connect, model warm-up) on every message.
 *
 * Each turn still emits exactly the frames a single-shot run does, so a host
 * that already speaks the one-shot protocol only needs to learn `idle`. A turn
 * that throws is reported and the session stays up — one bad task should not
 * cost the user their conversation.
 */
export async function runCodeStreamJsonSession(
  options: StreamJsonSessionRunOptions,
): Promise<StreamJsonTurn[]> {
  const { emit, bindDecisions, auto, sessionId, resumed, nextTurn, runTurn, onTurnEnd } = options;
  const spawnAuto = options.spawnAuto ?? !!auto;
  const session = new StreamJsonSession(emit, spawnAuto);
  bindDecisions?.(session);
  emit({ event: 'session-start', sessionId, resumed, ...(options.sessionInfo ?? {}) });

  const turns: StreamJsonTurn[] = [];
  let priorSummary: string | undefined;
  const first = options.instruction?.trim();
  let request: TurnRequest | null = first ? { instruction: first } : await nextTurn();

  while (request) {
    const signal = session.beginTurn();
    // Per-turn posture: an explicit agentMode overrides the spawn flag; plan
    // never auto-approves. First turn without a mode keeps the spawn posture.
    const turnAuto = request.agentMode ? request.agentMode === 'auto' : spawnAuto;
    session.setAuto(turnAuto && request.agentMode !== 'plan');
    const instruction = request.instruction;
    let turn: StreamJsonTurn;
    try {
      const result = await runTurn({
        instruction,
        priorSummary,
        signal,
        session,
        agentMode: request.agentMode,
        auto: turnAuto && request.agentMode !== 'plan',
        images: request.images,
        reasoningEffort: request.reasoningEffort,
        attachments: request.attachments,
      });
      emit({ event: 'done', result });
      turn = { instruction, result };
    } catch (e) {
      emit({ event: 'error', message: (e as Error).message });
      turn = { instruction, result: null };
    } finally {
      session.cancelPending();
    }
    turns.push(turn);
    priorSummary = onTurnEnd?.(turn) ?? priorSummary;
    // v3: a completed plan turn announces itself so hosts can offer
    // Approve plan / Keep planning. A failed turn is not a ready plan.
    if (request.agentMode === 'plan' && turn.result) {
      emit({ event: 'plan-ready', turns: turns.length });
    }
    emit({ event: 'idle', turns: turns.length });
    request = await nextTurn();
  }
  return turns;
}

/** Run the agent under the NDJSON protocol; always emits a terminal `done`/`error`. */
export async function runCodeStreamJson(options: StreamJsonOptions): Promise<AgentResult | null> {
  const { emit, bindDecisions, auto, ...agentOptions } = options;
  const session = new StreamJsonSession(emit, !!auto);
  bindDecisions?.(session);
  try {
    const result = await runAgent({
      ...agentOptions,
      auto,
      approve: session.approve,
      askUser: session.askUser,
      onEvent: session.onEvent,
    });
    emit({ event: 'done', result });
    return result;
  } catch (e) {
    emit({ event: 'error', message: (e as Error).message });
    return null;
  } finally {
    session.cancelPending();
  }
}
