/**
 * Vibgrate llm-host library — one codebase, two deployments (ADR-005).
 *
 * - **embedded** (default, Approach B): same process as vgd / agent
 * - **process**: thin shell around this library; Model Orchestrator stays in vgd
 *
 * Management (Code Modes, fit, packs, install) is NEVER owned here.
 */

export type LlmHostIsolation = 'embedded' | 'process';

export interface LlmHostConfig {
  isolation: LlmHostIsolation;
  /** GGUF or backend-specific model path / id. */
  modelRef: string;
  /** Optional grammar (GBNF / JSON schema string) for constrained decode. */
  grammar?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** When set, host should constrain sampling to this grammar if supported. */
  grammar?: string;
  /** Fail if grammar cannot be attached (Spark / constrained packs). */
  requireGrammar?: boolean;
  /**
   * When set, post-validate (and annotate) free-text identifiers against the
   * repo trie. Full logit masking is binding-dependent; this is the portable path.
   */
  identifierTrie?: import('../identifier-trie.js').TrieNode;
  /** When true with a trie, append an unknown-identifier note to the text. */
  annotateUnknownIdentifiers?: boolean;
  /** Verbatim graph spans for speculative draft acceptance. */
  draftCandidates?: string[];
  /** Ordered prompt segments for KV hit/miss planning. */
  promptSegments?: Array<{ kind: string; text: string }>;
}

export interface LlmGenerateResult {
  text: string;
  model: string;
  isolation: LlmHostIsolation;
  /** True when grammar was applied at sample time. */
  constrained: boolean;
  /** Unknown identifiers vs the trie (when scanned). */
  unknownIdentifiers?: string[];
}

export interface LlmMemoryReport {
  isolation: LlmHostIsolation;
  modelRef: string | null;
  loaded: boolean;
}

/**
 * Inference surface only. Load/unload policy and pack choice live in the
 * Model Orchestrator (`vgd`); this host executes them.
 */
export interface LlmHost {
  readonly isolation: LlmHostIsolation;
  load(modelRef: string): Promise<void>;
  unload(): Promise<void>;
  generate(messages: LlmChatMessage[], opts?: LlmGenerateOptions): Promise<LlmGenerateResult>;
  memoryReport(): LlmMemoryReport;
  /** True when this host can apply GBNF / CFG at sample time. */
  supportsConstrainedDecoding(): boolean;
}
