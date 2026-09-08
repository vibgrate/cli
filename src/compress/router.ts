/**
 * ContentRouter — where every block of text gets compressed.
 *
 *   detect → pick a strategy → min-token gate → lossless-first (byte-exact
 *   folds) → lossy compressor → keep lossy only when it beats the fold by
 *   ≥ `lossyMinExtraSavings` → recoverability + accuracy guards → store the
 *   original (when markers are on) and append the retrieval hint →
 *   inflation / empty-output guards.
 *
 * Sync, deterministic (identical input → identical output), never throws:
 * every failure path is `strategy: 'passthrough'`. The deadline is checked
 * between stages with an injected clock and never aborts a running stage.
 */

import { accuracyGuard } from './anchors.js';
import { CodeCompressor, prepareCodeCompressor } from './code.js';
import { activeProfile, env as knobEnv, resolveToolProfiles } from './config.js';
import { ConfigCompressor } from './config-compress.js';
import { SmartCrusher } from './crusher.js';
import { detectContentType, looksLikeDiff, splitIntoSections, type DetectHint } from './detect.js';
import { DiffCompressor } from './diff.js';
import { HtmlCompressor } from './html.js';
import { LogCompressor } from './log.js';
import { bestLosslessFold, type LosslessKind } from './lossless.js';
import { SearchCompressor } from './search.js';
import { TabularCompressor } from './tabular.js';
import { TextCompressor } from './text.js';
import { CL100K } from './tokenizers.js';
import { isAlreadyCompressed, isLosslessResult, type CompressRequest, type CompressResponse, type Compressor, type ContentType, type DetectionResult, type ProfileName, type Strategy, type Tokenizer, type ToolProfile } from './types.js';

export interface RouterOptions {
  tokenizer?: Tokenizer;
  compressors?: Strategy[];
  profile?: ProfileName;
  toolProfiles?: Record<string, ToolProfile>;
  codeAware?: boolean;
  textCompression?: boolean;
  lossless?: boolean;
  losslessThenLossy?: boolean;
  lossyMinExtraSavings?: number;
  minTokens?: number;
  maxItems?: number;
  targetRatio?: number;
  accuracyGuard?: boolean;
  smartCrusherCompaction?: boolean;
  deadlineMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected monotonic clock (ms) for the deadline; defaults to `performance.now`. */
  now?: () => number;
}

export interface RouteDecision {
  type: ContentType;
  strategy: Strategy;
  reason: string;
}

/** Strategies whose lossy output carries no structure of its own to recover from. */
const LOSSY_UNMARKED: ReadonlySet<Strategy> = new Set<Strategy>(['text', 'code_aware']);
/** Compressors whose result replaces the whole block (hint says "Retrieve original"). */
const WHOLE_BLOCK: ReadonlySet<Strategy> = new Set<Strategy>(['html', 'config']);
/** No-savings fallback to the text compressor is tried for these. */
const TEXT_FALLBACK: ReadonlySet<Strategy> = new Set<Strategy>(['smart_crusher', 'code_aware', 'tabular', 'config']);

const DEFAULT_MIN_TOKENS = 50;

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** `Retrieve original: hash=… (a → b tokens[, tool=x])` / `Retrieve more: …` — one line, appended last. */
export function retrievalHint(kind: 'original' | 'more', hash: string, originalTokens: number, compressedTokens: number, toolName?: string): string {
  const tool = toolName ? `, tool=${toolName}` : '';
  return `Retrieve ${kind}: hash=${hash} (${originalTokens} → ${compressedTokens} tokens${tool})`;
}

export function strategyForType(type: ContentType, meta: Record<string, unknown> = {}): Strategy {
  switch (type) {
    case 'json':
      return 'smart_crusher';
    case 'source_code':
      return 'code_aware';
    case 'search_results':
      return 'search';
    case 'build_output':
      return 'log';
    case 'git_diff':
      return 'diff';
    case 'html':
      return 'html';
    case 'tabular':
      return 'tabular';
    case 'structured_config':
      return 'config';
    default:
      if (meta.paths === true) return 'lossless';
      if (meta.mixed === true) return 'mixed';
      return 'text';
  }
}

function losslessKindFor(strategy: Strategy, meta: Record<string, unknown>): LosslessKind | undefined {
  if (strategy === 'search') return 'search';
  if (strategy === 'log') return 'log';
  if (strategy === 'diff') return 'diff';
  if (strategy === 'config') return 'config';
  if (meta.paths === true) return 'paths';
  if (strategy === 'text') return 'text';
  return undefined;
}

export class ContentRouter implements Compressor {
  readonly strategy = 'mixed' as const;
  readonly tokenizer: Tokenizer;
  readonly options: Required<Pick<RouterOptions, 'codeAware' | 'textCompression' | 'lossless' | 'losslessThenLossy' | 'lossyMinExtraSavings' | 'minTokens' | 'maxItems' | 'accuracyGuard' | 'smartCrusherCompaction' | 'deadlineMs'>> & { targetRatio?: number; compressors: Strategy[]; preferCodeAware: boolean; guardLossy: boolean };
  readonly toolProfiles: Record<string, ToolProfile>;
  private readonly now: () => number;
  private readonly compressors: Map<Strategy, Compressor>;

  constructor(opts: RouterOptions = {}) {
    const env = opts.env ?? process.env;
    this.tokenizer = opts.tokenizer ?? CL100K;
    this.now = opts.now ?? defaultNow;
    const profile = activeProfile(opts.profile, env);
    this.toolProfiles = opts.toolProfiles ?? resolveToolProfiles(profile, env);
    const compressors = opts.compressors ?? (knobEnv.list('VG_COMPRESS_COMPRESSORS', env) as Strategy[]);
    this.options = {
      codeAware: opts.codeAware ?? knobEnv.bool('VG_COMPRESS_CODE_AWARE', env),
      textCompression: opts.textCompression ?? knobEnv.bool('VG_COMPRESS_TEXT', env),
      lossless: opts.lossless ?? knobEnv.bool('VG_COMPRESS_LOSSLESS', env),
      losslessThenLossy: opts.losslessThenLossy ?? knobEnv.bool('VG_COMPRESS_LOSSLESS_THEN_LOSSY', env),
      lossyMinExtraSavings: opts.lossyMinExtraSavings ?? knobEnv.float('VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS', env, { min: 0, max: 1 }),
      minTokens: opts.minTokens ?? DEFAULT_MIN_TOKENS,
      maxItems: opts.maxItems ?? knobEnv.int('VG_COMPRESS_MAX_ITEMS', env, { min: 1 }),
      accuracyGuard: opts.accuracyGuard ?? knobEnv.bool('VG_COMPRESS_ACCURACY_GUARD', env),
      smartCrusherCompaction: opts.smartCrusherCompaction ?? knobEnv.bool('VG_COMPRESS_SMART_CRUSHER_COMPACTION', env),
      deadlineMs: opts.deadlineMs ?? knobEnv.int('VG_COMPRESS_DEADLINE_MS', env, { min: 0 }),
      targetRatio: opts.targetRatio ?? knobEnv.optFloat('VG_COMPRESS_TARGET_RATIO', env),
      compressors,
      preferCodeAware: knobEnv.bool('VG_COMPRESS_PREFER_CODE_AWARE', env),
      guardLossy: knobEnv.bool('VG_COMPRESS_LOSSLESS_GUARD_LOSSY', env),
    };
    this.compressors = new Map<Strategy, Compressor>([
      ['smart_crusher', new SmartCrusher({ withCompaction: this.options.smartCrusherCompaction, maxItemsAfterCrush: this.options.maxItems })],
      ['tabular', new TabularCompressor({ withCompaction: this.options.smartCrusherCompaction, maxItemsAfterCrush: this.options.maxItems })],
      ['config', new ConfigCompressor()],
      ['search', new SearchCompressor()],
      ['log', new LogCompressor()],
      ['diff', new DiffCompressor()],
      ['html', new HtmlCompressor()],
      ['text', new TextCompressor()],
      ['code_aware', new CodeCompressor()],
    ]);
  }

  /** Which compressor would run, for dry-runs and the dashboard. */
  route(text: string, hint: DetectHint = {}): RouteDecision {
    const det = detectContentType(text, hint);
    const chosen = this.pickStrategy(det);
    return { type: det.type, strategy: chosen.strategy, reason: chosen.reason };
  }

  private pickStrategy(det: DetectionResult): { strategy: Strategy; reason: string } {
    const natural = strategyForType(det.type, det.metadata);
    const conf = det.confidence.toFixed(2);
    if (natural === 'lossless') return { strategy: 'lossless', reason: `${det.type} path listing (${conf}) → lossless folds only` };
    if (natural === 'mixed') return { strategy: 'mixed', reason: `plain_text with mixed sections → per-section routing` };
    if (natural === 'code_aware' && !this.options.codeAware) return { strategy: 'passthrough', reason: `source_code (${conf}) but code-aware compression is off` };
    if (natural === 'text' && !this.options.textCompression) return { strategy: 'passthrough', reason: `plain_text (${conf}) but text compression is off` };
    if (this.options.compressors.length && !this.options.compressors.includes(natural)) return { strategy: 'passthrough', reason: `${natural} not in the allowed compressor list` };
    return { strategy: natural, reason: `${det.type} (${conf}) → ${natural}` };
  }

  compress(req: CompressRequest): CompressResponse {
    try {
      return this.compressInner(req, false);
    } catch {
      return this.passthrough(req.content, ['router_error']);
    }
  }

  private passthrough(content: string, chain: string[], info?: string): CompressResponse {
    return { content, strategy: 'passthrough', chain: [...chain, 'passthrough'], ccrHashes: [], info };
  }

  private compressInner(req: CompressRequest, nested: boolean): CompressResponse {
    const t0 = this.now();
    const deadline = this.options.deadlineMs > 0 ? this.options.deadlineMs : Number.POSITIVE_INFINITY;
    const overdue = (): boolean => this.now() - t0 > deadline;
    const content = req.content;
    if (!content || !content.trim()) return this.passthrough(content, ['empty']);
    if (isAlreadyCompressed(content)) return this.passthrough(content, ['already_compressed']);
    const profile = req.profile ?? (req.toolName ? this.toolProfiles[req.toolName] : undefined);
    if (profile?.skipCompression) return this.passthrough(content, ['skip_compression'], `tool ${req.toolName ?? ''} is byte-exact`);
    const losslessOnly = req.losslessOnly || this.options.lossless || profile?.losslessOnly === true;
    const injectMarker = req.injectMarker && !losslessOnly;
    const tokenizer = req.tokenizer ?? this.tokenizer;

    const det = detectContentType(content, { toolName: req.toolName, language: req.language });
    const pick = this.pickStrategy(det);
    const strategy = pick.strategy;
    const originalTokens = tokenizer.count(content);
    const minTokens = profile?.minTokensToCompress ?? this.options.minTokens;
    const belowFloor = originalTokens < minTokens;

    // Stage 0 — lossless-first
    const fold = bestLosslessFold(content, { allowDiff: strategy === 'diff' || looksLikeDiff(content), primary: losslessKindFor(strategy, det.metadata) });
    const foldResponse = (): CompressResponse | null => {
      if (!fold) return null;
      return { content: fold.text, strategy: 'lossless', chain: [`lossless_${fold.kind}`], ccrHashes: [], info: `lossless fold (${fold.kind})` };
    };
    if (losslessOnly || belowFloor || strategy === 'lossless' || strategy === 'passthrough') {
      return foldResponse() ?? this.passthrough(content, [losslessOnly ? 'lossless_only' : belowFloor ? 'below_min_tokens' : strategy === 'lossless' ? 'no_fold' : 'no_strategy'], pick.reason);
    }
    if (overdue()) return foldResponse() ?? this.passthrough(content, ['deadline'], 'deadline exceeded before lossy stage');

    // Stage 1 — lossy
    const lossyReq: CompressRequest = { ...req, tokenizer, injectMarker, losslessOnly: false, profile, bias: req.bias ?? profile?.bias, targetRatio: req.targetRatio ?? this.options.targetRatio };
    let res: CompressResponse;
    if (strategy === 'mixed' && !nested) res = this.compressMixed(lossyReq);
    else {
      const compressor = this.compressors.get(strategy);
      if (!compressor) return foldResponse() ?? this.passthrough(content, ['no_compressor'], pick.reason);
      res = this.safeCompress(compressor, lossyReq);
    }
    if (overdue()) return foldResponse() ?? this.passthrough(content, ['deadline'], 'deadline exceeded during lossy stage');

    let lossyOk = res.strategy !== 'passthrough' && res.content.trim().length > 0 && res.content !== content;
    let lossyTokens = lossyOk ? tokenizer.count(res.content) : originalTokens;
    if (lossyOk && lossyTokens >= originalTokens) lossyOk = false;

    // No-savings fallback to extractive text for structural strategies.
    if (!lossyOk && TEXT_FALLBACK.has(strategy) && this.options.textCompression && !res.ccrHashes.length) {
      const text = this.compressors.get('text') as Compressor;
      const alt = this.safeCompress(text, { ...lossyReq, injectMarker });
      if (alt.strategy !== 'passthrough' && alt.content.trim() && alt.content !== content) {
        const altTokens = tokenizer.count(alt.content);
        if (altTokens < originalTokens) {
          res = { ...alt, chain: [strategy, ...alt.chain] };
          lossyOk = true;
          lossyTokens = altTokens;
        }
      }
    }
    // lossless-then-lossy layer on extracted HTML prose
    if (lossyOk && strategy === 'html' && this.options.losslessThenLossy && this.options.textCompression) {
      const text = this.compressors.get('text') as Compressor;
      const alt = this.safeCompress(text, { ...lossyReq, content: res.content });
      if (alt.strategy !== 'passthrough' && alt.content.trim()) {
        const altTokens = tokenizer.count(alt.content);
        if (altTokens <= lossyTokens * (1 - this.options.lossyMinExtraSavings) && alt.content.length < res.content.length) {
          res = { ...res, content: alt.content, chain: [...res.chain, ...alt.chain], info: `${res.info ?? ''} + ${alt.info ?? ''}`.trim() };
          lossyTokens = altTokens;
        }
      }
    }

    const resultIsLossless = lossyOk && isLosslessResult(res.chain, res.strategy);
    // Choose between the fold and the lossy result.
    let chosen: CompressResponse | null = null;
    let usedFold = false;
    if (fold) {
      const foldTokens = tokenizer.count(fold.text);
      const beats = lossyOk && lossyTokens <= foldTokens * (1 - this.options.lossyMinExtraSavings) && res.content.length < fold.text.length;
      if (beats && (resultIsLossless || this.options.losslessThenLossy)) {
        // the lossy pass ran on the original, so the fold is not part of the output — record only that it was beaten
        chosen = { ...res, info: `${res.info ?? ''} (beat lossless_${fold.kind} by ≥${Math.round(this.options.lossyMinExtraSavings * 100)}%)`.trim() };
      } else {
        chosen = foldResponse();
        usedFold = true;
      }
    } else if (lossyOk) chosen = res;
    if (!chosen) return this.passthrough(content, [strategy], res.info ?? pick.reason);
    if (usedFold) return chosen;
    if (resultIsLossless) return { ...chosen, strategy: chosen.strategy === 'passthrough' ? 'lossless' : chosen.strategy };

    // Guards for lossy results.
    const recoverable = injectMarker && !!req.ccr;
    if (req.injectMarker && !losslessOnly && !recoverable && this.options.guardLossy) {
      // markers were requested but nothing can store the original → unrecoverable lossy is refused
      if (LOSSY_UNMARKED.has(strategy) || !res.ccrHashes.length) return foldResponse() ?? this.passthrough(content, [strategy, 'rejected_unrecoverable'], 'no store for the original');
    }
    if (this.options.accuracyGuard) {
      const g = accuracyGuard(content, chosen.content, { recoverable });
      if (!g.ok) {
        const missing = [...g.missingErrors, ...g.missingIds].slice(0, 3).join(', ');
        return foldResponse() ?? this.passthrough(content, [strategy, 'rejected_accuracy_guard'], `dropped anchors: ${missing}`);
      }
    }

    // Store + hint.
    let out = chosen.content;
    const hashes = [...chosen.ccrHashes];
    if (recoverable && req.ccr) {
      const compressedTokens = tokenizer.count(out);
      let hash = hashes[0];
      if (!hash) {
        try {
          hash = req.ccr.store(content, {
            compressed: out,
            strategy: chosen.strategy,
            originalTokens,
            compressedTokens,
            originalItemCount: chosen.itemCounts?.original,
            compressedItemCount: chosen.itemCounts?.kept,
            toolName: req.toolName,
            queryContext: req.query,
          });
          hashes.push(hash);
        } catch {
          return foldResponse() ?? this.passthrough(content, [strategy, 'store_failed']);
        }
      }
      out = `${out}\n${retrievalHint(WHOLE_BLOCK.has(chosen.strategy) ? 'original' : 'more', hash, originalTokens, compressedTokens, req.toolName)}`;
      if (tokenizer.count(out) >= originalTokens) return foldResponse() ?? this.passthrough(content, [strategy, 'rejected_not_smaller']);
    }
    if (!out.trim()) return foldResponse() ?? this.passthrough(content, [strategy, 'empty_output']);
    return { ...chosen, content: out, ccrHashes: hashes };
  }

  private safeCompress(compressor: Compressor, req: CompressRequest): CompressResponse {
    try {
      const r = compressor.compress(req);
      if (!r || typeof r.content !== 'string') return this.passthrough(req.content, [compressor.strategy, 'bad_result']);
      return r;
    } catch (err) {
      return this.passthrough(req.content, [compressor.strategy, 'compressor_error'], err instanceof Error ? err.message : String(err));
    }
  }

  /** Mixed content: compress each section by its own type (marker-free), re-fence code, join with blank lines. */
  private compressMixed(req: CompressRequest): CompressResponse {
    const sections = splitIntoSections(req.content);
    if (sections.length < 2) return this.passthrough(req.content, ['mixed', 'single_section']);
    const parts: string[] = [];
    const chain: string[] = ['mixed'];
    let changed = false;
    for (const s of sections) {
      const sub: CompressRequest = { ...req, content: s.text, injectMarker: false, losslessOnly: false, language: s.kind === 'fence' ? (s.lang ?? req.language) : undefined, profile: undefined, toolName: undefined };
      if (!s.text.trim()) {
        parts.push(s.text);
        continue;
      }
      const r = this.compressInner(sub, true);
      const body = r.strategy === 'passthrough' ? s.text : r.content;
      if (r.strategy !== 'passthrough') {
        changed = true;
        chain.push(...r.chain.filter((c) => c !== 'passthrough'));
      }
      parts.push(s.kind === 'fence' ? `\`\`\`${s.lang ?? ''}\n${body}\n\`\`\`` : body);
    }
    if (!changed) return this.passthrough(req.content, ['mixed', 'no_section_changed']);
    return { content: parts.join('\n\n'), strategy: 'mixed', chain, ccrHashes: [], info: `mixed(${sections.length} sections)` };
  }
}

export function createRouter(opts: RouterOptions = {}): ContentRouter {
  return new ContentRouter(opts);
}

/** Pre-load tree-sitter grammars so code-aware compression takes the AST path. */
export async function warmRouter(languages?: readonly string[]): Promise<string[]> {
  return prepareCodeCompressor(languages);
}
