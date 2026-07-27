/**
 * Open-identifier dynamic sampler (Approach B / P2).
 *
 * Tracks whether generation is inside a code identifier and rejects **whole
 * tokens** that invent graph-unknown names (not char-by-char keyword traps —
 * BPE may emit `return` as one token; that must stay legal).
 *
 * Used for:
 *  - Per-token `onToken` / `customSampler` hooks when the binding supports them
 *  - Unit-test invent-resistance without a native model
 *  - `allowedNextChars` planning while an open prefix is in flight
 */

import { maskAllowedNextChars } from '../identifier-mask.js';
import { trieHas, trieHasPrefix, type TrieNode } from '../identifier-trie.js';

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;
const COMPLETE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;

/** Language / common tokens never treated as “invented symbols”. */
const STOP = new Set([
  'the', 'and', 'for', 'var', 'let', 'const', 'function', 'class', 'return',
  'import', 'export', 'from', 'async', 'await', 'true', 'false', 'null',
  'undefined', 'this', 'new', 'typeof', 'interface', 'type', 'string',
  'number', 'boolean', 'void', 'any', 'unknown', 'Promise', 'Array', 'Object',
  'Error', 'console', 'process', 'require', 'module', 'exports', 'default',
  'extends', 'implements', 'public', 'private', 'protected', 'static',
  'readonly', 'if', 'else', 'while', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'with', 'yield', 'of', 'in', 'as',
  'is', 'get', 'set', 'super', 'delete', 'void', 'enum', 'package',
]);

export type IdentStreamMode = 'free' | 'in_ident';

export interface IdentStreamState {
  mode: IdentStreamMode;
  /** Accumulated identifier prefix when mode === 'in_ident'. */
  prefix: string;
}

export interface IdentStepResult {
  next: IdentStreamState;
  /** False when the token would invent an identifier not in the trie. */
  allowed: boolean;
  reason?: string;
  /** When in_ident after the step, next legal chars (null when free). */
  allowedNextChars: string[] | null;
}

export function createIdentStreamState(): IdentStreamState {
  return { mode: 'free', prefix: '' };
}

function isStop(s: string): boolean {
  return STOP.has(s) || STOP.has(s.toLowerCase());
}

/**
 * Advance the stream with one decoded token string.
 */
export function stepIdentStream(
  state: IdentStreamState,
  tokenText: string,
  trie: TrieNode | null | undefined,
): IdentStepResult {
  if (!tokenText) {
    return { next: state, allowed: true, allowedNextChars: allowedChars(state, trie) };
  }
  if (!trie) {
    return { next: trackOnly(state, tokenText), allowed: true, allowedNextChars: null };
  }

  // Invent check: whole-token (or open-prefix + token) against the graph trie.
  if (state.mode === 'in_ident') {
    const joined = state.prefix + tokenText;
    // Extract the identifier head of joined (up to first non-ident).
    const m = joined.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    const head = m?.[0] ?? '';
    if (head.length >= 3 && !isStop(head) && !trieHas(trie, head) && !trieHasPrefix(trie, head)) {
      return {
        next: state,
        allowed: false,
        reason: `identifier '${head}' not in graph trie`,
        allowedNextChars: maskAllowedNextChars(trie, state.prefix),
      };
    }
  } else if (COMPLETE_IDENT.test(tokenText) && !isStop(tokenText)) {
    if (!trieHas(trie, tokenText) && !trieHasPrefix(trie, tokenText)) {
      return {
        next: state,
        allowed: false,
        reason: `identifier '${tokenText}' not in graph trie`,
        allowedNextChars: null,
      };
    }
  }

  const next = trackOnly(state, tokenText);
  return {
    next,
    allowed: true,
    allowedNextChars: allowedChars(next, trie),
  };
}

/** Update free/in_ident bookkeeping without invent checks. */
function trackOnly(state: IdentStreamState, tokenText: string): IdentStreamState {
  let mode = state.mode;
  let prefix = state.prefix;
  for (const ch of tokenText) {
    if (mode === 'free') {
      if (IDENT_START.test(ch)) {
        mode = 'in_ident';
        prefix = ch;
      }
    } else if (IDENT_CONT.test(ch)) {
      prefix += ch;
    } else {
      mode = 'free';
      prefix = '';
    }
  }
  return { mode, prefix };
}

function allowedChars(state: IdentStreamState, trie: TrieNode | null | undefined): string[] | null {
  if (!trie || state.mode !== 'in_ident') return null;
  return maskAllowedNextChars(trie, state.prefix);
}

/**
 * Filter candidate next-token *texts* under the current stream state.
 */
export function filterTokenTexts(
  state: IdentStreamState,
  candidates: string[],
  trie: TrieNode,
): string[] {
  return candidates.filter((t) => stepIdentStream(state, t, trie).allowed);
}

/**
 * Build a prompt-time allowlist of next chars for an open identifier.
 */
export function dynamicAllowedNextChars(
  state: IdentStreamState,
  trie: TrieNode | null | undefined,
): string[] | null {
  return allowedChars(state, trie);
}

/**
 * Attach a best-effort dynamic filter to prompt options when the binding
 * supports `onToken` / `customSampler`.
 */
export function attachDynamicIdentFilter(
  promptOpts: Record<string, unknown>,
  trie: TrieNode | null | undefined,
  capabilities: { onTokenCallback?: boolean; customSampler?: boolean },
): { attached: boolean; method: 'onToken' | 'customSampler' | 'none'; state: IdentStreamState } {
  const state = createIdentStreamState();
  if (!trie) return { attached: false, method: 'none', state };

  if (capabilities.onTokenCallback) {
    let stream = createIdentStreamState();
    promptOpts.onToken = (tokenText: string) => {
      const step = stepIdentStream(stream, tokenText, trie);
      if (!step.allowed) return false;
      stream = step.next;
      return true;
    };
    return { attached: true, method: 'onToken', state: stream };
  }

  if (capabilities.customSampler) {
    let stream = createIdentStreamState();
    promptOpts.customSampler = {
      accept: (tokenText: string) => {
        const step = stepIdentStream(stream, tokenText, trie);
        if (!step.allowed) return false;
        stream = step.next;
        return true;
      },
    };
    return { attached: true, method: 'customSampler', state: stream };
  }

  return { attached: false, method: 'none', state };
}
