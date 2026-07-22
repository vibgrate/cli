/**
 * The deterministic fast-apply merge engine (VG-CLI-CODE §4).
 *
 * Speed in the fast coding tools comes from letting the planner emit a *terse*
 * edit instead of rewriting a whole file; correctness comes from applying that
 * edit **deterministically and scoped**, never by letting the model free-hand
 * the merge. This module is that deterministic floor: it parses the
 * search/replace edit form and applies it with three escalating match
 * strategies — exact, whitespace-flexible, then graph-span-scoped — so an
 * ambiguous SEARCH is resolved to the symbol the planner actually named rather
 * than the first textual hit. No model is required to apply an edit; a hosted
 * fast-apply model is only ever an *acceleration* over this same contract.
 *
 * Everything here is pure and deterministic: identical (content, edit) always
 * yields the identical outcome, which is what makes it unit- and
 * benchmark-testable offline.
 */

import type { CodeEdit, EditOutcome } from './types.js';

/** A symbol span the graph knows about, used to disambiguate a SEARCH match. */
export interface SymbolSpan {
  /** Qualified name, matched against `anchorSymbol`. */
  qualifiedName: string;
  file: string;
  /** 1-based inclusive line range. */
  start: number;
  end: number;
}

/**
 * Parse a model's reply into structured edits. The accepted form is the
 * widely-supported search/replace block (robust to surrounding prose and code
 * fences), plus explicit whole-file create/delete markers:
 *
 * ```
 * path/to/file.ts
 * <<<<<<< SEARCH
 * old code
 * =======
 * new code
 * >>>>>>> REPLACE
 * ```
 *
 * `CREATE path/to/new.ts` … `END CREATE` wraps a new file's whole body;
 * `DELETE path/to/gone.ts` removes a file. Parsing is forgiving of blank lines
 * and fences but strict about the block markers, so a malformed block surfaces
 * as an `invalid` outcome at apply time rather than silently corrupting a file.
 */
export function parseEdits(text: string): CodeEdit[] {
  const edits: CodeEdit[] = [];
  const lines = text.split('\n');
  let i = 0;
  let pendingFile = '';

  const isFence = (s: string): boolean => /^\s*```/.test(s);

  while (i < lines.length) {
    const line = lines[i];

    // Whole-file create: `CREATE <path>` … `END CREATE`.
    const create = /^\s*CREATE\s+(\S.*?)\s*$/.exec(line);
    if (create) {
      const file = create[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*END CREATE\s*$/.test(lines[i])) {
        if (!isFence(lines[i])) body.push(lines[i]);
        i++;
      }
      i++; // consume END CREATE
      edits.push({ op: 'create', file, content: body.join('\n') });
      pendingFile = '';
      continue;
    }

    // Whole-file delete: `DELETE <path>`.
    const del = /^\s*DELETE\s+(\S.*?)\s*$/.exec(line);
    if (del) {
      edits.push({ op: 'delete', file: del[1] });
      i++;
      pendingFile = '';
      continue;
    }

    // Search/replace block. The file path is the most recent non-fence,
    // non-blank line before the SEARCH marker (or an inline `path` on it).
    if (/^\s*<{5,}\s*SEARCH/.test(line)) {
      const file = pendingFile;
      const search: string[] = [];
      const replace: string[] = [];
      i++;
      while (i < lines.length && !/^\s*={5,}\s*$/.test(lines[i])) {
        search.push(lines[i]);
        i++;
      }
      i++; // consume =======
      while (i < lines.length && !/^\s*>{5,}\s*REPLACE/.test(lines[i])) {
        replace.push(lines[i]);
        i++;
      }
      i++; // consume >>>>>>> REPLACE
      edits.push({
        op: 'replace',
        file,
        search: search.join('\n'),
        replace: replace.join('\n'),
        anchorSymbol: undefined,
      });
      continue;
    }

    // Track the most recent file-path candidate: a lone token that looks like a
    // path (has a slash or a file extension) and isn't a fence/marker.
    const trimmed = line.trim();
    if (trimmed && !isFence(line) && looksLikePath(trimmed)) pendingFile = trimmed.replace(/[:`]+$/, '');
    i++;
  }

  return edits;
}

function looksLikePath(s: string): boolean {
  if (/\s/.test(s.replace(/:$/, ''))) return false; // paths don't contain spaces
  return /\//.test(s) || /\.[A-Za-z0-9]{1,8}:?$/.test(s);
}

/**
 * Apply a single edit to a file's current content (or `null` when the file does
 * not exist). Pure: returns the new content and an outcome; never touches disk.
 * The `spans` are the graph's symbol spans for this file — when a SEARCH is
 * textually ambiguous, a match inside the `anchorSymbol` span wins, which is how
 * the graph makes a terse edit land where the planner meant it to.
 */
export function applyEdit(
  content: string | null,
  edit: CodeEdit,
  spans: SymbolSpan[] = [],
): { content: string | null; outcome: EditOutcome } {
  if (edit.op === 'create') {
    if (content !== null && content !== edit.content) {
      return { content, outcome: { edit, status: 'conflict', reason: `${edit.file} already exists — refusing to overwrite it with a create; use a replace edit instead` } };
    }
    return { content: edit.content, outcome: { edit, status: content === edit.content ? 'no-op' : 'applied', matchedBy: 'exact' } };
  }

  if (edit.op === 'delete') {
    if (content === null) return { content: null, outcome: { edit, status: 'no-op', reason: `${edit.file} does not exist — nothing to delete` } };
    return { content: null, outcome: { edit, status: 'applied', matchedBy: 'exact' } };
  }

  // op === 'replace'
  if (content === null) {
    return { content: null, outcome: { edit, status: 'not-found', reason: `${edit.file} does not exist — a replace needs an existing file (did you mean CREATE ${edit.file}?)` } };
  }
  if (edit.search === '') {
    // Empty SEARCH means "prepend" only when the file is empty; otherwise it is
    // ambiguous and we refuse rather than guess a location.
    if (content === '') return { content: edit.replace, outcome: { edit, status: 'applied', matchedBy: 'exact' } };
    return { content, outcome: { edit, status: 'invalid', reason: 'empty SEARCH on a non-empty file is ambiguous — quote the exact lines to replace' } };
  }
  if (edit.search === edit.replace) {
    return { content, outcome: { edit, status: 'no-op', reason: 'SEARCH and REPLACE are identical — no change' } };
  }

  const located = locate(content, edit.search, edit.anchorSymbol, spans, edit.file);
  if (located.kind === 'none') {
    return { content, outcome: { edit, status: 'not-found', reason: `the SEARCH text was not found in ${edit.file} — it must match the current file exactly (whitespace-flexible)` } };
  }
  if (located.kind === 'ambiguous') {
    return {
      content,
      outcome: {
        edit,
        status: 'ambiguous',
        reason: `the SEARCH text matches ${located.count} places in ${edit.file} — add more surrounding lines, or name the symbol so the graph can disambiguate`,
      },
    };
  }
  const next = content.slice(0, located.from) + edit.replace + content.slice(located.to);
  return { content: next, outcome: { edit, status: 'applied', matchedBy: located.matchedBy } };
}

/**
 * Apply a set of edits across a set of files. `read(file)` returns current
 * content or `null`. Edits are applied in the order given, threading each
 * file's evolving content so two edits to the same file compose. Returns, per
 * file, its before/after content and the per-edit outcomes — the dry-run
 * product the session turns into diffs. Deterministic given a deterministic
 * `read`.
 */
export function applyEdits(
  edits: CodeEdit[],
  read: (file: string) => string | null,
  spansByFile: (file: string) => SymbolSpan[] = () => [],
): Map<string, { before: string | null; after: string | null; outcomes: EditOutcome[] }> {
  const state = new Map<string, { before: string | null; after: string | null; outcomes: EditOutcome[] }>();
  for (const edit of edits) {
    let entry = state.get(edit.file);
    if (!entry) {
      const before = read(edit.file);
      entry = { before, after: before, outcomes: [] };
      state.set(edit.file, entry);
    }
    const { content, outcome } = applyEdit(entry.after, edit, spansByFile(edit.file));
    entry.after = content;
    entry.outcomes.push(outcome);
  }
  return state;
}

type Located =
  | { kind: 'unique'; from: number; to: number; matchedBy: 'exact' | 'whitespace' | 'graph-span' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

/**
 * Find the SEARCH text in the content. Escalates: (1) exact substring; (2)
 * whitespace-flexible (indentation/trailing-space differences tolerated); and
 * when either is ambiguous, (3) narrow to the `anchorSymbol`'s graph span so the
 * intended occurrence wins. Line-oriented so offsets map back to real edits.
 */
function locate(content: string, search: string, anchor: string | undefined, spans: SymbolSpan[], file: string): Located {
  const exact = allIndexes(content, search);
  if (exact.length === 1) return { kind: 'unique', from: exact[0], to: exact[0] + search.length, matchedBy: 'exact' };
  if (exact.length > 1) {
    const scoped = scopeToAnchor(content, exact.map((from) => ({ from, to: from + search.length })), anchor, spans, file);
    if (scoped) return { ...scoped, matchedBy: 'graph-span' };
    return { kind: 'ambiguous', count: exact.length };
  }

  // Whitespace-flexible: compare with runs of whitespace collapsed and each
  // line trimmed, then map the match back to real character offsets.
  const flex = flexIndexes(content, search);
  if (flex.length === 1) return { kind: 'unique', from: flex[0].from, to: flex[0].to, matchedBy: 'whitespace' };
  if (flex.length > 1) {
    const scoped = scopeToAnchor(content, flex, anchor, spans, file);
    if (scoped) return { ...scoped, matchedBy: 'graph-span' };
    return { kind: 'ambiguous', count: flex.length };
  }
  return { kind: 'none' };
}

/** Every start index of `needle` in `hay` (non-overlapping left-to-right). */
function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/**
 * Whitespace-flexible match: align the search's trimmed non-empty lines against
 * the content's lines, tolerating indentation and trailing-whitespace drift
 * (the single most common reason an otherwise-correct terse edit fails to
 * apply). Returns real character offset ranges for each full-block match.
 */
function flexIndexes(content: string, search: string): { from: number; to: number }[] {
  const cLines = content.split('\n');
  const sLines = search.split('\n');
  // Trim a possible leading/trailing blank line from the search block.
  while (sLines.length && sLines[0].trim() === '') sLines.shift();
  while (sLines.length && sLines[sLines.length - 1].trim() === '') sLines.pop();
  if (sLines.length === 0) return [];
  const sNorm = sLines.map((l) => l.trim());

  // Precompute char offset of the start of each content line.
  const lineStart: number[] = [];
  let acc = 0;
  for (const l of cLines) {
    lineStart.push(acc);
    acc += l.length + 1; // +1 for the '\n'
  }

  const out: { from: number; to: number }[] = [];
  for (let i = 0; i + sNorm.length <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < sNorm.length; j++) {
      if (cLines[i + j].trim() !== sNorm[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const from = lineStart[i];
    const lastLine = i + sNorm.length - 1;
    const to = lineStart[lastLine] + cLines[lastLine].length; // end of the last matched line (exclusive of '\n')
    out.push({ from, to });
  }
  return out;
}

/** If exactly one candidate falls inside the anchor symbol's span, pick it. */
function scopeToAnchor(
  content: string,
  candidates: { from: number; to: number }[],
  anchor: string | undefined,
  spans: SymbolSpan[],
  file: string,
): { kind: 'unique'; from: number; to: number } | null {
  if (!anchor) return null;
  const span = spans.find((s) => s.file === file && s.qualifiedName === anchor);
  if (!span) return null;
  const lineOf = lineIndexer(content);
  const inside = candidates.filter((c) => {
    const line = lineOf(c.from); // 1-based
    return line >= span.start && line <= span.end;
  });
  if (inside.length === 1) return { kind: 'unique', from: inside[0].from, to: inside[0].to };
  return null;
}

/** Returns a function mapping a char offset → 1-based line number. */
function lineIndexer(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    // binary search for the greatest line start <= offset
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
