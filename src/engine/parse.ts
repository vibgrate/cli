import { Query, type Node, type Language } from 'web-tree-sitter';
import { parserFor, loadLanguage } from './grammars.js';
import { langById } from './languages.js';
import { queriesFor, type DefRule } from './queries.js';
import { hashString } from './hash.js';
import type { FileParse, RawCall, RawDef, RawGuard, RawHeritage, RawImport } from './types.js';

/**
 * Parse a single file's source into the raw symbol/edge tables. Pure and
 * deterministic: identical (lang, source) → identical FileParse. Cross-file
 * resolution is a later stage (resolve.ts); here we only see one file.
 */

// Compiled queries are cached per (lang, querySource) — compilation is the
// expensive part and queries are reused across every file of a language.
const compiledCache = new Map<string, Query | null>();

function compile(lang: Language, langId: string, source: string): Query | null {
  const key = `${langId}::${source}`;
  if (compiledCache.has(key)) return compiledCache.get(key) ?? null;
  let q: Query | null = null;
  try {
    q = new Query(lang, source);
  } catch {
    q = null; // grammar doesn't support this pattern — skip it gracefully
  }
  compiledCache.set(key, q);
  return q;
}

function namedCapture(
  captures: { name: string; node: Node }[],
  name: string,
): Node | undefined {
  return captures.find((c) => c.name === name)?.node;
}

function signatureOf(source: string, def: Node, langId: string): string {
  // The text up to the body opening, single-lined, bounded — a deterministic,
  // human-meaningful signature without dragging in the whole body.
  //  - Brace languages: cut at the body `{`.
  //  - Python: cut at the def-terminating `:` at bracket-depth 0 (so a `:` inside
  //    typed params / generics / the `-> Dict[...]` return type doesn't cut it,
  //    and the docstring/body is excluded).
  //  - Ruby: the header is the first line.
  const full = source.slice(def.startIndex, def.endIndex);
  let head: string;
  if (langId === 'py') head = pythonHeader(full);
  else if (langId === 'rb') head = full.split('\n')[0];
  else {
    const braceIdx = full.indexOf('{');
    head = braceIdx >= 0 ? full.slice(0, braceIdx) : full.split('\n')[0];
  }
  head = head.replace(/\s+/g, ' ').trim().replace(/[:{]\s*$/, '').trim();
  return head.length > 200 ? `${head.slice(0, 197)}...` : head;
}

/**
 * A short doc summary for a definition — the leading doc-comment (JSDoc/TSDoc,
 * `//`, `///`, `#`) directly above it, or (Python) the body docstring. Gives a
 * tersely-named symbol real prose for semantic search. Deterministic, marker-
 * stripped, whitespace-collapsed, truncated; never the full body. Returns
 * undefined when there is no doc.
 */
function docOf(source: string, def: Node, langId: string): string | undefined {
  const lines = source.split('\n');
  if (langId === 'py') return pythonDocstring(lines, def.startPosition.row);
  return leadingComment(lines, def.startPosition.row);
}

/** Contiguous comment lines directly above `row` (0-based), markers stripped. */
function leadingComment(lines: string[], row: number): string | undefined {
  const collected: string[] = [];
  for (let r = row - 1; r >= 0; r--) {
    const line = lines[r].trim();
    if (line === '') break; // a blank line detaches the comment
    if (/^(\/\/|\/\*\*?|\*\/?|#|;|--)/.test(line)) collected.unshift(line);
    else break;
  }
  if (!collected.length) return undefined;
  const text = collected
    .join('\n')
    .replace(/\/\*\*?|\*\//g, ' ') // /** and */
    .replace(/^\s*[*]\s?/gm, ' ') // leading * in block comments
    .replace(/^\s*(\/\/+|#+|;+|--)\s?/gm, ' ') // line-comment markers
    .replace(/@\w+/g, ' '); // drop JSDoc tags (@param, @returns…)
  return clip(text);
}

/** The first string literal in a Python body (the docstring), if present. */
function pythonDocstring(lines: string[], row: number): string | undefined {
  // Find the header's terminating line (ends with ':'), then the first non-blank line.
  let r = row;
  while (r < lines.length && !/:\s*(#.*)?$/.test(lines[r])) r++;
  let j = r + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const first = lines[j]?.trim() ?? '';
  const m = /^[rubfRUBF]{0,2}("""|''')/.exec(first);
  if (!m) return undefined;
  const q = m[1];
  let rest = first.slice(first.indexOf(q) + 3);
  if (rest.includes(q)) return clip(rest.slice(0, rest.indexOf(q))); // single-line docstring
  const parts = [rest];
  for (let k = j + 1; k < lines.length; k++) {
    const idx = lines[k].indexOf(q);
    if (idx >= 0) {
      parts.push(lines[k].slice(0, idx));
      break;
    }
    parts.push(lines[k]);
  }
  return clip(parts.join(' '));
}

function clip(s: string): string | undefined {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
}

/** Python def/class header up to the terminating `:` at bracket-depth 0. */
function pythonHeader(full: string): string {
  let depth = 0;
  for (let i = 0; i < full.length; i++) {
    const c = full[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) return full.slice(0, i);
  }
  return full.split('\n')[0];
}

export async function parseSource(
  rel: string,
  langId: string,
  source: string,
): Promise<FileParse> {
  const def = langById(langId);
  const langQueries = queriesFor(langId);
  const hash = hashString(source);
  const result: FileParse = {
    rel,
    lang: langId,
    hash,
    bytes: Buffer.byteLength(source, 'utf8'),
    defs: [],
    calls: [],
    imports: [],
    heritage: [],
    guards: [],
  };
  if (!def || !langQueries) return result;

  const language = await loadLanguage(langId);
  const parser = await parserFor(def);
  const tree = parser.parse(source);
  if (!tree) return result;
  const root = tree.rootNode;

  // --- definitions ---
  const rawDefs: (RawDef & { _start: number; _end: number })[] = [];
  for (const rule of langQueries.defs) {
    collectDefs(language, langId, source, root, rule, rawDefs);
  }
  // Dedupe definitions that overlap on the same name+range (multiple rules can
  // match the same node, e.g. abstract vs plain class).
  const seen = new Set<string>();
  const deduped = rawDefs.filter((d) => {
    const key = `${d._start}:${d._end}:${d.name}:${d.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Compute dotted qualified names by nesting (smallest enclosing def is parent).
  const byStart = [...deduped].sort((a, b) => a._start - b._start || b._end - a._end);
  for (const d of byStart) {
    const parent = enclosing(byStart, d._start, d._end);
    d.qualifiedName = parent ? `${parent.qualifiedName}.${d.name}` : d.name;
  }
  result.defs = byStart
    .map((d) => {
      const { _start, _end, ...rest } = d;
      void _start;
      void _end;
      return rest;
    })
    .sort(
      (a, b) =>
        a.startLine - b.startLine ||
        a.qualifiedName.localeCompare(b.qualifiedName) ||
        a.name.localeCompare(b.name),
    );

  // --- calls ---
  const calls: RawCall[] = [];
  for (const qsrc of langQueries.calls) {
    const q = compile(language, langId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'callee') continue;
      calls.push({
        callee: cap.node.text,
        byte: cap.node.startIndex,
        line: cap.node.startPosition.row + 1,
      });
    }
  }
  result.calls = calls.sort((a, b) => a.byte - b.byte || a.callee.localeCompare(b.callee));

  // --- imports ---
  const imports: RawImport[] = [];
  for (const qsrc of langQueries.imports) {
    const q = compile(language, langId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'source') continue;
      imports.push({ source: stripQuotes(cap.node.text) });
    }
  }
  result.imports = dedupeImports(imports);

  // --- heritage (extends / implements) ---
  const heritage: RawHeritage[] = [];
  for (const qsrc of langQueries.heritage) {
    const q = compile(language, langId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'extends' && cap.name !== 'implements') continue;
      heritage.push({ superName: cap.node.text, byte: cap.node.startIndex, kind: cap.name });
    }
  }
  result.heritage = heritage.sort(
    (a, b) =>
      a.byte - b.byte || a.kind.localeCompare(b.kind) || a.superName.localeCompare(b.superName),
  );

  // --- guards (assert-like expressions → invariant facts) ---
  const guards: RawGuard[] = [];
  for (const qsrc of langQueries.guards ?? []) {
    const q = compile(language, langId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'guard') continue;
      const expr = cap.node.text.replace(/\s+/g, ' ').trim();
      guards.push({ expr: expr.length > 160 ? `${expr.slice(0, 157)}...` : expr, line: cap.node.startPosition.row + 1 });
    }
  }
  result.guards = guards.sort((a, b) => a.line - b.line || a.expr.localeCompare(b.expr));

  tree.delete();
  return result;
}

function collectDefs(
  language: Language,
  langId: string,
  source: string,
  root: Node,
  rule: DefRule,
  out: (RawDef & { _start: number; _end: number })[],
): void {
  const q = compile(language, langId, rule.query);
  if (!q) return;
  for (const match of q.matches(root)) {
    const defNode = namedCapture(match.captures, 'def');
    const nameNode = namedCapture(match.captures, 'name');
    if (!defNode || !nameNode) continue;
    out.push({
      kind: rule.kind,
      name: nameNode.text,
      qualifiedName: nameNode.text, // refined after nesting is computed
      startLine: defNode.startPosition.row + 1,
      endLine: defNode.endPosition.row + 1,
      startByte: defNode.startIndex,
      endByte: defNode.endIndex,
      signature:
        rule.kind === 'function' || rule.kind === 'method'
          ? signatureOf(source, defNode, langId)
          : undefined,
      doc: docOf(source, defNode, langId),
      visibility: undefined,
      _start: defNode.startIndex,
      _end: defNode.endIndex,
    });
  }
}

/** The smallest def strictly containing [start,end) other than itself. */
function enclosing(
  defs: { qualifiedName: string; _start: number; _end: number }[],
  start: number,
  end: number,
): { qualifiedName: string } | undefined {
  let best: { qualifiedName: string; _start: number; _end: number } | undefined;
  for (const d of defs) {
    if (d._start === start && d._end === end) continue;
    if (d._start <= start && d._end >= end) {
      if (!best || d._end - d._start < best._end - best._start) best = d;
    }
  }
  return best;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function dedupeImports(imports: RawImport[]): RawImport[] {
  const seen = new Set<string>();
  const out: RawImport[] = [];
  for (const i of imports.sort((a, b) => a.source.localeCompare(b.source))) {
    if (seen.has(i.source)) continue;
    seen.add(i.source);
    out.push(i);
  }
  return out;
}
