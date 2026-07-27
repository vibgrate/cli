/**
 * Native logit mask / TokenBias construction for Approach B (P1).
 *
 * When node-llama-cpp exposes {@link TokenBias} + model tokenizer APIs, we:
 *  1. **Boost** tokens that spell graph identifiers (positive bias)
 *  2. Optionally **suppress** vocabulary tokens that are complete identifiers
 *     absent from the trie (`"never"` / strong negative)
 *
 * Without a binding, this module still exposes pure helpers for tests and for
 * char-level mask planning ({@link maskAllowedNextChars}).
 *
 * Full dynamic per-step trie masking (only-allow next chars of an open
 * identifier) needs a custom sampler callback; TokenBias is the portable
 * production path across node-llama-cpp versions.
 */

import {
  maskAllowedNextChars,
  extractIdentifiers,
} from '../identifier-mask.js';
import {
  trieEnumerateWords,
  trieHas,
  trieHasPrefix,
  type TrieNode,
} from '../identifier-trie.js';

export type SamplerHookMethod =
  | 'none'
  | 'TokenBias'
  | 'TokenBias-boost'
  | 'dynamic-onToken'
  | 'dynamic-customSampler'
  | 'TokenBias+dynamic'
  | 'capability';

export interface LogitMaskBuildResult {
  applied: boolean;
  method: SamplerHookMethod;
  /** TokenBias instance (or compatible) to pass as `tokenBias` on prompt(). */
  tokenBias: unknown | null;
  boostedTokens: number;
  suppressedTokens: number;
  reason?: string;
}

export interface BuildLogitMaskOptions {
  /** Soft boost for tokens that encode known graph identifiers (default 0.35). */
  boost?: number;
  /**
   * When true, scan vocabulary (capped) and mark complete unknown identifiers
   * as `"never"`. Expensive; cached by callers per session+trie.
   */
  suppressUnknown?: boolean;
  /** Max vocab tokens to scan for suppress (default 50_000). */
  maxVocabScan?: number;
  /** Max graph identifiers to boost (default 2048). */
  maxBoostIds?: number;
}

/** Identifier-shaped token text (whole token is one ident). */
const COMPLETE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;

/**
 * Build a node-llama-cpp TokenBias for the given trie, or report why not.
 * Safe on missing APIs — never throws for capability gaps.
 */
export function buildIdentifierTokenBias(
  lib: unknown,
  model: unknown,
  trie: TrieNode | null | undefined,
  options: BuildLogitMaskOptions = {},
): LogitMaskBuildResult {
  if (!trie) {
    return { applied: false, method: 'none', tokenBias: null, boostedTokens: 0, suppressedTokens: 0, reason: 'no trie' };
  }
  const l: any = lib;
  const m: any = model;
  if (!l || typeof l.TokenBias !== 'function') {
    // Capability probe: model may still expose iterateAllTokens for future hooks.
    if (m && typeof m.iterateAllTokens === 'function') {
      return {
        applied: false,
        method: 'capability',
        tokenBias: null,
        boostedTokens: 0,
        suppressedTokens: 0,
        reason: 'TokenBias class missing (binding can iterate tokens)',
      };
    }
    return {
      applied: false,
      method: 'none',
      tokenBias: null,
      boostedTokens: 0,
      suppressedTokens: 0,
      reason: 'TokenBias unavailable',
    };
  }
  const tokenizer = m?.tokenizer ?? m;
  if (!tokenizer) {
    return {
      applied: false,
      method: 'none',
      tokenBias: null,
      boostedTokens: 0,
      suppressedTokens: 0,
      reason: 'model.tokenizer missing',
    };
  }

  let bias: any;
  try {
    bias = new l.TokenBias(tokenizer);
  } catch (e) {
    return {
      applied: false,
      method: 'none',
      tokenBias: null,
      boostedTokens: 0,
      suppressedTokens: 0,
      reason: e instanceof Error ? e.message : 'TokenBias construct failed',
    };
  }

  const boost = options.boost ?? 0.35;
  const maxBoostIds = options.maxBoostIds ?? 2048;
  const words = trieEnumerateWords(trie, maxBoostIds);
  let boostedTokens = 0;

  for (const word of words) {
    if (word.length < 3) continue;
    const tokens = tokenizeBestEffort(m, word);
    for (const tok of tokens) {
      try {
        // Prefer probability-scale bias; fall back to logit form.
        if (typeof bias.set === 'function') {
          try {
            bias.set(tok, boost);
          } catch {
            bias.set(tok, { logit: boost });
          }
          boostedTokens++;
        }
      } catch {
        /* skip undecodable */
      }
    }
  }

  let suppressedTokens = 0;
  if (options.suppressUnknown !== false && typeof m.iterateAllTokens === 'function' && typeof m.detokenize === 'function') {
    const maxScan = options.maxVocabScan ?? 50_000;
    let scanned = 0;
    try {
      for (const token of m.iterateAllTokens()) {
        if (scanned++ >= maxScan) break;
        let text = '';
        try {
          text = m.detokenize([token]);
        } catch {
          continue;
        }
        if (!text || !COMPLETE_IDENT.test(text)) continue;
        if (trieHas(trie, text) || trieHasPrefix(trie, text)) continue;
        // Stopwords / language keywords already filtered by COMPLETE_IDENT min length;
        // extractIdentifiers would drop many — still suppress bare unknown idents.
        try {
          bias.set(token, 'never');
          suppressedTokens++;
        } catch {
          try {
            bias.set(token, -0.95);
            suppressedTokens++;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* iterate may throw on some bindings — keep boost-only bias */
    }
  }

  const method: SamplerHookMethod =
    boostedTokens > 0 || suppressedTokens > 0
      ? suppressedTokens > 0
        ? 'TokenBias'
        : 'TokenBias-boost'
      : 'none';

  return {
    applied: method !== 'none',
    method: method === 'none' ? 'none' : method,
    tokenBias: method === 'none' ? null : bias,
    boostedTokens,
    suppressedTokens,
    reason: method === 'none' ? 'no tokens adjusted' : undefined,
  };
}

function tokenizeBestEffort(model: any, text: string): unknown[] {
  try {
    if (typeof model.tokenize === 'function') {
      const t = model.tokenize(text);
      if (Array.isArray(t)) return t;
      if (t && typeof t[Symbol.iterator] === 'function') return [...t];
    }
  } catch {
    /* fall through */
  }
  try {
    if (model.tokenizer && typeof model.tokenizer.encode === 'function') {
      const t = model.tokenizer.encode(text);
      if (Array.isArray(t)) return t;
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Pure planner: which next characters are legal for an open identifier under the trie.
 * Used by tests and future custom-sampler callbacks.
 */
export function planNextCharMask(trie: TrieNode, partialIdent: string): string[] {
  return maskAllowedNextChars(trie, partialIdent);
}

/**
 * Whether a generated token string would open or continue an illegal identifier.
 * Pure helper for sampler unit tests (no binding).
 */
export function tokenCompatibleWithTrie(tokenText: string, trie: TrieNode, openPrefix = ''): boolean {
  const joined = openPrefix + tokenText;
  // If the join is still a prefix of some graph word, or is a known word, ok.
  if (trieHas(trie, joined) || trieHasPrefix(trie, joined)) return true;
  // Multi-ident tokens: each complete identifier must be known or a stopword-ish short token.
  const ids = extractIdentifiers(joined);
  if (ids.length === 0) return true;
  return ids.every((id) => trieHas(trie, id) || trieHasPrefix(trie, id));
}

/** Cache key for session-level TokenBias reuse (trie word set fingerprint). */
export function trieFingerprint(trie: TrieNode, limit = 256): string {
  const words = trieEnumerateWords(trie, limit);
  return `${words.length}:${words.slice(0, 32).join('|')}`;
}
