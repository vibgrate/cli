import { Query, type Node, type Language } from 'web-tree-sitter';
import { parserFor, loadLanguage } from './grammars.js';
import { langById } from './languages.js';
import { queriesFor, type DefRule } from './queries.js';
import { extractEmbeddedScript } from './sfc.js';
import { hashString } from './hash.js';
import { redactSecrets } from '../core-open/utils/redact.js';
import { extractAstRolesFromTree } from './ast-roles.js';
import { scanEffects } from './effects.js';
import { extractDutiesWithCandidates, fileBindings, type Bindings } from './duties.js';
import type { FileParse, RawCall, RawDef, RawGuard, RawHeritage, RawImport, RawTypeRef } from './types.js';

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
const CALLABLE_DEF_KINDS = new Set(['function', 'method', 'route', 'job', 'component', 'test']);

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
  'value_identifier_path', // rescript: Mod.foo() (only exists for qualified calls)
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
  // OCaml wraps every callee in `value_path`; qualified iff a module path is
  // present (`Mod.f x` has two named children, bare `f x` has one).
  if (parent.type === 'value_path') return parent.namedChildCount > 1;
  // ObjC message sends: `[obj doThing]` points elsewhere, but `[self …]` /
  // `[super …]` stay within the class — same-file evidence still counts there.
  if (parent.type === 'message_expression') {
    const recv = parent.childForFieldName('receiver');
    return recv != null && recv.text !== 'self' && recv.text !== 'super';
  }
  return false;
}

/**
 * Python decorators above a `def` (`@router.post("/login")`), which tree-sitter
 * keeps outside the function node in a `decorated_definition`. Other grammars
 * put annotations / attributes / decorators inside the definition, where
 * `signatureOf` already sees them. Single-lined, bounded; undefined when none.
 */
function decoratorsOf(def: Node, langId: string): string | undefined {
  if (langId !== 'py' || def.parent?.type !== 'decorated_definition') return undefined;
  const parts: string[] = [];
  for (const c of def.parent.namedChildren) if (c && c.type === 'decorator') parts.push(c.text.replace(/\s+/g, ' ').trim());
  if (!parts.length) return undefined;
  const joined = redactSecrets(parts.join(' '));
  return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
}

/** Declaration node types that a brace language allows without a body. */
const ABSTRACTABLE_DEF = new Set(['method_declaration', 'constructor_declaration', 'function_declaration', 'function_definition']);
const BRACE_BODY_LANGS = new Set(['java', 'cs', 'kt', 'ts', 'tsx', 'js', 'jsx', 'go', 'rust', 'scala', 'swift', 'php', 'cpp', 'c']);

/** False for an interface / abstract method in a brace language (no `body` child). */
function hasBody(def: Node, langId: string): boolean {
  if (!BRACE_BODY_LANGS.has(langId) || !ABSTRACTABLE_DEF.has(def.type)) return true;
  return def.childForFieldName('body') != null;
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
  // Pure extractors (no tree-sitter) — SQL DDL topology.
  if (langId === 'sql') {
    const { parseSqlFile } = await import('./sql-extract.js');
    return parseSqlFile(rel, source);
  }

  // Container formats (Vue/Svelte/Astro SFCs): parse the embedded script
  // region with the JS/TS grammar over a position-preserving mask, so every
  // offset/line below refers to the original file. The node keeps the
  // container's own lang id.
  const embedded = extractEmbeddedScript(langId, source);
  const effLangId = embedded?.langId ?? langId;
  const text = embedded?.masked ?? source;
  const def = langById(effLangId);
  const langQueries = queriesFor(effLangId);
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
    typeRefs: [],
    guards: [],
  };
  if (!def || !langQueries) return result;

  const language = await loadLanguage(effLangId);
  const parser = await parserFor(def);
  const tree = parser.parse(text);
  if (!tree) return result;
  const root = tree.rootNode;

  // --- definitions ---
  const rawDefs: (RawDef & { _start: number; _end: number; _node: Node })[] = [];
  for (const rule of langQueries.defs) {
    collectDefs(language, effLangId, text, root, rule, rawDefs);
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
      const { _start, _end, _node, ...rest } = d;
      void _start;
      void _end;
      void _node;
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
    const q = compile(language, effLangId, qsrc.query);
    if (!q) continue;
    for (const m of q.matches(root)) {
      const nameNode = namedCapture(m.captures, 'name');
      if (nameNode) defNameBytes.add(nameNode.startIndex);
    }
  }
  const calls: RawCall[] = [];
  const calleeCaptures: Node[] = [];
  for (const qsrc of langQueries.calls) {
    const q = compile(language, effLangId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'callee') continue;
      if (defNameBytes.has(cap.node.startIndex)) continue;
      calleeCaptures.push(cap.node);
      calls.push({
        callee: cap.node.text,
        byte: cap.node.startIndex,
        line: cap.node.startPosition.row + 1,
        qualified: isQualifiedCallee(cap.node),
      });
    }
  }
  result.calls = calls.sort((a, b) => a.byte - b.byte || a.callee.localeCompare(b.callee));

  // --- duties (what each callable's body would do, statement by statement) ---
  // Each callee capture is attributed to the smallest enclosing definition,
  // the same rule resolve.ts uses for call edges, so a lambda's calls do not
  // double as its parent's.
  const calleeNodesByDef = new Map<number, Node[]>();
  for (const cap of calleeCaptures) {
    let owner: (typeof byStart)[number] | undefined;
    for (const d of byStart) {
      if (d._start <= cap.startIndex && d._end >= cap.endIndex && (!owner || d._end - d._start < owner._end - owner._start)) owner = d;
    }
    if (!owner) continue;
    const key = owner._start;
    let list = calleeNodesByDef.get(key);
    if (!list) {
      list = [];
      calleeNodesByDef.set(key, list);
    }
    list.push(cap);
  }
  if (calleeNodesByDef.size) {
    const bindings: Bindings = fileBindings(text, effLangId);
    const uniqueByName = new Map<string, string | null>();
    for (const d of byStart) uniqueByName.set(d.name, uniqueByName.has(d.name) ? null : d.qualifiedName);
    const calleeOf = (n: Node): string | undefined => uniqueByName.get(n.text) ?? undefined;
    for (const d of byStart) {
      if (!CALLABLE_DEF_KINDS.has(d.kind)) continue;
      const callees = calleeNodesByDef.get(d._start);
      if (!callees?.length) continue;
      const { duties, candidates } = extractDutiesWithCandidates({ def: d._node, callees, text, langId: effLangId, bindings, calleeOf });
      if (duties || candidates) {
        const target = result.defs.find((r) => r.qualifiedName === d.qualifiedName && r.startLine === d.startLine);
        if (target) {
          if (duties) target.duties = duties;
          if (candidates) target.dutyCandidates = candidates;
        }
      }
    }
  }

  // --- imports ---
  const imports: RawImport[] = [];
  for (const qsrc of langQueries.imports) {
    const q = compile(language, effLangId, qsrc);
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
    const q = compile(language, effLangId, qsrc);
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

  // --- type references (constructor-param / field types → DI dependency edges) ---
  const typeRefs: RawTypeRef[] = [];
  for (const qsrc of langQueries.typeRefs ?? []) {
    const q = compile(language, effLangId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'typeref') continue;
      typeRefs.push({ name: cap.node.text, byte: cap.node.startIndex });
    }
  }
  result.typeRefs = typeRefs.sort((a, b) => a.byte - b.byte || a.name.localeCompare(b.name));

  // --- namespaces declared by this file (C# cross-namespace resolution) ---
  const namespaces = new Set<string>();
  for (const qsrc of langQueries.namespaces ?? []) {
    const q = compile(language, effLangId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'namespace') continue;
      const name = cap.node.text.trim();
      if (name) namespaces.add(name);
    }
  }
  if (namespaces.size) result.namespaces = [...namespaces].sort();

  // --- guards (assert-like expressions → invariant facts) ---
  const guards: RawGuard[] = [];
  for (const qsrc of langQueries.guards ?? []) {
    const q = compile(language, effLangId, qsrc);
    if (!q) continue;
    for (const cap of q.captures(root)) {
      if (cap.name !== 'guard') continue;
      const expr = cap.node.text.replace(/\s+/g, ' ').trim();
      guards.push({ expr: expr.length > 160 ? `${expr.slice(0, 157)}...` : expr, line: cap.node.startPosition.row + 1 });
    }
  }
  result.guards = guards.sort((a, b) => a.line - b.line || a.expr.localeCompare(b.expr));

  const roles = extractAstRolesFromTree(rel, effLangId, language, root, text);
  if (roles) result.roles = roles;

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
  out: (RawDef & { _start: number; _end: number; _node: Node })[],
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
      decorators: rule.kind === 'function' || rule.kind === 'method' ? decoratorsOf(defNode, langId) : undefined,
      visibility: undefined,
      // Body effects — what the callable executes — for the architecture
      // classifier. Counts only; no source text leaves this function.
      // A declaration without a body (an interface or abstract method) has
      // nothing to scan: no effects at all, so the classifier does not read
      // "no sites" as a contradiction of what the name says.
      effects:
        (rule.kind === 'function' || rule.kind === 'method' || rule.kind === 'route' || rule.kind === 'job' || rule.kind === 'component' || rule.kind === 'test') && hasBody(defNode, langId)
          ? scanEffects(source.slice(defNode.startIndex, spanEnd.endIndex), langId)
          : undefined,
      _start: defNode.startIndex,
      _end: spanEnd.endIndex,
      _node: defNode,
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
