/**
 * Machine-readable event protocol for `vg code --stream-json` (VG-CLI-CODE §18).
 *
 * A host UI (the VS Code VG Code panel) can't drive the agent through the human
 * TTY renderer, so this exposes the agent as a line protocol: every
 * {@link AgentEvent} is emitted as one NDJSON object on stdout, and each
 * approval is a round-trip — an `approve-request` event out, a decision line in.
 * This keeps the governance gate intact across the process boundary (the host's
 * Approve/Reject button fulfils the same `approve` contract the CLI's prompt
 * does — no quick-apply back-door), while the host stays a pure relay.
 *
 * Pure over an injected `emit` + the decision channel, so the protocol is
 * unit-tested without a process, model, or socket.
 */

import { runAgent, type AgentEvent, type AgentOptions, type AgentResult } from './agent.js';
import type { MutatingAction } from './tools.js';

/** A single line written to the host. Discriminated by `event`. */
export type StreamJsonOut =
  | ({ event: 'event' } & AgentEvent)
  | { event: 'approve-request'; id: number; action: MutatingAction }
  | { event: 'done'; result: AgentResult }
  | { event: 'error'; message: string };

/**
 * Owns the NDJSON protocol for one run: serializes agent events, and turns each
 * approval into an `approve-request` the host answers via {@link submitDecision}.
 * Under `auto`, approvals resolve true immediately (still announced, for the log).
 */
export class StreamJsonSession {
  private nextId = 1;
  private readonly pending = new Map<number, (approve: boolean) => void>();

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
    // Register the resolver BEFORE emitting, so a host that answers synchronously
    // (or very fast) can't have its decision arrive before we're listening.
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, resolve);
      this.emit({ event: 'approve-request', id, action });
    });
  };

  /** Host → agent: resolve a pending approval. Unknown ids are ignored. */
  submitDecision(id: number, approve: boolean): void {
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(approve);
    }
  }

  /** Reject any still-pending approvals (e.g. the host disconnected). */
  cancelPending(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
  }
}

export interface StreamJsonOptions extends Omit<AgentOptions, 'approve' | 'onEvent'> {
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
    const result = await runAgent({ ...agentOptions, auto, approve: session.approve, onEvent: session.onEvent });
    emit({ event: 'done', result });
    return result;
  } catch (e) {
    emit({ event: 'error', message: (e as Error).message });
    return null;
  } finally {
    session.cancelPending();
  }
}
