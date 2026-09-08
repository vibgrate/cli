/**
 * Shared contract for the context-compression layer.
 *
 * Everything under `src/compress/`, `src/proxy/`, `src/memory/`, `src/learn/`
 * and `src/wrap/` builds against these types. Keep this file dependency-free
 * (types + tiny pure helpers only) so any module can import it without cycles.
 *
 * Conventions (mirroring the rest of vg):
 *  - Determinism: identical input → identical output. No wall-clock reads in
 *    anything that reaches the wire; callers inject `now` when a timestamp is
 *    genuinely needed (TTLs, ledgers).
 *  - Fail open: a compressor that throws, inflates, or blanks non-empty input is
 *    treated as "no compression" — the original bytes are forwarded.
 *  - Redact at ingest: any original stored for later retrieval passes through
 *    `redactText` (src/code/secrets.ts) before it is persisted.
 */

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

/** Wire formats the layer understands. */
export type MessageFormat = 'openai' | 'anthropic' | 'vercel' | 'gemini' | 'responses';

/**
 * A chat message in any supported wire format. Kept deliberately loose: the
 * pipeline treats messages as opaque records and only touches the fields it
 * understands (`role`, `content`, `tool_calls`, `tool_call_id`, `parts`, …).
 */
export type Message = Record<string, unknown>;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [k: string]: unknown;
}

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
  [k: string]: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
  [k: string]: unknown;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
  [k: string]: unknown;
}
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControl;
  [k: string]: unknown;
}
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
  cache_control?: CacheControl;
  [k: string]: unknown;
}
export interface AnthropicOtherBlock {
  type: 'image' | 'thinking' | 'redacted_thinking' | 'document' | 'server_tool_use' | string;
  cache_control?: CacheControl;
  [k: string]: unknown;
}
export type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicOtherBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Content detection
// ---------------------------------------------------------------------------

/** What a block of text looks like. Drives compressor routing. */
export type ContentType =
  | 'json'
  | 'source_code'
  | 'search_results'
  | 'build_output'
  | 'git_diff'
  | 'html'
  | 'tabular'
  | 'structured_config'
  | 'plain_text';

export interface DetectionResult {
  type: ContentType;
  /** 0..1 — the detector's own confidence; each type has a floor before it wins. */
  confidence: number;
  /** Free-form, type-specific facts (item counts, language, header counts, …). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compressors
// ---------------------------------------------------------------------------

/** Which compressor produced (or declined) a rewrite. Stable telemetry tags. */
export type Strategy =
  | 'smart_crusher'
  | 'code_aware'
  | 'search'
  | 'log'
  | 'diff'
  | 'html'
  | 'tabular'
  | 'config'
  | 'text'
  | 'lossless'
  | 'mixed'
  | 'passthrough';

/** Deterministic, offline token accounting. `id` names the family for labels. */
export interface Tokenizer {
  id: string;
  count(text: string): number;
}

/** Where compressors stash the original bytes they drop (see `ccr/store.ts`). */
export interface CcrSink {
  /**
   * Persist `original` and return the hash the marker should carry. The sink
   * derives the hash from content (sha256 of the original, truncated) unless an
   * explicit hash is supplied, so identical originals share one entry.
   */
  store(original: string, meta: CcrStoreMeta): string;
  /** Whether a hash is currently retrievable (pure, no TTL cleanup). */
  exists(hash: string): boolean;
}

export interface CcrStoreMeta {
  compressed: string;
  strategy: Strategy | string;
  originalTokens?: number;
  compressedTokens?: number;
  originalItemCount?: number;
  compressedItemCount?: number;
  toolName?: string;
  toolCallId?: string;
  queryContext?: string;
  /** Override the content-derived hash (12 or 24 hex chars). */
  explicitHash?: string;
  /** Seconds; falls back to the store default. */
  ttlSeconds?: number;
}

export interface CompressRequest {
  content: string;
  /** Relevance context (user ask + tool-call args). Empty = position-only. */
  query?: string;
  /** Multiplier on the adaptive keep budget: >1 keeps more, <1 compresses harder. */
  bias?: number;
  toolName?: string;
  /** Language hint for code (extension or fence tag). */
  language?: string;
  ccr?: CcrSink | null;
  tokenizer: Tokenizer;
  /** Emit markers that reference stored originals (false = marker-free lossy or lossless only). */
  injectMarker: boolean;
  /** Only byte-reversible folds may run; never emit a marker. */
  losslessOnly: boolean;
  /** Keep ratio hint for text compression (0.1..1). */
  targetRatio?: number;
  /** Per-tool profile (max items etc.). */
  profile?: ToolProfile;
}

export interface CompressResponse {
  content: string;
  strategy: Strategy;
  /** Ordered chain of steps that ran, e.g. ['lossless_search', 'text']. */
  chain: string[];
  ccrHashes: string[];
  /** Short human-readable detail, e.g. `smart_sample(1000->15)`. */
  info?: string;
  itemCounts?: { original: number; kept: number };
}

export interface Compressor {
  readonly strategy: Strategy;
  compress(req: CompressRequest): CompressResponse;
}

export interface ToolProfile {
  /** Never compress this tool's output (byte-exact). */
  skipCompression?: boolean;
  /** Lossless folds only. */
  losslessOnly?: boolean;
  maxItemsAfterCrush?: number;
  minTokensToCompress?: number;
  /** Bias applied to the adaptive keep budget. */
  bias?: number;
  /** Substrings that pin an item/line (case-insensitive). */
  preserveKeywords?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline (message level)
// ---------------------------------------------------------------------------

export type ProxyMode = 'cache' | 'token';

export type ProfileName = 'coding' | 'balanced' | 'aggressive' | 'general';

export interface ReadLifecycleOptions {
  enabled?: boolean;
  /** Replace reads of files edited later in the conversation with a marker. */
  compressStale?: boolean;
  /** Replace reads fully covered by a later read (off: busts prefix cache). */
  compressSuperseded?: boolean;
  minSizeBytes?: number;
}

export interface CompressionHooks {
  /** Rewrite messages before compression (dedup, injection, filtering). */
  preCompress?(messages: Message[], ctx: CompressContext): Message[] | Promise<Message[]>;
  /** Per-message aggressiveness: index → factor (>1 keep more, <1 compress harder). */
  computeBiases?(messages: Message[], ctx: CompressContext): Record<number, number> | Promise<Record<number, number>>;
  /** Observe the outcome (analytics, learning). Never mutates. */
  postCompress?(event: CompressEvent): void | Promise<void>;
}

export interface CompressContext {
  model: string;
  userQuery: string;
  turnNumber: number;
  toolCalls: string[];
  provider: string;
}

export interface CompressEvent {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transformsApplied: string[];
  ccrHashes: string[];
  model: string;
  userQuery: string;
  provider: string;
}

export interface CompressOptions {
  /** Model id — selects the tokenizer family and the context limit. */
  model?: string;
  /** Context window override (tokens). */
  modelLimit?: number;
  tokenizer?: Tokenizer;
  /** `cache` compresses only the newest delta (prefix-cache safe); `token` maximizes removal. */
  mode?: ProxyMode;
  profile?: ProfileName;
  compressUserMessages?: boolean;
  compressSystemMessages?: boolean;
  compressAssistantText?: boolean;
  /** Don't compress code inside the last N messages. */
  protectRecent?: number;
  protectAnalysisContext?: boolean;
  /** Leading messages already in the provider's prompt cache; never rewritten. */
  frozenMessageCount?: number;
  /** Keep ratio for text compression; undefined = adaptive. */
  targetRatio?: number;
  /** Per-message floor before anything is attempted. */
  minTokensToCompress?: number;
  /** Per-block floor (chars) for list-content blocks. */
  minCharsForBlock?: number;
  /** Tool names whose output is never lossy-compressed (lossless folds still allowed). */
  protectToolResults?: string[];
  /** Tool names whose output must stay byte-exact (no folds either). */
  byteExactTools?: string[];
  /** Protect file-read outputs (cat/head/Read) so read-then-edit stays byte-exact. */
  protectReads?: boolean;
  ccr?: {
    enabled?: boolean;
    injectMarker?: boolean;
    store?: CcrSink | null;
    ttlSeconds?: number;
  };
  /** Only byte-reversible folds; never a marker, never lossy. */
  lossless?: boolean;
  /** Run lossy on top of a fold when it beats the fold by ≥ `lossyMinExtraSavings`. */
  losslessThenLossy?: boolean;
  lossyMinExtraSavings?: number;
  /** Replace verbatim repeats of earlier tool output with an in-context pointer. */
  crossTurnDedup?: boolean;
  /** Whether pointers can be redeemed (false on paths with no retrieve tool). */
  crossTurnDedupRecoverable?: boolean;
  readLifecycle?: ReadLifecycleOptions;
  /** AST-aware code compression. */
  codeAware?: boolean;
  /** Restrict to these compressors. */
  compressors?: Strategy[];
  /** Per-message aggressiveness factors (index → factor). */
  biases?: Record<number, number>;
  hooks?: CompressionHooks;
  /** Relevance context override; default = latest user ask + tool-call args. */
  query?: string;
  toolProfiles?: Record<string, ToolProfile>;
  /** Compact prior-turn reasoning on models that bill it (opt-in). */
  thinkingCompact?: boolean;
  thinkingCompactKeepLast?: number;
  /** Provider hint when it cannot be inferred from the messages. */
  provider?: string;
  /** Force passthrough (A/B baseline). */
  optimize?: boolean;
  /** Injected clock for TTL bookkeeping; never reaches the wire. */
  now?: () => number;
}

export type ExclusionReason =
  | 'below_frozen_floor'
  | 'above_live_zone'
  | 'hot_zone_block_type'
  | 'protected_role'
  | 'protected_tool'
  | 'protected_read'
  | 'protected_recent_code'
  | 'protected_analysis_context'
  | 'protected_error_output'
  | 'already_compressed'
  | 'retrieve_result'
  | 'cache_control'
  | 'non_string';

export type BlockAction =
  | { kind: 'no_compression'; contentType: ContentType }
  | {
      kind: 'compressed';
      strategy: Strategy;
      chain: string[];
      originalBytes: number;
      compressedBytes: number;
      originalTokens: number;
      compressedTokens: number;
      ccrHashes: string[];
    }
  | { kind: 'compressor_error'; strategy: Strategy; error: string }
  | { kind: 'rejected_not_smaller'; strategy: Strategy; originalTokens: number; compressedTokens: number }
  | { kind: 'rejected_unrecoverable'; strategy: Strategy }
  | { kind: 'below_threshold'; contentType?: ContentType; bytes: number; threshold: number }
  | { kind: 'excluded'; reason: ExclusionReason };

export interface BlockOutcome {
  messageIndex: number;
  /** undefined for string-shaped content. */
  blockIndex?: number;
  blockType: string;
  action: BlockAction;
}

export interface CompressionManifest {
  messagesTotal: number;
  messagesBelowFrozenFloor: number;
  latestUserMessageIndex: number | null;
  blockOutcomes: BlockOutcome[];
}

export interface CompressResult {
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** Fraction saved (0 = nothing, 0.6 = 60% removed). */
  compressionRatio: number;
  /** after/before — lower is better; 1 when nothing changed. */
  keptRatio: number;
  /** Ordered transform labels, e.g. `router:smart_crusher:0.35`. */
  transformsApplied: string[];
  transformsSummary: Record<string, number>;
  ccrHashes: string[];
  compressed: boolean;
  manifest: CompressionManifest;
  /** Volatile-prefix / stable-prefix markers emitted by the cache aligner. */
  markersInserted: string[];
  warnings: string[];
  /** Detected input format (the result is returned in the same format). */
  format: MessageFormat;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `router:<strategy>:<keptRatio>` — the label a compressed block contributes. */
export function routerLabel(strategy: string, keptRatio: number): string {
  return `router:${strategy}:${keptRatio.toFixed(2)}`;
}

/**
 * Whether a `CompressResponse` dropped nothing, from its chain alone.
 *
 * A lossless step is recorded as the **first** chain entry (`lossless_json`,
 * `lossless_search`, …); the entries after it name the compressor that produced
 * it, so `['lossless_json', 'smart_crusher']` is a lossless csv-schema table,
 * not a sample. Testing every entry instead would call that result lossy, and a
 * lossless result carries no retrieval marker — the two together would get it
 * rejected as unrecoverable. Router and pipeline share this one predicate so
 * they cannot disagree about it again.
 */
export function isLosslessResult(chain: readonly string[], strategy: Strategy | string): boolean {
  return strategy === 'lossless' || (chain[0]?.startsWith('lossless') ?? false);
}

/** Sentinel substrings that mark content as already compressed (never re-compress). */
export const ALREADY_COMPRESSED_MARKERS: readonly string[] = ['Retrieve more: hash=', 'Retrieve original: hash=', '<<vg-ccr:'];

export function isAlreadyCompressed(text: string): boolean {
  for (const m of ALREADY_COMPRESSED_MARKERS) if (text.includes(m)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Small pure helpers shared across modules
// ---------------------------------------------------------------------------

/** Round half to even (banker's rounding) — parity with Python's `round()`. */
export function roundTiesEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Clamp a number into [lo, hi]; NaN → lo. */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** True for CJK / Hangul / full-width code points (dense scripts). */
export function isDenseScript(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

/** Text content of a message regardless of shape (string, OpenAI parts, Anthropic blocks). */
export function messageText(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'tool_result') {
        const inner = block.content;
        if (typeof inner === 'string') parts.push(inner);
        else if (Array.isArray(inner)) {
          for (const b of inner as Array<Record<string, unknown>>) if (b && typeof b.text === 'string') parts.push(b.text);
        }
      }
    }
    return parts.join('\n');
  }
  const parts = message.parts;
  if (Array.isArray(parts)) {
    return (parts as Array<Record<string, unknown>>)
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
