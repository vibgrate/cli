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

/** A single line written to the host. Discriminated by `event`. */
export type StreamJsonOut =
  | ({ event: 'event' } & AgentEvent)
  | { event: 'approve-request'; id: number; action: MutatingAction }
  /** Clarifying question for the human — host shows a prompt and answers via stdin. */
  | { event: 'user-question'; id: number; question: string; options?: string[] }
  | { event: 'done'; result: AgentResult }
  | { event: 'error'; message: string }
  /** Session mode only: the process is up and owns this session id. */
  | { event: 'session-start'; sessionId: string; resumed: boolean }
  /** Session mode only: the turn ended; send another `submit` or `end`. */
  | { event: 'idle'; turns: number }
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
  | { kind: 'approve'; id: number; approve: boolean }
  | { kind: 'answer'; id: number; answer: string }
  | { kind: 'submit'; instruction: string }
  | { kind: 'restore'; commit: string; files: string[] }
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
    return { kind: 'approve', id: msg.approveId, approve: !!msg.approve };
  }
  if (typeof msg.answerId === 'number') {
    return { kind: 'answer', id: msg.answerId, answer: String(msg.answer ?? '') };
  }
  if (typeof msg.submit === 'string' && msg.submit.trim()) {
    return { kind: 'submit', instruction: msg.submit.trim() };
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
  private readonly pendingApprove = new Map<number, (approve: boolean) => void>();
  private readonly pendingAnswer = new Map<number, (answer: string) => void>();
  /** Cancellation for the turn currently running (session mode). */
  private turnSignal: { aborted: boolean } = { aborted: false };

  constructor(
    private readonly emit: (line: StreamJsonOut) => void,
    private readonly auto = false,
  ) {}

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
      this.pendingApprove.set(id, resolve);
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
  submitDecision(id: number, approve: boolean): void {
    const resolve = this.pendingApprove.get(id);
    if (resolve) {
      this.pendingApprove.delete(id);
      resolve(approve);
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
    for (const resolve of this.pendingApprove.values()) resolve(false);
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
  /** Instruction for the first turn. Omit to wait for the host's first `submit`. */
  instruction?: string;
  /** Await the host's next instruction; resolve null to end the session. */
  nextTurn: () => Promise<string | null>;
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
  const session = new StreamJsonSession(emit, !!auto);
  bindDecisions?.(session);
  emit({ event: 'session-start', sessionId, resumed });

  const turns: StreamJsonTurn[] = [];
  let priorSummary: string | undefined;
  let instruction = options.instruction?.trim() || (await nextTurn());

  while (instruction) {
    const signal = session.beginTurn();
    let turn: StreamJsonTurn;
    try {
      const result = await runTurn({ instruction, priorSummary, signal, session });
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
    emit({ event: 'idle', turns: turns.length });
    instruction = await nextTurn();
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
