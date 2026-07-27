/**
 * Identifier enforcement before apply (Approach B / B3).
 *
 * Annotation after generation is not enough: patches that invent symbols must
 * not write. This module scans PatchIR and free-text edits against the graph
 * trie and blocks apply when unknown identifiers appear in replacement bodies.
 *
 * Allowances (so ordinary local edits are not blocked):
 * - Identifiers already present in the target file (or the search string)
 * - Tokens that only appear inside comments / string literals (code-only scan)
 */

import { extractIdentifiers, scanIdentifiersAgainstTrie } from '../runtime/identifier-mask.js';
import type { TrieNode } from '../runtime/identifier-trie.js';
import type { PatchIR, PatchOperation } from './patch-ir.js';

export interface IdentifierEnforceResult {
  ok: boolean;
  /** Unknown identifiers that blocked the change. */
  unknown: string[];
  /** Human message for the model / tool result. */
  reason?: string;
}

export interface EnforceIdentifiersOptions {
  /**
   * Identifiers already in the edited file / search string — reusing them is
   * not "inventing" a symbol (covers locals, params, existing helpers).
   */
  allow?: Iterable<string>;
  /**
   * When true (default), strip comments and string/template literals before
   * scanning so doc comments do not trip invent-checks.
   */
  codeOnly?: boolean;
}

/**
 * Approximate strip of comments and string-like spans so invent-checks focus
 * on executable code. Conservative: better to under-scan than block prose.
 */
export function stripNonCodeSpans(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(^|[^:])#[^\n]*/gm, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ');
}

/**
 * Scan free-text for identifiers not present in the trie.
 * Empty trie / no text → ok.
 */
export function enforceIdentifiersInText(
  text: string | null | undefined,
  trie: TrieNode | null | undefined,
  options: EnforceIdentifiersOptions = {},
): IdentifierEnforceResult {
  if (!trie || text == null || text === '') return { ok: true, unknown: [] };
  const codeOnly = options.codeOnly !== false;
  const scanned = codeOnly ? stripNonCodeSpans(text) : text;
  const scan = scanIdentifiersAgainstTrie(scanned, trie);
  const allow = new Set(options.allow ?? []);
  const unknown = scan.unknown.filter((id) => !allow.has(id));
  if (unknown.length === 0) return { ok: true, unknown: [] };
  return {
    ok: false,
    unknown,
    reason:
      `blocked: ${unknown.length} identifier(s) not in the code graph: ${unknown.slice(0, 16).join(', ')}` +
      `${unknown.length > 16 ? '…' : ''}. Use only symbols from inspect_task / the graph, or add them before inventing names.`,
  };
}

/** Extract replacement/content bodies from a PatchIR. */
export function patchBodies(patch: PatchIR): string[] {
  const out: string[] = [];
  for (const op of patch.operations) {
    const body = bodyFromOp(op);
    if (body) out.push(body);
  }
  return out;
}

function bodyFromOp(op: PatchOperation): string | null {
  switch (op.op) {
    case 'replace-range':
      return op.replacement;
    case 'replace-text':
      return op.replace;
    case 'create-file':
      return op.content;
    case 'replace-symbol':
      return op.replacement;
    case 'delete-file':
      return null;
    default:
      return null;
  }
}

function fileFromOp(op: PatchOperation): string | null {
  if ('file' in op && typeof op.file === 'string') return op.file;
  return null;
}

export interface EnforcePatchOptions extends EnforceIdentifiersOptions {
  /** Read current file text so existing identifiers are allowlisted. */
  readFile?: (path: string) => string | null;
}

/**
 * Enforce identifiers across all patch bodies. Fails if any body introduces
 * unknown identifiers (relative to the pre-change graph trie + existing file).
 */
export function enforceIdentifiersInPatch(
  patch: PatchIR,
  trie: TrieNode | null | undefined,
  options: EnforcePatchOptions = {},
): IdentifierEnforceResult {
  if (!trie) return { ok: true, unknown: [] };
  const unknown = new Set<string>();
  for (const op of patch.operations) {
    const body = bodyFromOp(op);
    if (!body) continue;
    const allow = new Set<string>(options.allow ?? []);
    const file = fileFromOp(op);
    if (file && options.readFile) {
      const existing = options.readFile(file);
      if (existing) {
        for (const id of extractIdentifiers(existing)) allow.add(id);
      }
    }
    if (op.op === 'replace-text' && typeof op.search === 'string') {
      for (const id of extractIdentifiers(op.search)) allow.add(id);
    }
    const r = enforceIdentifiersInText(body, trie, { ...options, allow });
    for (const u of r.unknown) unknown.add(u);
  }
  if (unknown.size === 0) return { ok: true, unknown: [] };
  const list = [...unknown].sort();
  return {
    ok: false,
    unknown: list,
    reason:
      `blocked apply_patch: ${list.length} identifier(s) not in the code graph: ${list.slice(0, 16).join(', ')}` +
      `${list.length > 16 ? '…' : ''}. Do not invent symbols — use graph names only.`,
  };
}

/** For tests / diagnostics: count extracted identifiers. */
export function countIdentifiers(text: string): number {
  return extractIdentifiers(text).length;
}
