/**
 * What the proxy consumes from the compression core, the pipeline, the CCR
 * store and the memory layer — expressed as *structural* interfaces so the
 * proxy can be built and tested against fakes while those modules are being
 * written, and so a runtime whose optional module is absent degrades to a
 * typed fallback (fail open, never a crash).
 *
 * The shapes mirror DESIGN.md §3.1 / §3.2 / §3.5 exactly; `loadDefaultDeps`
 * (see `./fallbacks.ts`) binds the real modules when they resolve.
 */

import type { CompressOptions, CompressResult, Message, MessageFormat, Tokenizer } from '../compress/types.js';

export interface RetrieveCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RetrieveResult {
  content: string;
  found: boolean;
  hash?: string;
  truncated?: boolean;
}

export interface StoredEntryLike {
  hash: string;
  original: string;
  compressed: string;
  strategy: string;
  originalTokens: number;
  compressedTokens: number;
  originalItemCount?: number;
  compressedItemCount?: number;
  toolName?: string;
  createdAt: number;
  expiresAt: number;
  status: string;
}

export interface StoreStatsLike {
  entries: number;
  maxEntries?: number;
  ttlSeconds?: number;
  [k: string]: unknown;
}

/** The subset of `CompressionStore` (§3.2) the proxy touches. */
export interface StoreLike {
  exists(hash: string): boolean;
  get(hash: string): StoredEntryLike | null;
  stats(): StoreStatsLike;
  purgeExpired?(): number;
}

export interface SseEventLike {
  event?: string;
  data: string;
}

export interface MemoryLike {
  /** Ranked memories rendered as the injection block; empty string = nothing to inject. */
  injection(query: string, opts: { topK: number; maxTokens?: number }): string;
  tools(format: MessageFormat): Record<string, unknown>[];
  handleTool(name: string, args: Record<string, unknown>): { content: string; isError?: boolean };
  /** Passive learning from traffic; never throws. */
  observe?(messages: Message[], response?: Record<string, unknown>): void;
}

export interface SavingsEventLike {
  ts: number;
  source: 'proxy' | 'mcp' | 'sdk' | 'cli';
  model: string;
  client: string;
  project?: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  usdSaved: number;
  transforms: string[];
  ccrHashes: number;
  outputTokensSaved?: number;
}

export interface SavingsRollupLike {
  window: 'today' | '7d' | '30d' | 'all';
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  usdSaved: number;
  byModel: Record<string, { requests: number; tokensSaved: number; usdSaved: number }>;
  byClient: Record<string, { requests: number; tokensSaved: number; usdSaved: number }>;
  byProject: Record<string, { requests: number; tokensSaved: number; usdSaved: number }>;
}

export interface PriceLike {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Everything the proxy needs from the rest of the layer. */
export interface ProxyDeps {
  now: () => number;
  fetch: typeof fetch;
  /** Injected timer so retry backoff / heartbeats are testable. */
  sleep: (ms: number) => Promise<void>;

  compressMessages: (messages: Message[], options?: CompressOptions) => Promise<CompressResult>;
  tokenizerFor: (model?: string) => Tokenizer;
  store: StoreLike | null;

  retrieveToolName: string;
  retrieveTool: (format: MessageFormat) => Record<string, unknown>;
  isRetrieveToolCall: (name: string) => boolean;
  findMarkers: (text: string) => Array<{ hash: string }>;
  executeRetrieve: (args: Record<string, unknown>, opts?: { maxTokens?: number }) => RetrieveResult;
  extractRetrieveCalls: (response: Record<string, unknown>, format: MessageFormat) => RetrieveCall[];
  buildRetrieveResultMessages: (calls: RetrieveCall[], results: Array<{ content: string }>, format: MessageFormat) => Message[];
  neutralizeRetrieveHistory: (messages: Message[], format: MessageFormat) => Message[];
  maxRetrieveRounds: number;

  reconstructAnthropic: (events: SseEventLike[]) => Record<string, unknown> | null;
  reconstructOpenAIChat: (events: SseEventLike[]) => Record<string, unknown> | null;
  reconstructOpenAIResponses: (events: SseEventLike[]) => Record<string, unknown> | null;

  appendSavingsEvent: (ev: SavingsEventLike, env?: NodeJS.ProcessEnv) => void;
  readSavingsEvents: (env?: NodeJS.ProcessEnv, opts?: { sinceMs?: number; now?: number }) => SavingsEventLike[];
  rollupSavings: (events: SavingsEventLike[], now: number) => Record<'today' | '7d' | '30d' | 'all', SavingsRollupLike>;

  priceFor: (model: string, env?: NodeJS.ProcessEnv) => PriceLike;
  costUsd: (model: string, usage: UsageLike, env?: NodeJS.ProcessEnv) => number;

  /** Optional: pre-load parsers etc. at startup. */
  warmRouter?: () => Promise<void>;
  /** Optional plain-text compressor used by system-prompt compaction. */
  compressText?: (text: string) => string | null;
  /** Memory layer (only bound when `--memory`). */
  memory: MemoryLike | null;
}
