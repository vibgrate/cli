/**
 * AST-aware source-code compressor.
 *
 * Keeps imports, exports, type declarations, signatures, decorators and the
 * first statements of every function body; long bodies collapse to a
 * `// … N lines omitted` marker. Body budgets are allocated by symbol
 * importance (references, visibility, fan-out, query mentions) against a
 * target compression rate. When the language's tree-sitter grammar is loaded
 * (`prepareCodeCompressor()`), the rewrite is AST-driven and the output is
 * re-parsed — a result that no longer parses is discarded (never serve broken
 * code). Without a loaded grammar a conservative line/brace heuristic runs.
 * `compress()` is synchronous either way.
 */

import type { Node, Parser } from 'web-tree-sitter';
import { parserFor } from '../engine/grammars.js';
import { langById } from '../engine/languages.js';
import { canonicalLanguage, tryDetectCode } from './detect.js';
import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export type DocstringMode = 'full' | 'first_line' | 'remove';

export interface CodeCompressorConfig {
  docstringMode: DocstringMode;
  targetCompressionRate: number;
  maxBodyLines: number;
  minTokensForCompression: number;
  verifySyntax: boolean;
}

export const DEFAULT_CODE_CONFIG: Readonly<CodeCompressorConfig> = { docstringMode: 'first_line', targetCompressionRate: 0.2, maxBodyLines: 5, minTokensForCompression: 100, verifySyntax: true };

// ---------------------------------------------------------------------------
// Language rules
// ---------------------------------------------------------------------------

interface LangRules {
  functions: readonly string[];
  bodies: readonly string[];
  comment: string;
  colon: boolean;
  /** Node types never descended into (re-emitted verbatim). */
  opaque?: readonly string[];
  /** Container types whose children may hold functions. */
  containers: readonly string[];
}

const BRACE_CONTAINERS = ['class_declaration', 'class_body', 'export_statement', 'decorated_definition', 'impl_item', 'declaration_list', 'namespace_declaration', 'namespace_definition', 'program', 'module', 'source_file', 'translation_unit', 'compilation_unit', 'class_specifier', 'field_declaration_list', 'struct_specifier', 'abstract_class_declaration', 'interface_declaration', 'object_declaration', 'companion_object', 'class_definition', 'trait_item', 'mod_item', 'block', 'statement_block', 'lexical_declaration', 'variable_declaration', 'variable_declarator', 'expression_statement', 'assignment_expression', 'pair', 'object', 'method_definition', 'public_field_definition', 'class_static_block'];

const RULES: Readonly<Record<string, LangRules>> = {
  py: { functions: ['function_definition'], bodies: ['block'], comment: '#', colon: true, containers: ['module', 'class_definition', 'decorated_definition', 'block'] },
  js: { functions: ['function_declaration', 'method_definition', 'generator_function_declaration', 'function_expression', 'arrow_function', 'function'], bodies: ['statement_block'], comment: '//', colon: false, containers: BRACE_CONTAINERS },
  ts: { functions: ['function_declaration', 'method_definition', 'generator_function_declaration', 'function_expression', 'arrow_function', 'function'], bodies: ['statement_block'], comment: '//', colon: false, containers: BRACE_CONTAINERS },
  tsx: { functions: ['function_declaration', 'method_definition', 'generator_function_declaration', 'function_expression', 'arrow_function', 'function'], bodies: ['statement_block'], comment: '//', colon: false, containers: BRACE_CONTAINERS },
  go: { functions: ['function_declaration', 'method_declaration', 'func_literal'], bodies: ['block'], comment: '//', colon: false, containers: ['source_file'] },
  rust: { functions: ['function_item'], bodies: ['block'], comment: '//', colon: false, containers: ['source_file', 'impl_item', 'declaration_list', 'mod_item', 'trait_item'] },
  java: { functions: ['method_declaration', 'constructor_declaration'], bodies: ['block', 'constructor_body'], comment: '//', colon: false, containers: ['program', 'class_declaration', 'class_body', 'interface_declaration', 'interface_body', 'enum_declaration', 'enum_body', 'enum_body_declarations'] },
  c: { functions: ['function_definition'], bodies: ['compound_statement'], comment: '//', colon: false, containers: ['translation_unit'] },
  cpp: { functions: ['function_definition'], bodies: ['compound_statement'], comment: '//', colon: false, containers: ['translation_unit', 'class_specifier', 'field_declaration_list', 'struct_specifier', 'namespace_definition', 'declaration_list', 'template_declaration'] },
  cs: { functions: ['method_declaration', 'constructor_declaration', 'destructor_declaration', 'operator_declaration', 'local_function_statement'], bodies: ['block'], comment: '//', colon: false, opaque: ['preproc_if'], containers: ['compilation_unit', 'namespace_declaration', 'file_scoped_namespace_declaration', 'class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration', 'declaration_list'] },
  php: { functions: ['function_definition', 'method_declaration'], bodies: ['compound_statement'], comment: '//', colon: false, containers: ['program', 'class_declaration', 'declaration_list', 'namespace_definition', 'trait_declaration', 'interface_declaration'] },
  rb: { functions: ['method', 'singleton_method'], bodies: ['body_statement'], comment: '#', colon: true, containers: ['program', 'class', 'module', 'body_statement'] },
  kotlin: { functions: ['function_declaration'], bodies: ['function_body'], comment: '//', colon: false, containers: ['source_file', 'class_declaration', 'class_body', 'object_declaration', 'companion_object'] },
  swift: { functions: ['function_declaration', 'init_declaration'], bodies: ['function_body'], comment: '//', colon: false, containers: ['source_file', 'class_declaration', 'class_body', 'protocol_declaration'] },
  scala: { functions: ['function_definition'], bodies: ['block'], comment: '//', colon: false, containers: ['compilation_unit', 'class_definition', 'object_definition', 'template_body', 'trait_definition'] },
  sh: { functions: [], bodies: [], comment: '#', colon: false, opaque: ['if_statement', 'for_statement', 'while_statement', 'until_statement', 'case_statement', 'select_statement', 'function_definition', 'subshell', 'compound_statement'], containers: [] },
};

const CANONICAL_TO_ID: Readonly<Record<string, string>> = { python: 'py', javascript: 'js', typescript: 'ts', go: 'go', rust: 'rust', java: 'java', csharp: 'cs', php: 'php', cpp: 'cpp', c: 'c', ruby: 'rb', kotlin: 'kotlin', swift: 'swift', scala: 'scala', bash: 'sh', lua: 'lua', dart: 'dart', elixir: 'ex', zig: 'zig', objc: 'objc', ocaml: 'ocaml', solidity: 'solidity', rescript: 'rescript', vue: 'vue', svelte: 'svelte', astro: 'astro' };

/** vg language id for a canonical language name / extension / fence tag; undefined when unknown. */
export function languageIdFor(hint?: string): string | undefined {
  const canonical = canonicalLanguage(hint);
  if (!canonical) return undefined;
  const id = CANONICAL_TO_ID[canonical];
  if (id === 'ts' && canonical === 'typescript' && hint && /\.tsx$|^tsx$/i.test(hint.trim())) return 'tsx';
  return id;
}

// ---------------------------------------------------------------------------
// Parser registry (async warm-up, sync use)
// ---------------------------------------------------------------------------

const parsers = new Map<string, Parser>();
const failed = new Set<string>();

export const DEFAULT_WARM_LANGUAGES: readonly string[] = ['ts', 'tsx', 'js', 'py', 'go', 'rust', 'java'];

/** Pre-load tree-sitter parsers so `compress()` can use the AST path. Failures are swallowed (heuristic fallback). */
export async function prepareCodeCompressor(languages: readonly string[] = DEFAULT_WARM_LANGUAGES): Promise<string[]> {
  const loaded: string[] = [];
  for (const raw of languages) {
    const id = langById(raw) ? raw : languageIdFor(raw);
    if (!id || parsers.has(id)) {
      if (id) loaded.push(id);
      continue;
    }
    const def = langById(id);
    if (!def || failed.has(id)) continue;
    try {
      parsers.set(id, await parserFor(def));
      loaded.push(id);
    } catch {
      failed.add(id);
    }
  }
  return loaded;
}

export function isCodeCompressorReady(langId: string): boolean {
  return parsers.has(langId);
}

export function loadedCodeLanguages(): string[] {
  return [...parsers.keys()].sort();
}

/** Test hook: drop loaded parsers. */
export function resetCodeCompressor(): void {
  parsers.clear();
  failed.clear();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function detectIndent(lines: readonly string[]): string {
  for (const l of lines) {
    const m = /^([ \t]+)\S/.exec(l);
    if (m) return m[1].startsWith('\t') ? '\t' : ' '.repeat(Math.min(m[1].length, 8));
  }
  return '  ';
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

export function omittedMarker(indent: string, comment: string, n: number, calls: readonly string[] = []): string {
  const extra = calls.length ? `; calls: ${calls.slice(0, 5).join(', ')}${calls.length > 5 ? ` +${calls.length - 5} more` : ''}` : '';
  return `${indent}${comment} … ${n} lines omitted${extra}`;
}

interface FunctionInfo {
  name: string;
  startRow: number;
  endRow: number;
  bodyStartRow: number;
  bodyEndRow: number;
  bodySize: number;
  statements: Array<{ startRow: number; endRow: number }>;
  calls: string[];
  docstring?: { row: number; endRow: number; text: string };
  score: number;
}

/** min-max normalised symbol importance (3 dp); degenerate → 0.5 for all. */
export function normalizeScores(raw: readonly number[]): number[] {
  if (!raw.length) return [];
  const mn = Math.min(...raw);
  const mx = Math.max(...raw);
  if (mx - mn < 1e-9) return raw.map(() => 0.5);
  return raw.map((r) => Math.round(((r - mn) / (mx - mn)) * 1000) / 1000);
}

/** Per-function body line limits under the target rate; `maxBodyLines` is a hard cap. */
export function allocateBodyBudget(fns: readonly { bodySize: number; score: number }[], totalLines: number, cfg: CodeCompressorConfig): number[] {
  const totalBody = fns.reduce((a, f) => a + f.bodySize, 0);
  const fixed = Math.max(0, totalLines - totalBody);
  const targetTotal = totalLines * cfg.targetCompressionRate;
  const budget = Math.max(0, targetTotal - fixed);
  const weights = fns.map((f) => Math.max(f.score, 0.05) * f.bodySize);
  const totalW = weights.reduce((a, b) => a + b, 0);
  return fns.map((f, i) => {
    const share = totalW > 0 ? (budget * weights[i]) / totalW : fns.length ? budget / fns.length : 0;
    return Math.max(0, Math.min(Math.round(share), f.bodySize, cfg.maxBodyLines));
  });
}

// ---------------------------------------------------------------------------
// AST path
// ---------------------------------------------------------------------------

function nodeName(node: Node): string {
  const n = node.childForFieldName('name');
  if (n) return n.text;
  const parent = node.parent;
  if (parent && (parent.type === 'variable_declarator' || parent.type === 'pair' || parent.type === 'assignment_expression' || parent.type === 'public_field_definition')) {
    const pn = parent.childForFieldName('name') ?? parent.childForFieldName('key') ?? parent.childForFieldName('left');
    if (pn) return pn.text;
  }
  return '';
}

function collectFunctions(root: Node, rules: LangRules, out: Node[]): void {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    if (rules.opaque?.includes(node.type)) continue;
    if (rules.functions.includes(node.type)) {
      const body = node.childForFieldName('body') ?? node.children.find((c) => c !== null && rules.bodies.includes(c.type)) ?? null;
      if (body) {
        out.push(node);
        continue; // never descend into a function we compress
      }
    }
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (c) stack.push(c);
    }
  }
}

function countIdentifiers(root: Node): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    const t = node.type;
    if (t === 'identifier' || t === 'property_identifier' || t === 'type_identifier' || t === 'field_identifier' || t === 'shorthand_property_identifier') {
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      continue;
    }
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (c && c.childCount > 0) stack.push(c);
      else if (c) {
        const ct = c.type;
        if (ct === 'identifier' || ct === 'property_identifier' || ct === 'type_identifier' || ct === 'field_identifier') counts.set(c.text, (counts.get(c.text) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function callsWithin(body: Node, defined: ReadonlySet<string>, self: string): string[] {
  const found = new Set<string>();
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop() as Node;
    if (node.type === 'identifier' || node.type === 'property_identifier') {
      if (defined.has(node.text) && node.text !== self) found.add(node.text);
    }
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (c) stack.push(c);
    }
  }
  return [...found].sort();
}

function pythonDocstring(body: Node): Node | null {
  const first = body.namedChildren.find((c) => c !== null) ?? null;
  if (!first) return null;
  if (first.type === 'string') return first;
  if (first.type === 'expression_statement') {
    const inner = first.namedChildren.find((c) => c !== null) ?? null;
    if (inner && inner.type === 'string') return inner;
  }
  return null;
}

function analyzeAst(root: Node, lines: readonly string[], langId: string, rules: LangRules, query: string, cfg: CodeCompressorConfig): FunctionInfo[] {
  const nodes: Node[] = [];
  collectFunctions(root, rules, nodes);
  if (!nodes.length) return [];
  const idCounts = countIdentifiers(root);
  const names = nodes.map(nodeName);
  const defined = new Set(names.filter(Boolean));
  const defCounts = new Map<string, number>();
  for (const n of names) if (n) defCounts.set(n, (defCounts.get(n) ?? 0) + 1);
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 2),
  );
  const infos: FunctionInfo[] = [];
  const raws: number[] = [];
  nodes.forEach((node, i) => {
    const body = (node.childForFieldName('body') ?? node.children.find((c) => c !== null && rules.bodies.includes(c.type))) as Node;
    const name = names[i];
    const refs = Math.max(0, (idCounts.get(name) ?? 0) - (defCounts.get(name) ?? 0));
    const isPublic = langId === 'go' ? /^[A-Z]/.test(name) : !name.startsWith('_');
    const calls = callsWithin(body, defined, name);
    let raw = refs + (isPublic ? 1 : 0) + 0.5 * calls.length;
    if (langId === 'py' && /^__\w+__$/.test(name)) raw += 2;
    if (langId === 'go' && /^[A-Z]/.test(name)) raw += 1;
    if (name && queryTokens.has(name.toLowerCase())) raw += 3;
    raws.push(raw);
    const statements = body.namedChildren.filter((c): c is Node => c !== null && !c.type.startsWith('comment')).map((c) => ({ startRow: c.startPosition.row, endRow: c.endPosition.row }));
    const bodyStartRow = body.startPosition.row;
    const bodyEndRow = body.endPosition.row;
    const info: FunctionInfo = { name, startRow: node.startPosition.row, endRow: node.endPosition.row, bodyStartRow, bodyEndRow, bodySize: Math.max(1, node.endPosition.row - node.startPosition.row + 1 - 2), statements, calls, score: 0 };
    if (langId === 'py') {
      const ds = pythonDocstring(body);
      if (ds) info.docstring = { row: ds.startPosition.row, endRow: ds.endPosition.row, text: ds.text };
    }
    infos.push(info);
  });
  const scores = normalizeScores(raws);
  infos.forEach((f, i) => {
    f.score = scores[i];
  });
  void cfg;
  void lines;
  return infos.sort((a, b) => a.startRow - b.startRow);
}

/** First-line docstring reconstruction: `{indent}{prefix}{first}{quote}`. */
export function docstringFirstLine(lines: readonly string[], row: number, endRow: number): string | null {
  const first = lines[row];
  const m = /^(\s*)(r?"""|r?'''|"|')/.exec(first);
  if (!m) return null;
  const indent = m[1];
  const prefix = m[2];
  const quote = prefix.replace(/^r/, '');
  let content = first.slice(indent.length + prefix.length);
  if (!content.trim() && endRow > row) content = lines[row + 1].trim();
  content = content.replace(new RegExp(`${quote.replace(/["']/g, '\\$&')}\\s*$`), '').trim();
  if (!content) return null;
  return `${indent}${prefix}${content}${quote}`;
}

function rewriteWithFunctions(lines: readonly string[], fns: readonly FunctionInfo[], limits: readonly number[], rules: LangRules, cfg: CodeCompressorConfig): { text: string; omitted: number; touched: number } {
  const out: string[] = [];
  let omitted = 0;
  let touched = 0;
  let row = 0;
  const indentUnit = detectIndent(lines);
  fns.forEach((f, i) => {
    if (f.startRow < row) return; // nested / overlapping — already emitted verbatim
    for (; row < f.startRow; row++) out.push(lines[row]);
    const limit = limits[i];
    const nodeLines = f.endRow - f.startRow + 1;
    if (nodeLines <= limit + 2 || !f.statements.length) {
      for (; row <= f.endRow; row++) out.push(lines[row]);
      return;
    }
    // signature rows (including a same-line opening brace)
    const firstContentRow = rules.colon ? f.bodyStartRow : f.bodyStartRow + (lines[f.bodyStartRow].trim() === '{' || lines[f.bodyStartRow].trimEnd().endsWith('{') ? 1 : 0);
    const closeRow = rules.colon ? null : f.bodyEndRow;
    const sigEnd = Math.min(firstContentRow - 1, f.endRow);
    for (; row <= sigEnd; row++) out.push(lines[row]);
    let used = 0;
    let lastKept = sigEnd;
    let dropped = 0;
    let first = true;
    for (const st of f.statements) {
      if (st.startRow < firstContentRow) continue;
      if (closeRow !== null && st.endRow >= closeRow) break;
      const size = st.endRow - st.startRow + 1;
      const isDoc = f.docstring && st.startRow === f.docstring.row;
      if (isDoc && f.docstring) {
        if (cfg.docstringMode === 'remove') {
          dropped += size;
          lastKept = st.endRow;
          continue;
        }
        if (cfg.docstringMode === 'first_line' && size > 1) {
          const ds = docstringFirstLine(lines, f.docstring.row, f.docstring.endRow);
          if (ds) {
            out.push(ds);
            used += 1;
            lastKept = st.endRow;
            first = false;
            continue;
          }
        }
      }
      if (first || used + size <= limit) {
        for (let r = st.startRow; r <= st.endRow; r++) out.push(lines[r]);
        used += size;
        lastKept = st.endRow;
        first = false;
      } else dropped += size;
    }
    if (dropped > 0) {
      const indent = f.statements.length && lines[f.statements[0].startRow] !== undefined ? leadingWs(lines[Math.max(f.statements[0].startRow, firstContentRow)]) || leadingWs(lines[f.startRow]) + indentUnit : leadingWs(lines[f.startRow]) + indentUnit;
      out.push(omittedMarker(indent, rules.comment, dropped, f.calls));
      omitted += dropped;
      touched++;
    }
    row = lastKept + 1;
    if (closeRow !== null) {
      for (let r = Math.max(row, closeRow); r <= f.endRow; r++) out.push(lines[r]);
    } else {
      // python: statements after the last kept one already counted as dropped
    }
    row = f.endRow + 1;
  });
  for (; row < lines.length; row++) out.push(lines[row]);
  return { text: out.join('\n'), omitted, touched };
}

export interface CodeCompression {
  text: string;
  omittedLines: number;
  functions: number;
  compressedFunctions: number;
  mode: 'ast' | 'heuristic';
  language: string;
}

/** AST path; null when the grammar is not loaded, the input does not parse, nothing shrank, or the output fails to re-parse. */
export function compressCodeAst(code: string, langId: string, query = '', cfg: CodeCompressorConfig = DEFAULT_CODE_CONFIG): CodeCompression | null {
  const parser = parsers.get(langId);
  const rules = RULES[langId];
  if (!parser || !rules || !rules.functions.length) return null;
  let tree = parser.parse(code);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError) return null;
    const lines = code.split('\n');
    const fns = analyzeAst(tree.rootNode, lines, langId, rules, query, cfg);
    if (!fns.length) return null;
    const limits = allocateBodyBudget(fns, lines.length, cfg);
    const r = rewriteWithFunctions(lines, fns, limits, rules, cfg);
    if (r.omitted === 0 || r.text.length >= code.length) return null;
    if (cfg.verifySyntax) {
      tree.delete();
      tree = parser.parse(r.text);
      if (!tree || tree.rootNode.hasError) return null;
    }
    return { text: r.text, omittedLines: r.omitted, functions: fns.length, compressedFunctions: r.touched, mode: 'ast', language: langId };
  } finally {
    try {
      tree?.delete();
    } catch {
      /* already freed */
    }
  }
}

// ---------------------------------------------------------------------------
// Heuristic path
// ---------------------------------------------------------------------------

const BRACE_FN_RE = /^\s*(?:(?:export|default|public|private|protected|static|async|override|final|abstract|internal|inline|constexpr|virtual|extern|unsafe|pub(?:\([^)]*\))?|fn|func|function|def)\s+)*[\w$<>\[\],:.*&?|\s]*?\b[\w$]+\s*(?:<[^>]*>)?\s*\([^;{}]*\)\s*(?::\s*[^{=;]+|->\s*[^{=;]+)?\s*(?:const\s*)?(?:throws\s+[\w.,\s]+)?(?:=>\s*)?\{\s*$/;
const PY_DEF_RE = /^(\s*)(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*(?:#.*)?$/;

function braceDelta(line: string): number {
  let d = 0;
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '/' && line[i + 1] === '/') break;
    else if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
}

/** Line/brace heuristic for unloaded grammars. Null when nothing shrank. */
export function compressCodeHeuristic(code: string, langId: string, cfg: CodeCompressorConfig = DEFAULT_CODE_CONFIG): CodeCompression | null {
  const lines = code.split('\n');
  const python = langId === 'py';
  if (langId === 'sh' || langId === 'rb' || langId === 'ex' || langId === 'lua') return null;
  const out: string[] = [];
  let omitted = 0;
  let functions = 0;
  let touched = 0;
  const comment = python ? '#' : '//';
  const indentUnit = detectIndent(lines);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (python) {
      const m = PY_DEF_RE.exec(line);
      if (m) {
        const baseIndent = m[1].length;
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || leadingWs(lines[j]).length > baseIndent)) j++;
        // trim trailing blank lines from the body
        let end = j;
        while (end > i + 1 && !lines[end - 1].trim()) end--;
        const bodyLines = end - (i + 1);
        functions++;
        out.push(line);
        if (bodyLines > cfg.maxBodyLines + 2) {
          let keep = i + 1;
          let kept = 0;
          const bodyIndent = leadingWs(lines[i + 1] ?? '') || m[1] + indentUnit;
          if (/^\s*(r?"""|r?''')/.test(lines[i + 1] ?? '')) {
            const ds = docstringFirstLine(lines, i + 1, end - 1);
            let dsEnd = i + 1;
            const q = /"""|'''/.exec(lines[i + 1] ?? '');
            if (q && (lines[i + 1].split(q[0]).length - 1) % 2 === 1) {
              dsEnd = i + 2;
              while (dsEnd < end && !lines[dsEnd].includes(q[0])) dsEnd++;
            }
            if (cfg.docstringMode !== 'remove' && ds && cfg.docstringMode === 'first_line') out.push(ds);
            else if (cfg.docstringMode === 'full') for (let r = i + 1; r <= dsEnd; r++) out.push(lines[r]);
            keep = dsEnd + 1;
          }
          while (keep < end && kept < cfg.maxBodyLines) {
            out.push(lines[keep]);
            keep++;
            kept++;
          }
          const dropped = end - keep;
          if (dropped > 0) {
            out.push(omittedMarker(bodyIndent, comment, dropped));
            omitted += dropped;
            touched++;
          }
        } else for (let r = i + 1; r < end; r++) out.push(lines[r]);
        i = end;
        continue;
      }
      out.push(line);
      i++;
      continue;
    }
    if (BRACE_FN_RE.test(line) && !/^\s*(if|for|while|switch|catch|else|try|do)\b/.test(line)) {
      let depth = braceDelta(line);
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        depth += braceDelta(lines[j]);
        j++;
      }
      const closeRow = j - 1;
      if (depth !== 0 || closeRow <= i) {
        out.push(line);
        i++;
        continue;
      }
      functions++;
      const bodyLines = closeRow - i - 1;
      out.push(line);
      if (bodyLines > cfg.maxBodyLines + 2) {
        let keep = i + 1;
        let bal = 0;
        let kept = 0;
        while (keep < closeRow && (kept < cfg.maxBodyLines || bal !== 0)) {
          bal += braceDelta(lines[keep]);
          out.push(lines[keep]);
          keep++;
          kept++;
          if (bal < 0) break;
        }
        const dropped = closeRow - keep;
        if (dropped > 0) {
          const indent = leadingWs(lines[i + 1] ?? '') || leadingWs(line) + indentUnit;
          out.push(omittedMarker(indent, comment, dropped));
          omitted += dropped;
          touched++;
        }
        out.push(lines[closeRow]);
      } else for (let r = i + 1; r <= closeRow; r++) out.push(lines[r]);
      i = closeRow + 1;
      continue;
    }
    out.push(line);
    i++;
  }
  if (omitted === 0) return null;
  const text = out.join('\n');
  if (text.length >= code.length) return null;
  return { text, omittedLines: omitted, functions, compressedFunctions: touched, mode: 'heuristic', language: langId };
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

export class CodeCompressor implements Compressor {
  readonly strategy = 'code_aware' as const;
  readonly config: CodeCompressorConfig;

  constructor(config: Partial<CodeCompressorConfig> = {}) {
    this.config = { ...DEFAULT_CODE_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['code_aware', 'passthrough'], ccrHashes: [], info });
    try {
      let langId = languageIdFor(req.language);
      if (!langId) {
        const det = tryDetectCode(content);
        langId = det ? languageIdFor(det.metadata.language as string) : undefined;
      }
      if (!langId) return passthrough('unknown_language');
      if (req.tokenizer.count(content) < this.config.minTokensForCompression) return passthrough('below_min_tokens');
      const r = compressCodeAst(content, langId, req.query ?? '', this.config) ?? compressCodeHeuristic(content, langId, this.config);
      if (!r) return passthrough(`no_savings:${langId}`);
      return {
        content: r.text,
        strategy: 'code_aware',
        chain: ['code_aware'],
        ccrHashes: [],
        info: `code:${r.language}:${r.mode}(${r.compressedFunctions}/${r.functions} functions, ${r.omittedLines} lines omitted)`,
        itemCounts: { original: content.split('\n').length, kept: r.text.split('\n').length },
      };
    } catch {
      return passthrough('error');
    }
  }
}
