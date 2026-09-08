/**
 * Message-level compression pipeline.
 *
 * `compressMessages` takes a conversation in any supported wire format and
 * returns it in the same format with eligible blocks rewritten. The walk is
 * single-pass and left-to-right; every block gets a `BlockOutcome` in the
 * manifest so a dry run explains exactly why each byte stayed or went.
 *
 * Order of work (each step fails open):
 *   1. resolve options (explicit > env > profile), detect format, deep-clone
 *   2. hooks: preCompress, computeBiases
 *   3. thinking compaction (models that bill prior reasoning)
 *   4. read lifecycle (stale / superseded) and read maturation (session)
 *   5. cache aligner (detector only → warnings)
 *   6. per-block compression through the content router
 *   7. cross-turn dedup of repeated tool output
 *   8. inflation guard, token accounting, manifest, postCompress hook
 *
 * Determinism: no wall-clock reads reach the output; `now` is injected and
 * used only for TTLs and the deadline. Identical input → identical output.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { countTokens } from '../engine/tokens.js';
import { analyzeCachePrefix } from './cache-aligner.js';
import { CompressionStore, defaultStore, hashOriginal } from './ccr/store.js';
import { extractHashes, hasMarkers } from './ccr/markers.js';
import { ContextTracker, extractKeywords } from './ccr/tracker.js';
import { RETRIEVE_TOOL_NAME } from './ccr/tool.js';
import { activeProfile, env as knobs, envWithProfile, READ_TOOL_NAMES, resolveToolProfiles } from './config.js';
import { dedupBlocks, type DedupBlock } from './dedup.js';
import { detectFormat, enumerateBlocks, extractUserQuery, lastAssistantIndex, latestUserMessageIndex, toolArgsIndex, type EnumeratedBlock } from './format.js';
import { buildContext, runComputeBiases, runComputeBiasesSync, runPostCompress, runPostCompressSync, runPreCompress, runPreCompressSync } from './hooks.js';
import { applyReadLifecycle, ReadMaturation } from './read-lifecycle.js';
import { billsPriorThinkingHeuristic, compactThinking } from './thinking.js';
import {
  isAlreadyCompressed,
  isLosslessResult,
  routerLabel,
  type BlockAction,
  type BlockOutcome,
  type CompressEvent,
  type CompressOptions,
  type CompressRequest,
  type CompressResult,
  type Compressor,
  type CompressionManifest,
  type ContentType,
  type ExclusionReason,
  type Message,
  type MessageFormat,
  type ProfileName,
  type ProxyMode,
  type Strategy,
  type Tokenizer,
  type ToolProfile,
} from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  router?: Compressor;
  tokenizer?: Tokenizer;
  /** `null` disables CCR; undefined = `options.ccr.store` or the process default store. */
  store?: CompressionStore | null;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Override for the model-registry check behind thinking compaction (tests). */
  billsThinking?: (model: string) => boolean;
}

export interface ReadMaturationOptions {
  enabled: boolean;
  quiesceTurns: number;
  maxHoldTurns: number;
  minSizeBytes: number;
}

export interface ResolvedOptions extends CompressOptions {
  model: string;
  mode: ProxyMode;
  profile: ProfileName;
  compressUserMessages: boolean;
  compressSystemMessages: boolean;
  compressAssistantText: boolean;
  protectRecent: number;
  protectAnalysisContext: boolean;
  frozenMessageCount: number;
  minTokensToCompress: number;
  minCharsForBlock: number;
  protectToolResults: string[];
  byteExactTools: string[];
  protectReads: boolean;
  readMinChars: number;
  lossless: boolean;
  losslessThenLossy: boolean;
  lossyMinExtraSavings: number;
  crossTurnDedup: boolean;
  crossTurnDedupRecoverable: boolean;
  codeAware: boolean;
  thinkingCompact: boolean;
  thinkingCompactKeepLast: number;
  optimize: boolean;
  biases: Record<number, number>;
  toolProfiles: Record<string, ToolProfile>;
  readLifecycle: { enabled: boolean; compressStale: boolean; compressSuperseded: boolean; minSizeBytes: number };
  readMaturation: ReadMaturationOptions;
  ccr: { enabled: boolean; injectMarker: boolean; store?: CompressionStore | null; ttlSeconds?: number };
  deadlineMs: number;
  freezeBlockDecision: boolean;
  maxFrozenVerdicts: number;
  errorProtectionMaxChars: number;
  profileBias: number;
  provider: string;
}

const READ_SET = new Set(READ_TOOL_NAMES);
const BASH_TOOLS = new Set(['bash', 'shell', 'local_shell', 'run_command', 'execute_command', 'run_terminal_cmd', 'terminal', 'sh']);
export const ERROR_PROTECTION_MAX_CHARS = 8000;
const RELEASABLE_READ_TYPES = new Set<ContentType>(['json', 'search_results', 'build_output', 'git_diff', 'html', 'tabular']);

/** Explicit options > `VG_*` env > profile defaults. Pure. */
export function resolveOptions(options: CompressOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedOptions {
  const profile = activeProfile(options.profile, env);
  const e = envWithProfile(profile, env);
  const bool = (name: string, explicit: boolean | undefined): boolean => (explicit !== undefined ? explicit : knobs.bool(name, e));
  const int = (name: string, explicit: number | undefined, min = 0): number => (explicit !== undefined && Number.isFinite(explicit) ? Math.max(min, Math.floor(explicit)) : knobs.int(name, e, { min }));
  const toolProfiles = { ...resolveToolProfiles(profile, e), ...(options.toolProfiles ?? {}) };
  const protectToolResults = options.protectToolResults ?? knobs.list('VG_COMPRESS_PROTECT_TOOL_RESULTS', e);
  for (const name of protectToolResults) toolProfiles[name] = { ...(toolProfiles[name] ?? {}), losslessOnly: true };
  const byteExactTools = options.byteExactTools ?? knobs.list('VG_COMPRESS_EXCLUDE_TOOLS', e);
  for (const name of byteExactTools) toolProfiles[name] = { ...(toolProfiles[name] ?? {}), skipCompression: true };
  const targetRatio = options.targetRatio ?? knobs.optFloat('VG_COMPRESS_TARGET_RATIO', e);
  const out: ResolvedOptions = {
    ...options,
    model: options.model ?? '',
    mode: options.mode ?? knobs.enum<ProxyMode>('VG_COMPRESS_MODE', e),
    profile: profile.name,
    compressUserMessages: bool('VG_COMPRESS_USER_MESSAGES', options.compressUserMessages),
    compressSystemMessages: bool('VG_COMPRESS_SYSTEM_MESSAGES', options.compressSystemMessages),
    compressAssistantText: bool('VG_COMPRESS_ASSISTANT_TEXT', options.compressAssistantText),
    protectRecent: int('VG_COMPRESS_PROTECT_RECENT', options.protectRecent),
    protectAnalysisContext: bool('VG_COMPRESS_PROTECT_ANALYSIS_CONTEXT', options.protectAnalysisContext),
    frozenMessageCount: Math.max(0, Math.floor(options.frozenMessageCount ?? 0)),
    minTokensToCompress: int('VG_COMPRESS_MIN_TOKENS', options.minTokensToCompress),
    minCharsForBlock: int('VG_COMPRESS_MIN_CHARS_FOR_BLOCK', options.minCharsForBlock),
    protectToolResults,
    byteExactTools,
    protectReads: bool('VG_COMPRESS_PROTECT_READS', options.protectReads),
    readMinChars: knobs.int('VG_COMPRESS_READ_MIN_CHARS', e, { min: 0 }),
    lossless: bool('VG_COMPRESS_LOSSLESS', options.lossless),
    losslessThenLossy: bool('VG_COMPRESS_LOSSLESS_THEN_LOSSY', options.losslessThenLossy),
    lossyMinExtraSavings: options.lossyMinExtraSavings ?? knobs.float('VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS', e, { min: 0, max: 1 }),
    crossTurnDedup: bool('VG_COMPRESS_DEDUPE', options.crossTurnDedup),
    crossTurnDedupRecoverable: options.crossTurnDedupRecoverable ?? true,
    codeAware: bool('VG_COMPRESS_CODE_AWARE', options.codeAware),
    thinkingCompact: bool('VG_COMPRESS_THINKING_COMPACT', options.thinkingCompact),
    thinkingCompactKeepLast: int('VG_COMPRESS_THINKING_COMPACT_KEEP_LAST', options.thinkingCompactKeepLast),
    optimize: options.optimize !== undefined ? options.optimize : knobs.bool('VG_COMPRESS', e),
    biases: options.biases ?? {},
    toolProfiles,
    readLifecycle: {
      enabled: options.readLifecycle?.enabled ?? knobs.bool('VG_COMPRESS_READ_LIFECYCLE', e),
      compressStale: options.readLifecycle?.compressStale ?? true,
      compressSuperseded: options.readLifecycle?.compressSuperseded ?? knobs.bool('VG_COMPRESS_READ_SUPERSEDED', e),
      minSizeBytes: options.readLifecycle?.minSizeBytes ?? 512,
    },
    readMaturation: {
      enabled: knobs.bool('VG_COMPRESS_READ_MATURATION', e),
      quiesceTurns: knobs.int('VG_COMPRESS_READ_MATURATION_QUIESCE_TURNS', e, { min: 1 }),
      maxHoldTurns: knobs.int('VG_COMPRESS_READ_MATURATION_MAX_HOLD_TURNS', e, { min: 1 }),
      minSizeBytes: knobs.int('VG_COMPRESS_READ_MATURATION_MIN_SIZE_BYTES', e, { min: 0 }),
    },
    ccr: {
      enabled: options.ccr?.enabled ?? knobs.bool('VG_CCR', e),
      injectMarker: options.ccr?.injectMarker ?? true,
      store: options.ccr?.store as CompressionStore | null | undefined,
      ttlSeconds: options.ccr?.ttlSeconds,
    },
    deadlineMs: knobs.int('VG_COMPRESS_DEADLINE_MS', e, { min: 0 }),
    freezeBlockDecision: knobs.bool('VG_COMPRESS_FREEZE_BLOCK_DECISION', e),
    maxFrozenVerdicts: knobs.int('VG_COMPRESS_FROZEN_VERDICTS_MAX', e, { min: 1 }),
    errorProtectionMaxChars: ERROR_PROTECTION_MAX_CHARS,
    profileBias: profile.bias,
    provider: options.provider ?? '',
  };
  if (targetRatio !== undefined) out.targetRatio = Math.min(1, Math.max(0.1, targetRatio));
  if (out.lossless) out.ccr = { ...out.ccr, injectMarker: false };
  return out;
}

// ---------------------------------------------------------------------------
// Default dependencies (core modules are loaded lazily; absent = passthrough)
// ---------------------------------------------------------------------------

const DEFAULT_TOKENIZER: Tokenizer = { id: 'cl100k', count: countTokens };

let loadedRouter: Compressor | null | undefined;
let loadedTokenizerFor: ((model?: string) => Tokenizer) | null | undefined;
let loadedModelInfo: ((model: string, env?: NodeJS.ProcessEnv) => { billsThinking?: boolean }) | null | undefined;

type RouteFn = (text: string, hint?: { toolName?: string; language?: string }) => { type: ContentType; strategy: Strategy; reason: string };

/** Register the process-wide default router (the orchestrator calls this with `createRouter()`). */
export function setDefaultRouter(router: Compressor | null): void {
  loadedRouter = router;
}

/** The default router when it has been loaded (sync callers), else null. */
export function getDefaultRouter(): Compressor | null {
  return loadedRouter ?? null;
}

/**
 * Literal `import('…')` thunks only: the bundler must see each specifier to
 * emit its chunk. A dynamic import whose specifier is a runtime string is
 * invisible to esbuild/tsup, so the published `dist/` had no router to bind
 * and every block recorded `no_compression` while the same code from source
 * compressed. Keep the thunk shape (guarded by src/proxy/fallbacks.test.ts).
 */
async function importOptional<T>(load: () => Promise<unknown>): Promise<T | null> {
  try {
    return (await load()) as T;
  } catch {
    return null;
  }
}

/** Load the core modules once (router, tokenizer family, model registry). Never throws. */
export async function loadDefaultDeps(): Promise<{ router: Compressor | null }> {
  if (loadedRouter === undefined) {
    const mod = await importOptional<{ createRouter?: () => Compressor; warmRouter?: () => Promise<void> }>(() => import('./router.js'));
    if (mod && typeof mod.createRouter === 'function') {
      try {
        if (typeof mod.warmRouter === 'function') await mod.warmRouter().catch(() => undefined);
        setDefaultRouter(mod.createRouter());
      } catch {
        loadedRouter = null;
      }
    } else loadedRouter = null;
  }
  if (loadedTokenizerFor === undefined) {
    const mod = await importOptional<{ tokenizerFor?: (model?: string) => Tokenizer }>(() => import('./tokenizers.js'));
    loadedTokenizerFor = mod && typeof mod.tokenizerFor === 'function' ? mod.tokenizerFor : null;
  }
  if (loadedModelInfo === undefined) {
    const mod = await importOptional<{ modelInfo?: (model: string, env?: NodeJS.ProcessEnv) => { billsThinking?: boolean } }>(() => import('./models.js'));
    loadedModelInfo = mod && typeof mod.modelInfo === 'function' ? mod.modelInfo : null;
  }
  return { router: loadedRouter ?? null };
}

function tokenizerFor(model: string, deps: PipelineDeps, opts: ResolvedOptions): Tokenizer {
  if (opts.tokenizer) return opts.tokenizer;
  if (deps.tokenizer) return deps.tokenizer;
  if (loadedTokenizerFor) {
    try {
      return loadedTokenizerFor(model || undefined);
    } catch {
      return DEFAULT_TOKENIZER;
    }
  }
  return DEFAULT_TOKENIZER;
}

/** Whether `model` re-bills prior-turn thinking (registry when loaded, else heuristic). */
export function billsThinking(model: string, env?: NodeJS.ProcessEnv): boolean {
  if (loadedModelInfo) {
    try {
      const info = loadedModelInfo(model, env);
      if (typeof info?.billsThinking === 'boolean') return info.billsThinking;
    } catch {
      /* fall through */
    }
  }
  return billsPriorThinkingHeuristic(model);
}

// ---------------------------------------------------------------------------
// Small heuristics
// ---------------------------------------------------------------------------

const ERROR_INDICATORS = ['error', 'fail', 'exception', 'traceback', 'fatal', 'panic', 'crash'];
const ZERO_RESULT_RE = /\b(?:0|no)\s+(?:errors?|fail(?:ed|ing|ures?)?)\b|\b(?:errors?|fail(?:ed|ing|ures?)?)\s*[:=]\s*0\b/gi;

/** ≥ 2 distinct error indicators after scrubbing "0 errors"-style summaries. */
export function hasStrongErrorIndicators(text: string): boolean {
  const lowered = text.toLowerCase().replace(ZERO_RESULT_RE, ' ');
  let hits = 0;
  for (const k of ERROR_INDICATORS) {
    if (lowered.includes(k)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

const ANALYSIS_KEYWORDS = ['analyze', 'analyse', 'review', 'audit', 'inspect', 'security', 'vulnerability', 'bug', 'issue', 'problem', 'explain', 'understand', 'how does', 'what does', 'debug', 'fix', 'error', 'wrong', 'broken', 'refactor', 'improve', 'optimize', 'clean up'];

/** Does the latest user message ask for analysis/review of code? */
export function hasAnalysisIntent(userQuery: string): boolean {
  const q = userQuery.toLowerCase();
  if (!q) return false;
  return ANALYSIS_KEYWORDS.some((k) => q.includes(k));
}

const CODE_LINE_RE = /^\s*(?:import\s|from\s+\S+\s+import\s|export\s|(?:async\s+)?function\s|def\s|class\s|struct\s|impl\s|fn\s|pub\s|const\s|let\s|var\s|return\b|if\s*\(|for\s*\(|while\s*\(|#include\s|package\s|using\s|namespace\s|@\w+|\}\s*(?:else|catch|finally)?\s*\{?|[\w$.]+\([^)]*\)\s*(?:\{|=>|;)|[\w$]+\s*[:=]\s*[\w"'[{(]).*$/;

/** Cheap code detector used when no router `route()` is available. */
export function looksLikeCodeText(text: string): boolean {
  if (text.includes('```')) return true;
  const lines = text.split('\n').slice(0, 100).filter((l) => l.trim());
  if (lines.length < 3) return false;
  let hits = 0;
  for (const l of lines) if (l.length < 400 && CODE_LINE_RE.test(l)) hits += 1;
  return hits >= 3 && hits / lines.length >= 0.3;
}

const READ_VERBS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'ionice', 'nohup', 'stdbuf', 'command', 'timeout', 'xargs']);
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'flake.lock', 'Package.resolved', 'gradle.lockfile', 'packages.lock.json'];

/** True when a shell command just prints a file (`cat`, `head`, `sed -n`, …), so its output is a file read. */
export function isReadCommand(command: string): boolean {
  let cmd = command.trim();
  if (!cmd) return false;
  if (/(^|[^>])>(?!>)|>>|\btee\b|<<+/.test(cmd)) return false;
  // Strip leading `cd X &&` chains.
  for (;;) {
    const m = /^cd\s+[^&;|]+&&\s*/.exec(cmd);
    if (!m) break;
    cmd = cmd.slice(m[0].length);
  }
  let tokens = cmd.split(/\s+/);
  for (;;) {
    const first = tokens[0] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first)) {
      tokens = tokens.slice(1);
      if (first === 'timeout' && /^\d/.test(tokens[0] ?? '')) tokens = tokens.slice(1);
      continue;
    }
    if ((first === 'sh' || first === 'bash' || first === 'zsh' || first === 'dash') && tokens[1] === '-c') {
      const inner = tokens.slice(2).join(' ').replace(/^['"]|['"]$/g, '');
      return isReadCommand(inner);
    }
    break;
  }
  const verb = tokens[0] ?? '';
  const isRead = READ_VERBS.has(verb) || (verb === 'sed' && tokens[1] === '-n');
  if (!isRead) return false;
  const target = tokens.slice(1).find((t) => !t.startsWith('-')) ?? '';
  const base = target.split('/').pop() ?? '';
  return !LOCKFILES.includes(base);
}

const encoder = new TextEncoder();
function sha(text: string): string {
  return bytesToHex(sha256(encoder.encode(text))).slice(0, 32);
}

/** Total tokens of a conversation (text, tool results, tool inputs, reasoning). */
export function messagesTokens(messages: Message[], tokenizer: Tokenizer, format?: MessageFormat): number {
  let n = 0;
  for (const b of enumerateBlocks(messages, format)) if (b.text) n += tokenizer.count(b.text);
  return n;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionStats {
  id: string;
  turn: number;
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  frozenVerdicts: number;
  maturedReads: number;
  trackedHashes: number;
}

type FrozenVerdict = { kind: 'skip' } | { kind: 'replace'; text: string; strategy: Strategy; chain: string[]; ccrHashes: string[] };

/** Per-conversation memory: frozen verdicts, read maturation, tracker. */
export class CompressionSession {
  readonly id: string;
  private turnCount = 0;
  private requests = 0;
  private before = 0;
  private after = 0;
  private readonly now: () => number;
  private readonly maxFrozen: number;
  readonly verdicts = new Map<string, FrozenVerdict>();
  maturation: ReadMaturation | null = null;
  readonly tracker: ContextTracker;

  constructor(opts: { id?: string; now?: () => number; maxFrozenVerdicts?: number; workspace?: string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.id = opts.id ?? `session-${sha(String(this.now())).slice(0, 12)}`;
    this.maxFrozen = Math.max(1, opts.maxFrozenVerdicts ?? 4096);
    this.tracker = new ContextTracker({ now: this.now, workspace: opts.workspace ?? this.id });
  }

  get turn(): number {
    return this.turnCount;
  }

  async compress(messages: Message[], options: CompressOptions = {}, deps: PipelineDeps = {}): Promise<CompressResult> {
    return compressMessages(messages, options, { now: this.now, ...deps, session: this } as PipelineDeps);
  }

  compressSync(messages: Message[], options: CompressOptions = {}, deps: PipelineDeps = {}): CompressResult {
    return compressMessagesSync(messages, options, { now: this.now, ...deps, session: this } as PipelineDeps);
  }

  /** @internal */
  noteRequest(result: CompressResult): void {
    this.turnCount += 1;
    this.requests += 1;
    this.before += result.tokensBefore;
    this.after += result.tokensAfter;
  }

  /** @internal */
  remember(key: string, verdict: FrozenVerdict): void {
    if (this.verdicts.has(key)) return;
    this.verdicts.set(key, verdict);
    while (this.verdicts.size > this.maxFrozen) {
      const first = this.verdicts.keys().next().value;
      if (first === undefined) break;
      this.verdicts.delete(first);
    }
  }

  stats(): SessionStats {
    return { id: this.id, turn: this.turnCount, requests: this.requests, tokensBefore: this.before, tokensAfter: this.after, tokensSaved: Math.max(0, this.before - this.after), frozenVerdicts: this.verdicts.size, maturedReads: this.maturation?.maturedCount ?? 0, trackedHashes: this.tracker.size };
  }

  reset(): void {
    this.turnCount = 0;
    this.requests = 0;
    this.before = 0;
    this.after = 0;
    this.verdicts.clear();
    this.maturation?.reset();
    this.tracker.clear();
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function passthrough(messages: Message[], format: MessageFormat, tokens: number, transforms: string[], warnings: string[], manifest?: CompressionManifest): CompressResult {
  return {
    messages,
    tokensBefore: tokens,
    tokensAfter: tokens,
    tokensSaved: 0,
    compressionRatio: 0,
    keptRatio: 1,
    transformsApplied: transforms,
    transformsSummary: summarize(transforms),
    ccrHashes: [],
    compressed: false,
    manifest: manifest ?? { messagesTotal: messages.length, messagesBelowFrozenFloor: 0, latestUserMessageIndex: latestUserMessageIndex(messages), blockOutcomes: [] },
    markersInserted: [],
    warnings,
    format,
  };
}

function summarize(transforms: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of transforms) {
    const key = t.split(':').slice(0, 2).join(':');
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface PassContext {
  opts: ResolvedOptions;
  deps: PipelineDeps & { session?: CompressionSession };
  format: MessageFormat;
  tokenizer: Tokenizer;
  router: Compressor | null;
  store: CompressionStore | null;
  now: () => number;
  startedAt: number;
  warnings: string[];
  transforms: string[];
  ccrHashes: Set<string>;
  markersInserted: string[];
  outcomes: BlockOutcome[];
  hookBiases: Record<number, number>;
  userQuery: string;
  routeMemo: Map<string, ContentType | null>;
  /** Set by the pre-passes when they rewrote anything. */
  changed: boolean;
}

/** Drop 12-char short hashes that merely prefix a 24-char hash in the same list (the marker form of the same key). */
export function mergeHashes(hashes: Iterable<string>): string[] {
  const all = [...new Set([...hashes].map((h) => h.toLowerCase()))];
  const long = all.filter((h) => h.length === 24);
  return all.filter((h) => h.length === 24 || !long.some((l) => l.startsWith(h)));
}

function resolveStore(opts: ResolvedOptions, deps: PipelineDeps): CompressionStore | null {
  if (!opts.ccr.enabled) return null;
  if (deps.store !== undefined) return deps.store;
  if (opts.ccr.store !== undefined) return opts.ccr.store;
  try {
    return defaultStore(deps.env ?? process.env);
  } catch {
    return null;
  }
}

/** Content type via the router's `route()` when it offers one (memoised per pass), else null. */
function routeType(ctx: PassContext, text: string, hint: { toolName?: string }): ContentType | null {
  const r = ctx.router as unknown as { route?: RouteFn } | null;
  if (!r || typeof r.route !== 'function') return null;
  const key = `${hint.toolName ?? ''} ${text}`;
  const cached = ctx.routeMemo.get(key);
  if (cached !== undefined) return cached;
  let type: ContentType | null;
  try {
    type = r.route.call(ctx.router, text, hint).type;
  } catch {
    type = null;
  }
  ctx.routeMemo.set(key, type);
  return type;
}

function excluded(reason: ExclusionReason): BlockAction {
  return { kind: 'excluded', reason };
}

function runPass(work: Message[], ctx: PassContext): { manifest: CompressionManifest; changed: boolean; reverted?: string } {
  const { opts, format, tokenizer } = ctx;
  const frozen = Math.min(opts.frozenMessageCount, work.length);
  const latestUser = latestUserMessageIndex(work);
  const lastAssistant = lastAssistantIndex(work);
  const liveFloor = opts.mode === 'cache' ? Math.max(frozen, lastAssistant + 1) : frozen;
  const ceiling = latestUser ?? work.length - 1;
  const analysis = opts.protectAnalysisContext && hasAnalysisIntent(ctx.userQuery);
  const argsIndex = toolArgsIndex(work);
  const blocks = enumerateBlocks(work, format);
  // Per-message token totals for the message-level floor.
  const msgTokens = new Map<number, number>();
  for (const b of blocks) if (b.text) msgTokens.set(b.messageIndex, (msgTokens.get(b.messageIndex) ?? 0) + tokenizer.count(b.text));

  let changed = false;
  const session = ctx.deps.session;
  const bashCommandOf = (toolCallId?: string): string | undefined => {
    if (!toolCallId) return undefined;
    const a = argsIndex.get(toolCallId);
    if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).command === 'string') return (a as Record<string, unknown>).command as string;
    return undefined;
  };

  for (const b of blocks) {
    const record = (action: BlockAction): void => {
      const o: BlockOutcome = { messageIndex: b.messageIndex, blockType: b.blockType, action };
      if (b.blockIndex !== undefined) o.blockIndex = b.blockIndex;
      ctx.outcomes.push(o);
    };
    if (b.messageIndex < frozen) {
      record(excluded('below_frozen_floor'));
      continue;
    }
    if (b.messageIndex < liveFloor || b.messageIndex > ceiling) {
      record(excluded('above_live_zone'));
      continue;
    }
    if (b.kind === 'other') {
      record(excluded(b.blockType === 'tool_result' ? 'non_string' : 'hot_zone_block_type'));
      continue;
    }
    if (b.cacheControl) {
      record(excluded('cache_control'));
      continue;
    }
    if (b.toolName === RETRIEVE_TOOL_NAME) {
      record(excluded('retrieve_result'));
      continue;
    }
    if (isAlreadyCompressed(b.text)) {
      record(excluded('already_compressed'));
      continue;
    }
    if (b.kind === 'text') {
      if ((b.role === 'user' && !opts.compressUserMessages) || ((b.role === 'system' || b.role === 'developer') && !opts.compressSystemMessages) || (b.role === 'assistant' && !opts.compressAssistantText) || !['user', 'system', 'developer', 'assistant'].includes(b.role)) {
        record(excluded('protected_role'));
        continue;
      }
    }
    const profile: ToolProfile | undefined = b.toolName ? opts.toolProfiles[b.toolName] : undefined;
    if (profile?.skipCompression) {
      record(excluded('protected_tool'));
      continue;
    }
    const text = b.text;
    const bytes = Buffer.byteLength(text, 'utf8');
    const losslessOnly = opts.lossless || profile?.losslessOnly === true;
    // Read protection: Read-family tools and `cat`-style shell commands stay byte-exact
    // unless the content is a structured type the model does not need verbatim
    // (JSON, search hits, build output, diffs, HTML, tables) — those are released to
    // the normal path, where the tool profile still decides lossless vs. lossy.
    if (b.kind === 'tool_result' && opts.protectReads) {
      const isReadTool = !!b.toolName && READ_SET.has(b.toolName);
      const cmd = b.toolName && BASH_TOOLS.has(b.toolName.toLowerCase()) ? bashCommandOf(b.toolCallId) : undefined;
      const isReadCmd = cmd !== undefined && isReadCommand(cmd);
      if (isReadTool || isReadCmd) {
        if (text.length < opts.readMinChars) {
          record(excluded('protected_read'));
          continue;
        }
        const type = routeType(ctx, text, { toolName: b.toolName });
        if (type === null || !RELEASABLE_READ_TYPES.has(type)) {
          record(excluded('protected_read'));
          continue;
        }
      }
    }
    if (!text.trim()) {
      record({ kind: 'below_threshold', bytes, threshold: opts.minCharsForBlock });
      continue;
    }
    if (text.length < opts.minCharsForBlock) {
      record({ kind: 'below_threshold', bytes, threshold: opts.minCharsForBlock });
      continue;
    }
    const mTokens = msgTokens.get(b.messageIndex) ?? 0;
    if (mTokens < opts.minTokensToCompress) {
      // Message-level token floor: both numbers are token counts here.
      record({ kind: 'below_threshold', bytes: mTokens, threshold: opts.minTokensToCompress });
      continue;
    }
    if (b.kind === 'tool_result' && (b.isError || (text.length <= opts.errorProtectionMaxChars && hasStrongErrorIndicators(text)))) {
      record(excluded('protected_error_output'));
      continue;
    }
    const fromEnd = work.length - b.messageIndex;
    if (opts.protectRecent > 0 && fromEnd <= opts.protectRecent) {
      const type = routeType(ctx, text, { toolName: b.toolName });
      const isCode = type === null ? looksLikeCodeText(text) : type === 'source_code';
      if (isCode) {
        record(excluded('protected_recent_code'));
        continue;
      }
    }
    if (analysis) {
      const type = routeType(ctx, text, { toolName: b.toolName });
      const isCode = type === null ? looksLikeCodeText(text) : type === 'source_code';
      if (isCode) {
        record(excluded('protected_analysis_context'));
        continue;
      }
    }
    if (!ctx.router) {
      record({ kind: 'no_compression', contentType: routeType(ctx, text, { toolName: b.toolName }) ?? 'plain_text' });
      continue;
    }
    if (opts.deadlineMs > 0 && ctx.now() - ctx.startedAt > opts.deadlineMs) {
      return { manifest: manifestOf(work, frozen, latestUser, ctx.outcomes), changed, reverted: 'deadline' };
    }
    // `wantMarker`: the caller asked for recoverable (marked) lossy rewrites; `injectMarker`:
    // we can actually honour it (a store is available). Wanting a marker without a
    // store means lossy tool output is rejected rather than silently made unrecoverable.
    const wantMarker = opts.ccr.enabled && opts.ccr.injectMarker && !losslessOnly;
    const injectMarker = wantMarker && ctx.store !== null;
    const bias = (opts.biases[b.messageIndex] ?? 1) * (ctx.hookBiases[b.messageIndex] ?? 1) * (profile?.bias ?? 1) * opts.profileBias;
    const verdictKey = `${sha(text)}:${opts.targetRatio ?? 'a'}:${losslessOnly ? 1 : 0}:${injectMarker ? 1 : 0}:${(opts.compressors ?? []).join(',')}`;
    const frozenVerdict = opts.freezeBlockDecision && session ? session.verdicts.get(verdictKey) : undefined;
    if (frozenVerdict) {
      if (frozenVerdict.kind === 'skip') {
        record({ kind: 'no_compression', contentType: routeType(ctx, text, { toolName: b.toolName }) ?? 'plain_text' });
        continue;
      }
      const stillOk = frozenVerdict.ccrHashes.every((h) => ctx.store?.exists(h));
      if (stillOk) {
        b.set(frozenVerdict.text);
        changed = true;
        const ot = tokenizer.count(text);
        const ct = tokenizer.count(frozenVerdict.text);
        record({ kind: 'compressed', strategy: frozenVerdict.strategy, chain: [...frozenVerdict.chain], originalBytes: bytes, compressedBytes: Buffer.byteLength(frozenVerdict.text, 'utf8'), originalTokens: ot, compressedTokens: ct, ccrHashes: [...frozenVerdict.ccrHashes] });
        ctx.transforms.push(routerLabel(frozenVerdict.strategy, ot > 0 ? ct / ot : 1));
        for (const h of frozenVerdict.ccrHashes) ctx.ccrHashes.add(h);
        continue;
      }
    }
    const req: CompressRequest = { content: text, query: ctx.userQuery, bias, tokenizer, injectMarker, losslessOnly, ccr: injectMarker ? ctx.store : null };
    if (b.toolName) req.toolName = b.toolName;
    if (opts.targetRatio !== undefined) req.targetRatio = opts.targetRatio;
    if (profile) req.profile = profile;
    let strategy: Strategy = 'passthrough';
    try {
      const res = ctx.router.compress(req);
      strategy = res.strategy;
      const out = res.content;
      if (typeof out !== 'string') throw new Error('router returned a non-string');
      if (!out.trim()) {
        record({ kind: 'compressor_error', strategy, error: 'empty output for non-empty input' });
        continue;
      }
      const originalTokens = tokenizer.count(text);
      const compressedTokens = tokenizer.count(out);
      if (out === text || strategy === 'passthrough' || compressedTokens >= originalTokens) {
        if (out !== text && compressedTokens >= originalTokens) record({ kind: 'rejected_not_smaller', strategy, originalTokens, compressedTokens });
        else record({ kind: 'no_compression', contentType: routeType(ctx, text, { toolName: b.toolName }) ?? 'plain_text' });
        if (opts.freezeBlockDecision && session) session.remember(verdictKey, { kind: 'skip' });
        continue;
      }
      const lossy = !isLosslessResult(res.chain, strategy);
      const hashes = mergeHashes([...res.ccrHashes, ...extractHashes(out)]);
      const marked = hashes.length > 0 || hasMarkers(out);
      if (b.kind === 'tool_result' && lossy && wantMarker && !marked) {
        record({ kind: 'rejected_unrecoverable', strategy });
        continue;
      }
      b.set(out);
      changed = true;
      record({ kind: 'compressed', strategy, chain: [...res.chain], originalBytes: bytes, compressedBytes: Buffer.byteLength(out, 'utf8'), originalTokens, compressedTokens, ccrHashes: hashes });
      ctx.transforms.push(routerLabel(strategy, compressedTokens / originalTokens));
      for (const h of hashes) ctx.ccrHashes.add(h);
      if (opts.freezeBlockDecision && session && (!lossy || marked)) session.remember(verdictKey, { kind: 'replace', text: out, strategy, chain: [...res.chain], ccrHashes: hashes });
      if (session && hashes.length) {
        for (const h of hashes) session.tracker.noteCompressed(h, { toolName: b.toolName, keywords: extractKeywords(text.slice(0, 4000)).slice(0, 64), messageIndex: b.messageIndex, sample: text.slice(0, 2000), queryContext: ctx.userQuery, originalItemCount: res.itemCounts?.original, compressedItemCount: res.itemCounts?.kept });
      }
    } catch (err) {
      record({ kind: 'compressor_error', strategy, error: (err as Error).message });
    }
  }

  // Cross-turn dedup: later verbatim repeats of tool output → in-context pointers.
  if (opts.crossTurnDedup) {
    const after = enumerateBlocks(work, format);
    const outcomeAt = new Map<string, BlockOutcome>();
    for (const o of ctx.outcomes) outcomeAt.set(`${o.messageIndex}:${o.blockIndex ?? -1}`, o);
    const candidates: Array<{ block: EnumeratedBlock; d: DedupBlock }> = [];
    for (const b of after) {
      if (b.kind !== 'tool_result' || !b.text) continue;
      const o = outcomeAt.get(`${b.messageIndex}:${b.blockIndex ?? -1}`);
      const a = o?.action;
      const rewritable = !!a && (a.kind === 'no_compression' || a.kind === 'rejected_not_smaller' || a.kind === 'rejected_unrecoverable' || a.kind === 'compressor_error' || (a.kind === 'below_threshold' && b.text.length >= 40) || (a.kind === 'excluded' && (a.reason === 'protected_read' || a.reason === 'protected_tool')));
      candidates.push({ block: b, d: { text: b.text, messageIndex: b.messageIndex, protected: !rewritable, tokens: tokenizer.count(b.text), hash: hashOriginal(b.text) } });
    }
    const recoverable = opts.crossTurnDedupRecoverable && ctx.store !== null && opts.ccr.enabled;
    const { texts, folds } = dedupBlocks(
      candidates.map((c) => c.d),
      { recoverable },
    );
    for (const f of folds) {
      const c = candidates[f.index];
      if (f.kind === 'near_verbatim') {
        try {
          ctx.store!.store(c.d.text, { compressed: f.pointer, strategy: 'cross_turn_dedup', toolName: c.block.toolName, toolCallId: c.block.toolCallId, explicitHash: c.d.hash, originalTokens: c.d.tokens, compressedTokens: tokenizer.count(f.pointer) });
          ctx.ccrHashes.add(c.d.hash!);
        } catch {
          continue; // could not persist → keep the bytes
        }
      }
      c.block.set(texts[f.index]);
      changed = true;
      ctx.transforms.push(`dedup:${f.kind}:${f.refMessageIndex}`);
      const o = outcomeAt.get(`${c.block.messageIndex}:${c.block.blockIndex ?? -1}`);
      if (o) o.action = { kind: 'compressed', strategy: 'lossless', chain: [`dedup_${f.kind}`], originalBytes: Buffer.byteLength(c.d.text, 'utf8'), compressedBytes: Buffer.byteLength(f.pointer, 'utf8'), originalTokens: c.d.tokens, compressedTokens: tokenizer.count(f.pointer), ccrHashes: f.kind === 'near_verbatim' ? [c.d.hash!] : [] };
    }
  }
  return { manifest: manifestOf(work, frozen, latestUser, ctx.outcomes), changed };
}

function manifestOf(work: Message[], frozen: number, latestUser: number | null, outcomes: BlockOutcome[]): CompressionManifest {
  return { messagesTotal: work.length, messagesBelowFrozenFloor: frozen, latestUserMessageIndex: latestUser, blockOutcomes: outcomes };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface Prepared {
  opts: ResolvedOptions;
  format: MessageFormat;
  tokenizer: Tokenizer;
  now: () => number;
  startedAt: number;
  tokensBefore: number;
}

function prepare(messages: Message[], options: CompressOptions, deps: PipelineDeps): Prepared {
  const opts = resolveOptions(options, deps.env ?? process.env);
  const format = detectFormat(messages);
  const tokenizer = tokenizerFor(opts.model, deps, opts);
  const now = deps.now ?? options.now ?? (() => Date.now());
  return { opts, format, tokenizer, now, startedAt: now(), tokensBefore: messagesTokens(messages, tokenizer, format) };
}

function finish(prep: Prepared, original: Message[], work: Message[], ctx: PassContext, pass: { manifest: CompressionManifest; changed: boolean; reverted?: string }, hookWarnings: string[]): CompressResult {
  const { format, tokenizer, tokensBefore } = prep;
  const warnings = [...hookWarnings, ...ctx.warnings];
  if (pass.reverted) {
    warnings.push(`${pass.reverted}: original forwarded`);
    return passthrough(original, format, tokensBefore, [`${pass.reverted}:reverted`], warnings, pass.manifest);
  }
  if (!pass.changed && !ctx.changed) {
    const transforms = ctx.transforms.length ? ctx.transforms : ['router:noop'];
    const r = passthrough(original, format, tokensBefore, transforms, warnings, pass.manifest);
    r.markersInserted = ctx.markersInserted;
    return r;
  }
  const tokensAfter = messagesTokens(work, tokenizer, format);
  if (tokensAfter > tokensBefore) {
    warnings.push('inflation_guard: compressed output was larger; original forwarded');
    return passthrough(original, format, tokensBefore, ['inflation_guard:reverted'], warnings, pass.manifest);
  }
  const saved = tokensBefore - tokensAfter;
  const transforms = ctx.transforms.length ? ctx.transforms : ['router:noop'];
  return {
    messages: work,
    tokensBefore,
    tokensAfter,
    tokensSaved: saved,
    compressionRatio: tokensBefore > 0 ? saved / tokensBefore : 0,
    keptRatio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1,
    transformsApplied: transforms,
    transformsSummary: summarize(transforms),
    ccrHashes: mergeHashes(ctx.ccrHashes),
    compressed: saved > 0,
    manifest: pass.manifest,
    markersInserted: ctx.markersInserted,
    warnings,
    format,
  };
}

function prePasses(work: Message[], ctx: PassContext): void {
  const { opts } = ctx;
  const session = ctx.deps.session;
  // Thinking compaction on models that bill prior reasoning.
  const bills = ctx.deps.billsThinking ?? ((m: string): boolean => billsThinking(m, ctx.deps.env));
  if (opts.thinkingCompact && ctx.router && bills(opts.model)) {
    const router = ctx.router;
    const tokenizer = ctx.tokenizer;
    const stats = compactThinking(work, {
      keepLast: opts.thinkingCompactKeepLast,
      compact: (text) => {
        const r = router.compress({ content: text, tokenizer, injectMarker: false, losslessOnly: false, ccr: null, targetRatio: opts.targetRatio ?? 0.3 });
        return r.content && r.content !== text ? r.content : null;
      },
    });
    if (stats.blocks) {
      ctx.transforms.push(`thinking:compacted:${stats.blocks}`);
      ctx.changed = true;
    }
  }
  // Read lifecycle (stale / superseded).
  if (opts.readLifecycle.enabled) {
    const r = applyReadLifecycle(work, { frozenMessageCount: opts.frozenMessageCount, compressStale: opts.readLifecycle.compressStale, compressSuperseded: opts.readLifecycle.compressSuperseded, minSizeBytes: opts.readLifecycle.minSizeBytes, store: ctx.store, countTokens: (t) => ctx.tokenizer.count(t) });
    ctx.transforms.push(...r.transforms);
    for (const h of r.ccrHashes) ctx.ccrHashes.add(h);
    if (r.replaced > 0) ctx.changed = true;
  }
  // Read maturation (session-scoped hold-back).
  if (opts.readMaturation.enabled && session) {
    if (!session.maturation) session.maturation = new ReadMaturation(opts.readMaturation);
    const r = session.maturation.apply(work, { frozenMessageCount: opts.frozenMessageCount, store: ctx.store, countTokens: (t) => ctx.tokenizer.count(t) });
    ctx.transforms.push(...r.transforms);
    for (const h of r.ccrHashes) ctx.ccrHashes.add(h);
    if (r.replaced > 0) ctx.changed = true;
    if (r.holdingMessageIndices.length) ctx.markersInserted.push(...r.holdingMessageIndices.map((i) => `read_hold:${i}`));
  }
  // Cache aligner: detector only.
  const report = analyzeCachePrefix(work, { frozenMessageCount: opts.frozenMessageCount });
  ctx.warnings.push(...report.warnings);
  ctx.markersInserted.push(...report.markersInserted);
}

function makeContext(prep: Prepared, deps: PipelineDeps & { session?: CompressionSession }, router: Compressor | null, userQuery: string, hookBiases: Record<number, number>): PassContext {
  const store = resolveStore(prep.opts, deps);
  return { opts: prep.opts, deps, format: prep.format, tokenizer: prep.tokenizer, router, store, now: prep.now, startedAt: prep.startedAt, warnings: [], transforms: [], ccrHashes: new Set(), markersInserted: [], outcomes: [], hookBiases, userQuery, routeMemo: new Map(), changed: false };
}

function eventOf(result: CompressResult, opts: ResolvedOptions, userQuery: string): CompressEvent {
  return { tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, tokensSaved: result.tokensSaved, compressionRatio: result.compressionRatio, transformsApplied: result.transformsApplied, ccrHashes: result.ccrHashes, model: opts.model, userQuery, provider: opts.provider || result.format };
}

/** Compress a conversation (async: loads the default router, awaits hooks). Never throws. */
export async function compressMessages(messages: Message[], options: CompressOptions = {}, deps: PipelineDeps = {}): Promise<CompressResult> {
  const d = deps as PipelineDeps & { session?: CompressionSession };
  let prep: Prepared;
  try {
    prep = prepare(messages, options, deps);
  } catch (err) {
    return passthrough(messages, detectFormat(messages), 0, ['pipeline:error'], [`pipeline: ${(err as Error).message}`]);
  }
  const { opts, format, tokensBefore } = prep;
  if (!opts.optimize || messages.length === 0) return passthrough(messages, format, tokensBefore, ['passthrough:optimize_off'], []);
  try {
    const router = deps.router ?? (await loadDefaultDeps()).router;
    const ctxHooks = buildContext(messages, { model: opts.model, provider: opts.provider || format });
    const pre = await runPreCompress(opts.hooks, messages, ctxHooks);
    const biases = await runComputeBiases(opts.hooks, pre.value, ctxHooks);
    const hookWarnings = [...pre.warnings, ...biases.warnings];
    const work = structuredClone(pre.value);
    const ctx = makeContext(prep, d, router, opts.query ?? extractUserQuery(pre.value), biases.value);
    prePasses(work, ctx);
    const pass = runPass(work, ctx);
    const result = finish(prep, messages, work, ctx, pass, hookWarnings);
    d.session?.noteRequest(result);
    if (result.tokensSaved > 0) result.warnings.push(...(await runPostCompress(opts.hooks, eventOf(result, opts, ctx.userQuery))));
    return result;
  } catch (err) {
    return passthrough(messages, format, tokensBefore, ['pipeline:error'], [`pipeline: ${(err as Error).message}`]);
  }
}

/** Synchronous variant: uses the injected/loaded router only; async hooks are skipped with a warning. */
export function compressMessagesSync(messages: Message[], options: CompressOptions = {}, deps: PipelineDeps = {}): CompressResult {
  const d = deps as PipelineDeps & { session?: CompressionSession };
  let prep: Prepared;
  try {
    prep = prepare(messages, options, deps);
  } catch (err) {
    return passthrough(messages, detectFormat(messages), 0, ['pipeline:error'], [`pipeline: ${(err as Error).message}`]);
  }
  const { opts, format, tokensBefore } = prep;
  if (!opts.optimize || messages.length === 0) return passthrough(messages, format, tokensBefore, ['passthrough:optimize_off'], []);
  try {
    const router = deps.router ?? loadedRouter ?? null;
    const ctxHooks = buildContext(messages, { model: opts.model, provider: opts.provider || format });
    const pre = runPreCompressSync(opts.hooks, messages, ctxHooks);
    const biases = runComputeBiasesSync(opts.hooks, pre.value, ctxHooks);
    const hookWarnings = [...pre.warnings, ...biases.warnings];
    const work = structuredClone(pre.value);
    const ctx = makeContext(prep, d, router, opts.query ?? extractUserQuery(pre.value), biases.value);
    prePasses(work, ctx);
    const pass = runPass(work, ctx);
    const result = finish(prep, messages, work, ctx, pass, hookWarnings);
    d.session?.noteRequest(result);
    if (result.tokensSaved > 0) result.warnings.push(...runPostCompressSync(opts.hooks, eventOf(result, opts, ctx.userQuery)));
    return result;
  } catch (err) {
    return passthrough(messages, format, tokensBefore, ['pipeline:error'], [`pipeline: ${(err as Error).message}`]);
  }
}
