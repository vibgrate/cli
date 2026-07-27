/**
 * Identifier masking helpers for Approach B sampler integration.
 *
 * Full logit masking needs the llama.cpp binding's token callback. Until that
 * hook is universal across binding versions, we:
 *  1. Expose allowed-next-char sets from the trie (for native mask hooks)
 *  2. Post-validate free-text model output for repo identifiers
 *  3. Optionally rewrite / flag unknown identifiers in code-like spans
 */

import type { TrieNode } from './identifier-trie.js';
import { trieAllowedNextChars, trieHas, trieHasPrefix } from './identifier-trie.js';

/** JS/TS-ish identifier token (conservative). */
const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

/** Tokens we never treat as "must exist in the graph". */
const STOP = new Set([
  'the',
  'and',
  'for',
  'var',
  'let',
  'const',
  'function',
  'class',
  'return',
  'import',
  'export',
  'from',
  'async',
  'await',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'new',
  'typeof',
  'interface',
  'type',
  'string',
  'number',
  'boolean',
  'void',
  'any',
  'unknown',
  'Promise',
  'Array',
  'Object',
  'Error',
  'console',
  'process',
  'require',
  'module',
  'exports',
  'default',
  'extends',
  'implements',
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'if',
  'else',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'finally',
  'throw',
  'with',
  'yield',
  'of',
  'in',
  'as',
  'is',
  'get',
  'set',
]);

export interface IdentifierScanResult {
  /** Identifiers that appear in text and exist in the trie. */
  known: string[];
  /** Identifiers that appear in text but are absent from the trie. */
  unknown: string[];
  /** True when every scanned identifier is known (or stopword). */
  clean: boolean;
}

/** Extract candidate identifiers from model text. */
export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT_RE)) {
    const t = m[0];
    if (STOP.has(t) || STOP.has(t.toLowerCase())) continue;
    out.add(t);
  }
  return [...out].sort();
}

export function scanIdentifiersAgainstTrie(text: string, trie: TrieNode): IdentifierScanResult {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of extractIdentifiers(text)) {
    if (trieHas(trie, id) || trieHasPrefix(trie, id)) known.push(id);
    else unknown.push(id);
  }
  return { known, unknown, clean: unknown.length === 0 };
}

/**
 * Allowed next characters for a partial identifier under the trie — the hook
 * surface for real logit masks when the binding supports custom samplers.
 */
export function maskAllowedNextChars(trie: TrieNode, partialIdent: string): string[] {
  return trieAllowedNextChars(trie, partialIdent);
}

/**
 * Annotate model output when unknown identifiers appear (non-destructive).
 * Returns original text when clean; otherwise appends a short warning block the
 * agent/tools can surface without rewriting the patch body blindly.
 */
export function annotateUnknownIdentifiers(text: string, trie: TrieNode): { text: string; unknown: string[] } {
  const scan = scanIdentifiersAgainstTrie(text, trie);
  if (scan.clean) return { text, unknown: [] };
  const note = `\n\n/* vg: unknown identifiers vs graph (not rewritten): ${scan.unknown.slice(0, 12).join(', ')}${scan.unknown.length > 12 ? '…' : ''} */`;
  return { text: text + note, unknown: scan.unknown };
}
