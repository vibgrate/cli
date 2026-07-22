/**
 * `vg code` — the code capability (VG-CLI-CODE §1).
 *
 * A graph-grounded, governance-gated coding loop: it assembles a
 * budget-bounded, deterministic context from the code graph, asks a *routed*
 * model for a terse edit, applies that edit through a deterministic fast-apply
 * merge, and proposes the result as a diff. It never writes without consent —
 * dry-run is the default and the write path routes through the same
 * inspect → assess → dry-run → approve → execute → verify → log lifecycle the
 * rest of the platform enforces (GUARDRAILS §5).
 *
 * These shapes are the contract between the subsystem's parts (context,
 * providers, router, apply, session). Nothing here reaches `graph.json`, so the
 * artifact stays byte-deterministic; the only non-deterministic surface is the
 * model call itself, which is isolated behind {@link Provider}.
 */

import type { GraphNode } from '../schema.js';

/** A tool the model may call, as a JSON-schema function spec (OpenAI-compatible). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** A single tool invocation the model asked for. */
export interface ToolCall {
  /** Provider-supplied id (synthesized for backends that omit one). */
  id: string;
  name: string;
  /** Parsed argument object (providers hand back a JSON string; we parse it). */
  arguments: Record<string, unknown>;
}

/** A chat turn sent to a model. Ordering is cache-stable (see router.ts). */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

/** What a provider returns for one completion. Usage is best-effort (may be absent). */
export interface ProviderResult {
  text: string;
  model: string;
  provider: string;
  /** Tool calls the model requested this turn (agentic loop), if any. */
  toolCalls?: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
  /** True when the router fell back to a lower-preference provider. */
  fellBack?: boolean;
}

/** Options a caller passes to a completion (kept minimal + provider-neutral). */
export interface ChatOptions {
  /** Soft cap on output tokens; providers map to their own field. */
  maxTokens?: number;
  /** Deterministic decoding is preferred for code — 0 unless overridden. */
  temperature?: number;
  /** Abort the request if it hasn't started returning within this many ms. */
  timeoutMs?: number;
  /** Tools the model may call this turn (enables agentic tool-calling). */
  tools?: ToolSpec[];
  /** Request a streamed response (providers that support it call `onToken`). */
  stream?: boolean;
  /** Called with each text delta as it streams in. */
  onToken?: (text: string) => void;
}

/**
 * A model backend. The ONLY non-deterministic seam in the subsystem. Local
 * (Ollama / LM Studio / llama.cpp) and hosted (OpenAI-compatible: OpenRouter,
 * LiteLLM, …) both implement this; a deterministic {@link MockProvider} backs
 * the tests and the offline floor.
 */
export interface Provider {
  /** Stable id, e.g. `ollama`, `openai-compatible`, `mock`. */
  readonly id: string;
  /** Human label for messages, e.g. `Ollama (local)`. */
  readonly label: string;
  /** True for on-device backends — selected under `--local`, never billed, no egress. */
  readonly local: boolean;
  /** The concrete model id this instance will call. */
  readonly model: string;
  /** Run a completion. Rejects with an actionable, internals-free Error. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ProviderResult>;
}

/** A single edit the model proposed, in the deterministic search/replace form. */
export type CodeEdit =
  | { op: 'replace'; file: string; search: string; replace: string; anchorSymbol?: string }
  | { op: 'create'; file: string; content: string }
  | { op: 'delete'; file: string };

/** The outcome of applying ONE edit to a file's current content. */
export interface EditOutcome {
  edit: CodeEdit;
  status: 'applied' | 'no-op' | 'ambiguous' | 'not-found' | 'conflict' | 'invalid';
  /** Actionable, internals-free reason when not `applied` (GUARDRAILS §1.3). */
  reason?: string;
  /** How the SEARCH text was located — evidence for the audit trail. */
  matchedBy?: 'exact' | 'whitespace' | 'graph-span';
}

/** The proposed new content for a file after applying its edits (dry-run product). */
export interface FileChange {
  file: string;
  before: string | null; // null = file did not exist (a create)
  after: string | null; // null = file was deleted
  outcomes: EditOutcome[];
  diff: string; // unified diff, before → after
}

/** The graph-grounded context handed to the model, plus what fed it. */
export interface CodeContext {
  instruction: string;
  /** Symbols the retrieval surfaced as most relevant, with their relations. */
  seeds: { node: GraphNode; why: string }[];
  /** Files the edit is expected to touch, in stable order. */
  targetFiles: string[];
  /** Blast radius: symbols that call/depend on the seeds (impact-aware review). */
  impacted: { node: GraphNode; via: string }[];
  /** Hard constraints (declared facts) pinned so compaction can't drop them. */
  pinnedFacts: string[];
  /** The rendered, budget-bounded prompt block. */
  rendered: string;
  tokensEstimate: number;
}

/** One phase of the governance lifecycle, recorded for the audit trail. */
export type LifecyclePhase =
  | 'inspect'
  | 'assess'
  | 'dry-run'
  | 'approve'
  | 'execute'
  | 'verify'
  | 'log';

/** The full result of a `vg code` run — the same object `--json` serializes. */
export interface CodeSessionResult {
  instruction: string;
  provider: { id: string; model: string; local: boolean; fellBack: boolean };
  phasesRun: LifecyclePhase[];
  changes: FileChange[];
  /** True only when files were actually written (never in dry-run). */
  applied: boolean;
  /** Post-write verification summary (or the reason it was skipped). */
  verification: { ran: boolean; ok: boolean; detail: string };
  /** A resolvable correlation id, echoed on every error (GUARDRAILS §1.3). */
  correlationId: string;
}
