/**
 * Pooled, warm llama.cpp sessions — the production hot path for Approach B.
 *
 * Best-in-breed requirements vs the old one-shot load-per-chat path:
 *  - Model + context stay resident across turns (TTFT collapses after first load)
 *  - GBNF grammar when the binding exposes LlamaGrammar
 *  - Graph draft speculative acceptance (multi-candidate rank, P2)
 *  - KV multi-turn cursor + optional evaluate-only reuse of warm prefixes
 *  - Static TokenBias + dynamic open-identifier filter (P1/P2)
 *
 * Binding is always injected (never a static import of node-llama-cpp).
 */

import { annotateUnknownIdentifiers, scanIdentifiersAgainstTrie } from '../identifier-mask.js';
import type { TrieNode } from '../identifier-trie.js';
import {
  contentHash,
  KvBlockRegistry,
  longestWarmPrefix,
  SessionPrefixCursor,
  type KvAssemblyPlan,
} from '../kv-cache.js';
import {
  probeBindingCapabilities,
  supportsDynamicIdentSampler,
  type BindingCapabilities,
} from './binding-capabilities.js';
import { composePromptConstraints } from './compose-constraints.js';
import {
  allowGrammarStringFallback,
  assertGrammarOrThrow,
  attachGrammar,
  type GrammarAttachMethod,
} from './grammar.js';
import { attachDynamicIdentFilter } from './identifier-sampler.js';
import {
  buildIdentifierTokenBias,
  trieFingerprint,
  type LogitMaskBuildResult,
  type SamplerHookMethod,
} from './logit-mask.js';
import { rankDraftCandidates } from './speculative.js';
import type { LlmChatMessage, LlmGenerateResult } from './types.js';

export interface HostSessionKey {
  modelPath: string;
  isolation: 'embedded' | 'process';
}

export interface HostGenerateExtras {
  grammar?: string;
  /**
   * When true (Spark / constrained packs), fail if grammar cannot be attached.
   * Default false for Flow/Forge free-form tool calling.
   */
  requireGrammar?: boolean;
  identifierTrie?: TrieNode;
  annotateUnknownIdentifiers?: boolean;
  /** Verbatim spans the graph already knows — speculative draft candidates. */
  draftCandidates?: string[];
  /** Soft token cap. */
  maxTokens?: number;
  temperature?: number;
  /** Ordered prompt segments for KV hit/miss planning (system, capsule, …). */
  promptSegments?: Array<{ kind: string; text: string }>;
  env?: NodeJS.ProcessEnv;
  /**
   * When true (default), suppress vocab tokens that are complete unknown
   * identifiers. Set false for faster bias build (boost-only).
   */
  suppressUnknownLogits?: boolean;
  /** Force dynamic sampler capability for tests. */
  assumeOnToken?: boolean;
  assumeCustomSampler?: boolean;
}

export interface HostGenerateReport extends LlmGenerateResult {
  /** Speculative draft tokens accepted (0 when none). */
  draftAcceptedChars: number;
  /** How many draft candidates were ranked/tried. */
  draftCandidatesTried?: number;
  /** KV assembly plan for this turn (if segments provided). */
  kvPlan?: KvAssemblyPlan;
  /** Grammar object was constructed and applied. */
  grammarApplied: boolean;
  grammarMethod?: GrammarAttachMethod;
  /** Logit bias / custom sampler path engaged. */
  samplerHook: boolean;
  /** How the sampler hook was applied (P1/P2). */
  samplerMethod?: SamplerHookMethod;
  /** Tokens boosted / suppressed on TokenBias. */
  samplerBoostedTokens?: number;
  samplerSuppressedTokens?: number;
  /** Dynamic open-identifier filter attached. */
  dynamicSampler?: boolean;
  /** Approx tokens skipped via warm-prefix evaluate (RoPE reuse path). */
  kvPrefixReusedTokens?: number;
  /** P2: tokens still evaluated after multi-turn cursor skip. */
  kvDeltaTokens?: number;
  /** Binding capability summary for this generate. */
  bindingCaps?: string[];
  /** Constraint layers composed onto prompt(). */
  constraintLayers?: { grammar: boolean; tokenBias: boolean; dynamic: boolean };
  /** Session was warm (model already loaded). */
  warmStart: boolean;
  /** Wall-clock ms for this generate (best-effort). */
  latencyMs: number;
}

interface WarmSession {
  key: string;
  lib: any;
  /** Same getLlama() instance used to load the model — required for LlamaGrammar. */
  llama: any;
  modelPath: string;
  model: any;
  context: any;
  sequence: any;
  chat: any;
  kv: KvBlockRegistry;
  cursor: SessionPrefixCursor;
  lastUsed: number;
  loads: number;
  /** Cached TokenBias keyed by trie fingerprint. */
  logitMaskCache: Map<string, LogitMaskBuildResult>;
  caps: BindingCapabilities | null;
}

const globalPool = new Map<string, WarmSession>();

export function sessionKey(modelPath: string): string {
  return `embedded:${modelPath}`;
}

/** Test/harness: drop all warm sessions. */
export function clearHostSessionPool(): void {
  globalPool.clear();
}

export function hostSessionPoolSize(): number {
  return globalPool.size;
}

export interface HostSessionInfo {
  key: string;
  modelPath: string;
  loads: number;
  lastUsed: number;
  /** Warm KV blocks in the session registry. */
  kvBlocks: number;
  /** Leading cursor chain length (multi-turn prefix). */
  cursorBlocks: number;
  bindingCaps: string[] | null;
}

/** Snapshot of warm sessions for doctor / host-status (no secrets). */
export function listHostSessions(): HostSessionInfo[] {
  return [...globalPool.values()]
    .map((s) => ({
      key: s.key,
      modelPath: s.modelPath,
      loads: s.loads,
      lastUsed: s.lastUsed,
      kvBlocks: s.kv.size(),
      cursorBlocks: s.cursor.evaluatedHashes.length,
      bindingCaps: s.caps?.summary ?? null,
    }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Drop one session by model path (or key). Returns true if removed. */
export function dropHostSession(modelPathOrKey: string): boolean {
  const key = modelPathOrKey.startsWith('embedded:') ? modelPathOrKey : sessionKey(modelPathOrKey);
  return globalPool.delete(key);
}

/**
 * Obtain or create a warm session for modelPath. Reuses model/context/chat.
 */
export async function acquireHostSession(lib: unknown, modelPath: string): Promise<WarmSession> {
  const key = sessionKey(modelPath);
  const existing = globalPool.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  const l: any = lib;
  if (!l || typeof l.getLlama !== 'function') {
    throw new Error('llm-host session: invalid node-llama-cpp module (getLlama missing)');
  }
  const llama = await l.getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  const sequence = context.getSequence();
  const { LlamaChatSession } = l;
  if (typeof LlamaChatSession !== 'function') {
    throw new Error('llm-host session: LlamaChatSession missing');
  }
  const chat = new LlamaChatSession({ contextSequence: sequence });
  const sess: WarmSession = {
    key,
    lib: l,
    llama,
    modelPath,
    model,
    context,
    sequence,
    chat,
    kv: new KvBlockRegistry(),
    cursor: new SessionPrefixCursor(),
    lastUsed: Date.now(),
    loads: 1,
    logitMaskCache: new Map(),
    caps: null,
  };
  globalPool.set(key, sess);
  return sess;
}

/** Evict idle sessions (LRU) when over cap. */
export function evictIdleSessions(maxSessions = 2, maxIdleMs = 30 * 60_000, now = Date.now()): number {
  if (globalPool.size <= maxSessions) {
    let dropped = 0;
    for (const [k, s] of globalPool) {
      if (now - s.lastUsed > maxIdleMs) {
        globalPool.delete(k);
        dropped++;
      }
    }
    return dropped;
  }
  const ordered = [...globalPool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let dropped = 0;
  while (globalPool.size > maxSessions && ordered.length) {
    const [k] = ordered.shift()!;
    globalPool.delete(k);
    dropped++;
  }
  return dropped;
}

/**
 * Best-in-breed generate on a warm session.
 */
export async function generateOnSession(
  session: WarmSession,
  messages: LlmChatMessage[],
  extras: HostGenerateExtras = {},
): Promise<HostGenerateReport> {
  const t0 = Date.now();
  const warmStart = session.loads > 0 && session.lastUsed > 0;
  session.loads++;
  session.lastUsed = Date.now();

  const env = extras.env ?? process.env;
  const caps =
    session.caps ??
    probeBindingCapabilities(session.lib, session.model, session.sequence, {
      assumeOnToken: extras.assumeOnToken,
      assumeCustomSampler: extras.assumeCustomSampler,
      env,
    });
  session.caps = caps;

  const segments =
    extras.promptSegments ??
    messages.map((m, i) => ({
      kind: m.role === 'system' ? 'system' : i === messages.length - 1 ? 'user' : 'context',
      text: m.content,
    }));
  const kvPlan = session.kv.plan(segments, session.cursor);

  // Multi-turn delta evaluate (P2) — only re-evaluate from fork when possible.
  const prefixReuse = await tryReuseWarmPrefix(session, segments, kvPlan, caps);

  const ranked = rankDraftCandidates(extras.draftCandidates, messages, 3);
  let draftAcceptedChars = 0;
  let draftCandidatesTried = 0;
  let text = '';

  const stringOk = allowGrammarStringFallback(env);
  // Pass the session's llama instance — LlamaGrammar must share it with the model.
  const grammar = await attachGrammar(session.lib, extras.grammar, { llama: session.llama });
  assertGrammarOrThrow(grammar, {
    requireGrammar: extras.requireGrammar,
    allowStringFallback: stringOk,
  });
  let promptGrammar: unknown | null = null;
  if (grammar.applied) promptGrammar = grammar.value;
  else if (grammar.method === 'string-fallback' && grammar.value && (stringOk || !extras.requireGrammar)) {
    promptGrammar = grammar.value;
  }

  const mask = resolveLogitMask(session, extras.identifierTrie, extras.suppressUnknownLogits !== false);

  const baseOpts: Record<string, unknown> = {
    temperature: extras.temperature ?? 0,
  };
  if (typeof extras.maxTokens === 'number') baseOpts.maxTokens = extras.maxTokens;

  // Dynamic open-identifier filter (P2) — only when capability declared.
  const dynBag: Record<string, unknown> = {};
  let dynamicAttached = false;
  let dynMethod: 'onToken' | 'customSampler' | 'none' = 'none';
  if (extras.identifierTrie && supportsDynamicIdentSampler(caps)) {
    const dyn = attachDynamicIdentFilter(dynBag, extras.identifierTrie, {
      onTokenCallback: caps.onTokenCallback,
      customSampler: caps.customSampler,
    });
    dynamicAttached = dyn.attached;
    dynMethod = dyn.method;
  }

  const composed = composePromptConstraints({
    base: baseOpts,
    grammar: promptGrammar,
    tokenBias: mask.tokenBias,
    dynamic: dynamicAttached ? dynBag : null,
  });

  const samplerMethod = resolveSamplerMethod(mask, dynamicAttached, dynMethod);

  if (ranked.length) {
    let accepted: string | null = null;
    for (const d of ranked) {
      draftCandidatesTried++;
      if (await tryAcceptDraft(session, d.text, caps)) {
        accepted = d.text;
        break;
      }
    }
    if (accepted) {
      draftAcceptedChars = accepted.length;
      text = accepted;
      const continueMsgs = [
        ...messages,
        { role: 'assistant' as const, content: accepted },
        { role: 'user' as const, content: 'Continue from the draft above without repeating it.' },
      ];
      const cont = await sessionPrompt(session, continueMsgs, composed.promptOpts);
      text = accepted + (cont.startsWith(accepted) ? cont.slice(accepted.length) : cont);
    } else {
      text = await sessionPrompt(session, messages, composed.promptOpts);
    }
  } else {
    text = await sessionPrompt(session, messages, composed.promptOpts);
  }

  session.kv.commit(segments);
  session.cursor.commit(kvPlan.order);

  let unknownIdentifiers: string[] | undefined;
  if (extras.identifierTrie) {
    if (extras.annotateUnknownIdentifiers !== false) {
      const ann = annotateUnknownIdentifiers(text, extras.identifierTrie);
      text = ann.text;
      unknownIdentifiers = ann.unknown.length ? ann.unknown : undefined;
    } else {
      const scan = scanIdentifiersAgainstTrie(text, extras.identifierTrie);
      unknownIdentifiers = scan.unknown.length ? scan.unknown : undefined;
    }
  }

  return {
    text,
    model: session.modelPath,
    isolation: 'embedded',
    constrained: grammar.applied || (!!promptGrammar && stringOk) || dynamicAttached,
    unknownIdentifiers,
    draftAcceptedChars,
    draftCandidatesTried,
    kvPlan,
    grammarApplied: grammar.applied || (!!promptGrammar && stringOk && grammar.method === 'string-fallback'),
    grammarMethod: grammar.method,
    samplerHook: mask.applied || dynamicAttached,
    samplerMethod,
    samplerBoostedTokens: mask.boostedTokens,
    samplerSuppressedTokens: mask.suppressedTokens,
    dynamicSampler: dynamicAttached,
    kvPrefixReusedTokens: prefixReuse.tokens,
    kvDeltaTokens: kvPlan.deltaTokens,
    bindingCaps: caps.summary,
    constraintLayers: composed.layers,
    warmStart,
    latencyMs: Date.now() - t0,
  };
}

function resolveSamplerMethod(
  mask: LogitMaskBuildResult,
  dynamicAttached: boolean,
  dynMethod: 'onToken' | 'customSampler' | 'none',
): SamplerHookMethod {
  if (mask.applied && dynamicAttached) return 'TokenBias+dynamic';
  if (dynamicAttached && dynMethod === 'onToken') return 'dynamic-onToken';
  if (dynamicAttached && dynMethod === 'customSampler') return 'dynamic-customSampler';
  return mask.method;
}

function resolveLogitMask(
  session: WarmSession,
  trie: TrieNode | undefined,
  suppressUnknown: boolean,
): LogitMaskBuildResult {
  if (!trie) {
    return { applied: false, method: 'none', tokenBias: null, boostedTokens: 0, suppressedTokens: 0 };
  }
  const fp = `${trieFingerprint(trie)}|sup=${suppressUnknown ? 1 : 0}`;
  const cached = session.logitMaskCache.get(fp);
  if (cached) return cached;
  const built = buildIdentifierTokenBias(session.lib, session.model, trie, {
    suppressUnknown,
  });
  if (session.logitMaskCache.size > 8) session.logitMaskCache.clear();
  session.logitMaskCache.set(fp, built);
  return built;
}

async function sessionPrompt(session: WarmSession, messages: LlmChatMessage[], promptOpts: Record<string, unknown>): Promise<string> {
  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
  const text: string = await session.chat.prompt(prompt, promptOpts);
  return typeof text === 'string' ? text : String(text ?? '');
}

async function tryAcceptDraft(session: WarmSession, draft: string, caps: BindingCapabilities): Promise<boolean> {
  try {
    const seq = session.sequence;
    if (caps.evaluateWithoutGenerate && caps.tokenize && seq && typeof seq.evaluateWithoutGeneratingNewTokens === 'function') {
      const model = session.model;
      if (model && typeof model.tokenize === 'function') {
        const tokens = model.tokenize(draft);
        await seq.evaluateWithoutGeneratingNewTokens(tokens);
        return true;
      }
    }
  } catch {
    /* fall through */
  }
  return session.kv.isWarm(contentHash(draft));
}

/**
 * RoPE-friendly prefix reuse with multi-turn cursor (P2).
 * Prefer evaluating only the delta after the last committed chain.
 */
async function tryReuseWarmPrefix(
  session: WarmSession,
  segments: Array<{ kind: string; text: string }>,
  plan: KvAssemblyPlan,
  caps: BindingCapabilities,
): Promise<{ tokens: number; method: 'evaluate-delta' | 'evaluate-prefix' | 'plan-only' | 'none' }> {
  const prefix = longestWarmPrefix(session.kv, segments);
  if (prefix.count === 0 && (plan.cursorSkipBlocks ?? 0) === 0) {
    return { tokens: 0, method: 'none' };
  }

  const canEval = caps.tokenize && caps.evaluateWithoutGenerate;
  try {
    const seq = session.sequence;
    const model = session.model;
    if (canEval && seq && typeof seq.evaluateWithoutGeneratingNewTokens === 'function' && model && typeof model.tokenize === 'function') {
      // Prefer delta text from cursor when we skipped leading blocks.
      const delta = session.cursor.delta(plan.order, segments);
      if (delta.skipBlocks > 0 && delta.evaluateText) {
        const tokens = model.tokenize(delta.evaluateText);
        await seq.evaluateWithoutGeneratingNewTokens(tokens);
        return { tokens: plan.hitTokens, method: 'evaluate-delta' };
      }
      if (prefix.text) {
        const tokens = model.tokenize(prefix.text);
        await seq.evaluateWithoutGeneratingNewTokens(tokens);
        return { tokens: prefix.tokens, method: 'evaluate-prefix' };
      }
    }
  } catch {
    /* plan-only */
  }

  const tokens = prefix.tokens || plan.hitTokens;
  if (tokens > 0) return { tokens, method: 'plan-only' };
  return { tokens: 0, method: 'none' };
}
