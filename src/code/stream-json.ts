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
  | { event: 'error'; message: string };

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
