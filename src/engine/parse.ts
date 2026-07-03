import { Query, type Node, type Language } from 'web-tree-sitter';
import { parserFor, loadLanguage } from './grammars.js';
import { langById } from './languages.js';
import { queriesFor, type DefRule } from './queries.js';
import { hashString } from './hash.js';
import { redactSecrets } from '../core-open/utils/redact.js';
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

/**
 * Wrapper node types that sit between a *qualified* callee identifier and the
 * call node (`obj.foo()` / `pkg::foo()` / `recv.foo()` across the grammars).
 * A bare call's identifier hangs directly off the call node instead.
 */
const MEMBER_PARENT_TYPES = new Set([
  'member_expression', // ts/js: obj.foo()
  'attribute', // python: obj.foo()
  'selector_expression', // go: pkg.Foo()
  'field_expression', // rust/scala/c/cpp/zig: recv.foo()
  'scoped_identifier', // rust: Type::foo()
  'member_access_expression', // c#: obj.Foo()
  'qualified_identifier', // c++: ns::f(), Type::m()
  'dot', // elixir: Mod.fun()
  'navigation_suffix', // kotlin/swift: recv.foo()
  'member_call_expression', // php: $x->m()
  'nullsafe_member_call_expression', // php: $x?->m()
  'scoped_call_expression', // php: X::m()
  'unconditional_assignable_selector', // dart: x.foo()
  'conditional_assignable_selector', // dart: x?.foo()
  'cascade_selector', // dart: x..foo()
]);

/**
 * Was this callee identifier part of a qualified call (`x.foo()`) rather than a
 * bare one (`foo()`)? The queries capture only the trailing name, so the
 * resolver needs this bit to know a same-file def with the same short name is
 * NOT evidence — the receiver points elsewhere (see resolve.ts).
 */
function isQualifiedCallee(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (MEMBER_PARENT_TYPES.has(parent.type)) return true;
  // Java `method_invocation` and Ruby `call` keep receiver and name on the call
  // node itself — qualified iff the receiver/object field is present.
  if (parent.type === 'method_invocation') return parent.childForFieldName('object') != null;
  // Ruby `call` carries a `receiver` field when qualified; Python's `call` has
  // no such field (its qualified form is the `attribute` wrapper above), and
  // Elixir's `call` has none either (its qualified form is the `dot` wrapper).
  if (parent.type === 'call') return parent.childForFieldName('receiver') != null;
  // Lua wraps every callee in `variable`; qualified iff a `table` receiver exists
  // (`repo.fetch()` / `repo:method()` carry table:, bare `foo()` has only name:).
  if (parent.type === 'variable') return parent.childForFieldName('table') != null;
  return false;
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
  // Ruby/Elixir: `do…end` bodies (and Elixir `%{}` default args would break a
  // brace cut) — the header is the first line.
  else if (langId === 'rb' || langId === 'ex') head = full.split('\n')[0];
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
function scrubbedDoc(source: string, def: Node, langId: string): string | undefined {
  const doc = docOf(source, def, langId);
  return doc === undefined ? undefined : redactSecrets(doc);
}

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
  // A definition's own name node must never double as a call site: in
  // expression-based grammars (Elixir) a `def foo(…)` head is itself a `call`
  // node, which would fabricate a recursion edge for every definition.
  const defNameBytes = new Set<number>();
  for (const qsrc of langQueries.defs) {
    const q = compile(language, langId, qsrc.query);
    if (!q) continue;
    for (const m of q.matches(root)) {
      const nameNode = namedCapture(m.captures, 'name');
      if (nameNode) defNameBytes.add(nameNode.startIndex);
    }
  }
  const calls: RawCall[] = [];
  for (const qsrc of langQueries.calls) {
    const q = compile(language, langId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'callee') continue;
      if (defNameBytes.has(cap.node.startIndex)) continue;
      calls.push({
        callee: cap.node.text,
        byte: cap.node.startIndex,
        line: cap.node.startPosition.row + 1,
        qualified: isQualifiedCallee(cap.node),
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

/**
 * Dart splits a function into sibling signature + body nodes (and wraps class
 * methods in a method_signature). Return the trailing function_body so the def
 * span covers it — otherwise calls inside the body attribute to the file and
 * nested defs do not nest.
 */
function dartBodyOf(defNode: Node): Node | null {
  if (!defNode.type.endsWith('_signature')) return null;
  if (defNode.nextNamedSibling?.type === 'function_body') return defNode.nextNamedSibling;
  const wrapper = defNode.parent;
  if (wrapper?.type === 'method_signature' && wrapper.nextNamedSibling?.type === 'function_body') {
    return wrapper.nextNamedSibling;
  }
  return null;
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
    // Dart splits a function into sibling signature + body nodes; the def span
    // must cover the body or calls inside it would attribute to the file, and
    // nested defs would not nest.
    const spanEnd = dartBodyOf(defNode) ?? defNode;
    out.push({
      kind: rule.kind,
      name: nameNode.text,
      qualifiedName: nameNode.text, // refined after nesting is computed
      startLine: defNode.startPosition.row + 1,
      endLine: spanEnd.endPosition.row + 1,
      startByte: defNode.startIndex,
      endByte: spanEnd.endIndex,
      signature:
        rule.kind === 'function' || rule.kind === 'method'
          ? redactSecrets(signatureOf(source, defNode, langId))
          : undefined,
      // GUARDRAILS §1: signatures/docs are lifted verbatim from source and are
      // persisted (graph.json, `vg share` commits it) — scrub at ingest.
      doc: scrubbedDoc(source, defNode, langId),
      visibility: undefined,
      _start: defNode.startIndex,
      _end: spanEnd.endIndex,
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
