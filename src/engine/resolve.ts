import * as path from 'node:path';
import { nodeId, edgeId } from './ids.js';
import { relativeResolver, type ModuleResolver } from './module-resolver.js';
import { isTestFile } from './tests.js';
import type { FileParse } from './types.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, ResolverKind } from '../schema.js';

/**
 * Resolution: turn per-file symbol/edge tables into a connected graph of nodes
 * and typed, id'd edges.
 *
 * The Phase-0 resolver is the deterministic **heuristic** rung of the ladder
 * (VG-ENGINE-TEARDOWN §3.2). It is already well beyond Graphify's
 * single-candidate label match: it is scope-aware (same-file first), import-aware
 * (callees reachable through imported files next), and arity/visibility-honest
 * (records its confidence and resolution rung per edge rather than silently
 * dropping ambiguity). SCIP/stack-graphs rungs slot in above it later, recorded
 * via `edge.resolution`.
 */

/**
 * A reference the heuristic resolver could not connect to a definition — the raw
 * material for `vg unknowns`. `from` is the node id of the enclosing definition
 * (or file) where the reference occurs; `name` is the callee/type it names. We
 * keep the source-relative path so a later precise rung that covers this file can
 * suppress the unknown (the compiler is authoritative there).
 */
export interface UnresolvedRef {
  from: string;
  name: string;
  kind: 'call' | 'extends' | 'implements';
  count: number;
  fromRel: string;
}

export interface ResolveResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** References the heuristic rung could not resolve (deduped, sorted). */
  unresolved: UnresolvedRef[];
  /** Diagnostic counts, surfaced by `vg status`. */
  stats: {
    callsResolved: number;
    callsUnresolved: number;
    importsResolvedToFile: number;
    importsExternal: number;
    resolvers: ResolverKind[];
  };
}

interface DefNodeRef {
  id: string;
  name: string;
  qualifiedName: string;
  rel: string;
  lang: string;
  kind: NodeKind;
  startByte: number; // for enclosing-scope lookup (not persisted)
  endByte: number;
}

// A partial node we fill analysis fields onto later (centrality/area/etc.).
type BaseNode = Omit<
  GraphNode,
  'importance' | 'centrality' | 'area' | 'isHub' | 'tested' | 'coverage' | 'changeCoupling'
>;

export function resolve(parses: FileParse[], resolver?: ModuleResolver): ResolveResult {
  const baseNodes = new Map<string, BaseNode>();
  const relSet = new Set(parses.map((p) => p.rel));
  // Default to relative-only resolution; build.ts passes a full resolver that
  // also follows tsconfig path aliases and workspace-package names.
  const mod = resolver ?? relativeResolver(relSet);

  // Index of definitions for resolution.
  const defsByName = new Map<string, DefNodeRef[]>(); // short name → defs
  const defsByFile = new Map<string, DefNodeRef[]>(); // rel → defs
  const fileNodeIdByRel = new Map<string, string>();

  // --- 1. file + definition nodes ---
  for (const p of parses) {
    const fileId = nodeId({ kind: 'file', qualifiedName: p.rel, file: p.rel });
    fileNodeIdByRel.set(p.rel, fileId);
    addNode(baseNodes, {
      id: fileId,
      kind: 'file',
      name: path.posix.basename(p.rel),
      qualifiedName: p.rel,
      file: p.rel,
      span: { start: 1, end: 1 },
      lang: p.lang,
    });

    for (const d of p.defs) {
      const id = nodeId({
        kind: d.kind,
        qualifiedName: d.qualifiedName,
        file: p.rel,
        signature: d.signature,
      });
      addNode(baseNodes, {
        id,
        kind: d.kind,
        name: d.name,
        qualifiedName: d.qualifiedName,
        file: p.rel,
        span: { start: d.startLine, end: d.endLine },
        lang: p.lang,
        signature: d.signature,
        doc: d.doc,
      });
      const ref: DefNodeRef = {
        id,
        name: d.name,
        qualifiedName: d.qualifiedName,
        rel: p.rel,
        lang: p.lang,
        kind: d.kind,
        startByte: d.startByte,
        endByte: d.endByte,
      };
      push(defsByName, d.name, ref);
      push(defsByFile, p.rel, ref);
    }
  }

  const edges = new EdgeSet();
  const unresolved = new Map<string, UnresolvedRef>();
  const stats: ResolveResult['stats'] = {
    callsResolved: 0,
    callsUnresolved: 0,
    importsResolvedToFile: 0,
    importsExternal: 0,
    resolvers: ['heuristic'],
  };

  // --- 2. contains edges (file → top-level def, def → nested def) ---
  for (const p of parses) {
    const fileId = fileNodeIdByRel.get(p.rel)!;
    const localByQn = new Map<string, string>();
    for (const ref of defsByFile.get(p.rel) ?? []) localByQn.set(ref.qualifiedName, ref.id);
    for (const d of p.defs) {
      const id = localByQn.get(d.qualifiedName)!;
      const parentQn = parentQualifiedName(d.qualifiedName);
      const parentId = parentQn ? localByQn.get(parentQn) : undefined;
      edges.add('contains', parentId ?? fileId, id, 'heuristic', 1.0);
    }
  }

  // --- 3. import edges (file → file | external) ---
  const importedFilesByRel = new Map<string, Set<string>>();
  for (const p of parses) {
    const fileId = fileNodeIdByRel.get(p.rel)!;
    const importedRels = new Set<string>();
    for (const imp of p.imports) {
      const targetRel = mod.resolve(p.rel, imp.source);
      if (targetRel && targetRel !== p.rel) {
        importedRels.add(targetRel);
        edges.add('import', fileId, fileNodeIdByRel.get(targetRel)!, 'heuristic', 0.9);
        stats.importsResolvedToFile++;
      } else {
        const extId = ensureExternalNode(baseNodes, imp.source);
        edges.add('import', fileId, extId, 'heuristic', 1.0);
        stats.importsExternal++;
      }
    }
    importedFilesByRel.set(p.rel, importedRels);
  }

  // --- 4. call edges (heuristic resolution ladder) ---
  for (const p of parses) {
    const fileId = fileNodeIdByRel.get(p.rel)!;
    const localDefs = defsByFile.get(p.rel) ?? [];
    const imported = importedFilesByRel.get(p.rel) ?? new Set<string>();
    const testCaller = isTestFile(p.rel);
    for (const call of p.calls) {
      const srcId = enclosingDefId(localDefs, call.byte) ?? fileId;
      const resolved = resolveCall(call, p.rel, p.lang, imported, defsByName, srcId, testCaller);
      if (resolved) {
        edges.add('call', srcId, resolved.id, 'heuristic', resolved.confidence);
        stats.callsResolved++;
      } else {
        stats.callsUnresolved++;
        bumpUnresolved(unresolved, srcId, call.callee, 'call', p.rel);
      }
    }
  }

  // --- 4b. type-reference edges (constructor/field DI wiring, not a call) ---
  // A constructor parameter or field's declared type is a structural
  // dependency even when it's never invoked directly (Spring-style injection).
  // Most misses here are JDK/stdlib types (String, List, …) with no local
  // definition — expected and not actionable, so unlike calls/heritage these
  // don't get tracked as `unresolved` (it would swamp `vg unknowns`).
  for (const p of parses) {
    const fileId = fileNodeIdByRel.get(p.rel)!;
    const localDefs = defsByFile.get(p.rel) ?? [];
    const imported = importedFilesByRel.get(p.rel) ?? new Set<string>();
    const testCaller = isTestFile(p.rel);
    for (const ref of p.typeRefs) {
      const srcId = enclosingDefId(localDefs, ref.byte) ?? fileId;
      const target = resolveType(ref.name, p.rel, p.lang, imported, defsByName, testCaller);
      if (target) edges.add('references', srcId, target.id, 'heuristic', 0.7);
    }
  }

  // --- 5. heritage edges (extends / implements) ---
  for (const p of parses) {
    const localDefs = defsByFile.get(p.rel) ?? [];
    const imported = importedFilesByRel.get(p.rel) ?? new Set<string>();
    const testCaller = isTestFile(p.rel);
    for (const h of p.heritage) {
      const srcId = enclosingDefId(localDefs, h.byte);
      if (!srcId) continue;
      const target = resolveType(h.superName, p.rel, p.lang, imported, defsByName, testCaller);
      if (target) edges.add(h.kind as EdgeKind, srcId, target.id, 'heuristic', 0.85);
      else bumpUnresolved(unresolved, srcId, h.superName, h.kind as 'extends' | 'implements', p.rel);
    }
  }

  // Finalise: assemble GraphNodes (analysis fields filled later by analyze()).
  // `tested` is null in Phase 0 (not yet analyzed); test-awareness lands in
  // Phase 2 and will set true/false for analyzable nodes.
  const nodes: GraphNode[] = [...baseNodes.values()].map((n) => ({
    ...n,
    importance: 0,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: null,
  }));

  const unresolvedList = [...unresolved.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );

  return { nodes, edges: edges.toArray(), unresolved: unresolvedList, stats };
}

// --- helpers ---

/** Accumulate an unresolved reference, deduped by (from, kind, name) with a count. */
function bumpUnresolved(
  map: Map<string, UnresolvedRef>,
  from: string,
  name: string,
  kind: UnresolvedRef['kind'],
  fromRel: string,
): void {
  const key = `${from} ${kind} ${name}`;
  const existing = map.get(key);
  if (existing) existing.count++;
  else map.set(key, { from, name, kind, count: 1, fromRel });
}

function addNode(map: Map<string, BaseNode>, n: BaseNode): void {
  if (!map.has(n.id)) map.set(n.id, n);
}

function ensureExternalNode(map: Map<string, BaseNode>, source: string): string {
  const id = nodeId({ kind: 'external', qualifiedName: source, file: '' });
  if (!map.has(id)) {
    map.set(id, {
      id,
      kind: 'external',
      name: source,
      qualifiedName: source,
      file: '',
      span: { start: 1, end: 1 },
      lang: 'external',
    });
  }
  return id;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function parentQualifiedName(qn: string): string | null {
  const idx = qn.lastIndexOf('.');
  return idx > 0 ? qn.slice(0, idx) : null;
}

function enclosingDefId(defs: DefNodeRef[], byte: number): string | undefined {
  let best: DefNodeRef | undefined;
  for (const d of defs) {
    if (d.startByte <= byte && d.endByte >= byte) {
      if (!best || d.endByte - d.startByte < best.endByte - best.startByte) best = d;
    }
  }
  return best?.id;
}

/**
 * Languages where definitions in the same directory share a visibility scope
 * (package / namespace) and reference each other WITHOUT an import — so a
 * same-directory match is justified resolution, not a guess:
 *   - Go: a package IS a directory; all files in it see each other's identifiers.
 *   - Java: same-package classes (package == directory by convention).
 *   - C#: file-scoped/co-located namespaces commonly align with the directory.
 *   - Kotlin/Scala: Java-style package visibility (package == directory by convention).
 *   - Swift: module-wide visibility; files in one target see each other un-imported.
 * TS/JS, Python, Ruby, PHP, Dart, Lua, Elixir, Shell, Zig, C and C++ require an
 * explicit import/include for cross-file refs, so they get NO directory rung —
 * a same-name def elsewhere is not reachable.
 */
const PACKAGE_SCOPED_LANGS = new Set(['go', 'java', 'cs', 'kotlin', 'scala', 'swift']);

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

/**
 * The heuristic call resolution ladder. A call resolves only when the target is
 * *reachable*: same-file scope, an imported file, or — for package-scoped
 * languages — the same package directory. There is deliberately NO "single
 * global definition with this name" fallback: that rung produced the dominant
 * class of false positives (every `fetch()` linking to a lone repo method named
 * `fetch`, every `parse()` to an unrelated `Parser.parse`). Honest
 * non-resolution (null) beats a wrong edge that corrupts centrality, areas and
 * impact; the SCIP/tsc rungs recover the precise edge where a user needs it.
 */
function resolveCall(
  call: { callee: string; qualified?: boolean },
  fromRel: string,
  fromLang: string,
  importedRels: Set<string>,
  defsByName: Map<string, DefNodeRef[]>,
  enclosingId?: string,
  fromIsTestFile = false,
): { id: string; confidence: number } | null {
  const candidates = defsByName.get(call.callee);
  if (!candidates || candidates.length === 0) return null;

  const callable = candidates.filter((c) => c.kind === 'function' || c.kind === 'method');
  const pool = callable.length ? callable : candidates;

  // 1. Same-file scope (the strongest signal). A *qualified* call (`crud.foo()`)
  // must not match the enclosing def itself: the parser drops the receiver, so a
  // handler `foo` that delegates to `module.foo(...)` would otherwise resolve to
  // *itself* — on FastAPI/Django-style codebases that false self-loop was the
  // dominant edge (100% of resolved calls in one corpus repo). A bare `foo()`
  // inside `foo` is still honest recursion and is kept.
  let sameFile = pool.filter((c) => c.rel === fromRel);
  if (call.qualified && enclosingId) sameFile = sameFile.filter((c) => c.id !== enclosingId);
  if (sameFile.length === 1) return { id: sameFile[0].id, confidence: 0.85 };
  if (sameFile.length > 1) {
    // Overloads/redefinitions in one file — pick deterministically, low confidence.
    const pick = [...sameFile].sort((a, b) => a.id.localeCompare(b.id))[0];
    return { id: pick.id, confidence: 0.4 };
  }

  // 2. Import-justified: the target's file is imported by the caller's file.
  const imported = pool.filter((c) => importedRels.has(c.rel));
  if (imported.length === 1) return { id: imported[0].id, confidence: 0.75 };
  if (imported.length > 1) return null; // ambiguous across imports — let a precise rung decide

  // 3. Same package directory (Go/Java/C#/Kotlin/Scala/Swift: visible without an
  // import). Same self-loop rule as rung 1: a *qualified* call never resolves to
  // the enclosing def itself.
  if (PACKAGE_SCOPED_LANGS.has(fromLang)) {
    const dir = dirOf(fromRel);
    let samePkg = pool.filter((c) => c.lang === fromLang && dirOf(c.rel) === dir);
    if (call.qualified && enclosingId) samePkg = samePkg.filter((c) => c.id !== enclosingId);
    if (samePkg.length === 1) return { id: samePkg[0].id, confidence: 0.7 };
  }

  // 4. Swift-only test-file fallback. Xcode test targets commonly live in a
  // sibling `Tests/` tree, not the product code's directory, so rung 3's
  // same-directory check never reaches them even though the whole module is
  // visible unimported — the dominant cause of `tests_for` undercounting a
  // class that a test directly constructs (including via a local helper).
  // Gated on the *caller* being test code (this only adds test-linkage/call
  // visibility, never a product-to-product edge) and an unambiguous
  // repo-wide name match, so it can't reintroduce the "lone global match"
  // false-positive class rung 4 elsewhere refuses to guess.
  if (fromLang === 'swift' && fromIsTestFile && pool.length === 1) {
    return { id: pool[0].id, confidence: 0.5 };
  }

  // 5. No reachability justification → do not guess (precision over recall).
  return null;
}

/** Heritage/type-reference resolution — same reachability rule as calls. */
function resolveType(
  name: string,
  fromRel: string,
  fromLang: string,
  importedRels: Set<string>,
  defsByName: Map<string, DefNodeRef[]>,
  fromIsTestFile = false,
): { id: string } | null {
  const candidates = (defsByName.get(name) ?? []).filter(
    (c) => c.kind === 'class' || c.kind === 'interface',
  );
  if (candidates.length === 0) return null;

  const sameFile = candidates.filter((c) => c.rel === fromRel);
  if (sameFile.length === 1) return { id: sameFile[0].id };

  const imported = candidates.filter((c) => importedRels.has(c.rel));
  if (imported.length === 1) return { id: imported[0].id };
  if (imported.length > 1) return null;

  if (PACKAGE_SCOPED_LANGS.has(fromLang)) {
    const dir = dirOf(fromRel);
    const samePkg = candidates.filter((c) => c.lang === fromLang && dirOf(c.rel) === dir);
    if (samePkg.length === 1) return { id: samePkg[0].id };
  }

  // Swift-only test-file fallback — see the matching rung in resolveCall.
  if (fromLang === 'swift' && fromIsTestFile && candidates.length === 1) {
    return { id: candidates[0].id };
  }
  return null; // no global single-match fallback (false-positive source)
}

/** Accumulates edges, deduping on (kind, src, dst) and counting multiplicity. */
class EdgeSet {
  private map = new Map<string, GraphEdge>();

  add(kind: EdgeKind, src: string, dst: string, resolution: ResolverKind, confidence: number): void {
    const id = edgeId(kind, src, dst);
    const existing = this.map.get(id);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      // Keep the highest confidence seen for this logical edge.
      if (confidence > existing.confidence) existing.confidence = confidence;
      return;
    }
    this.map.set(id, { id, kind, src, dst, resolution, confidence, count: 1 });
  }

  toArray(): GraphEdge[] {
    return [...this.map.values()].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
    );
  }
}
