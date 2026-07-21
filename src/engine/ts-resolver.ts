import * as path from 'node:path';
import ts from 'typescript';
import { edgeId } from './ids.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, ResolverKind } from '../schema.js';

/**
 * Precise TS/JS resolution via the TypeScript Compiler API — the type checker
 * itself, in-process, no external tool, `typescript` already a dependency. It
 * resolves `this.x()`, member calls, imported/aliased calls and heritage
 * exactly, which the heuristic rung structurally cannot (real codebases are
 * dominated by member calls → 0% heuristic resolution). Default-on for TS/JS.
 *
 * Deterministic: a ts.Program over the same files + options + compiler version
 * yields the same resolution; edges are stably sorted. Edges carry
 * `resolution: "tsc"`, confidence 1.0, and are authoritative for covered files.
 */

const PRECISE_KIND = 'tsc' satisfies ResolverKind;

export interface TsResolveResult {
  edges: GraphEdge[];
  /** Repo-relative files the program covered (tsc is authoritative for these). */
  coveredFiles: Set<string>;
  stats: { files: number; calls: number; jsx: number; heritage: number; resolved: number };
}

export function tsResolveEdges(
  root: string,
  tsFiles: { rel: string; abs: string }[],
  nodes: GraphNode[],
): TsResolveResult {
  const empty: TsResolveResult = {
    edges: [],
    coveredFiles: new Set(),
    stats: { files: 0, calls: 0, jsx: 0, heritage: 0, resolved: 0 },
  };
  if (tsFiles.length === 0) return empty;

  const absToRel = new Map(tsFiles.map((f) => [normalize(f.abs), f.rel]));
  const options = compilerOptions(root);
  let program: ts.Program;
  try {
    program = ts.createProgram(tsFiles.map((f) => f.abs), options);
  } catch {
    return empty; // never let resolution break the build
  }
  const checker = program.getTypeChecker();

  const nodesByFile = new Map<string, GraphNode[]>();
  const fileNodeByRel = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (n.kind === 'file') {
      fileNodeByRel.set(n.file, n);
      continue;
    }
    if (n.kind === 'external') continue;
    const list = nodesByFile.get(n.file);
    if (list) list.push(n);
    else nodesByFile.set(n.file, [n]);
  }

  const relForAbs = (abs: string): string | undefined => absToRel.get(normalize(abs));
  const edges = new Map<string, GraphEdge>();
  const covered = new Set<string>();
  const stats = empty.stats;
  // A method call on an interface-typed receiver resolves to the interface (its
  // method signatures are not graph nodes), so DI-injected services never got a
  // call edge to the concrete implementation. Record such calls and, once all
  // `implements` edges are known, bridge each to the SINGLE implementation's
  // matching method — the DI reality (the impl choice lives in module config,
  // not the caller). Only when exactly one class implements the interface, so it
  // never guesses among several. { srcId, interfaceId, method } tuples.
  const interfaceCalls: Array<{ srcId: string; interfaceId: string; method: string }> = [];
  const byId = new Map<string, GraphNode>();
  for (const list of nodesByFile.values()) for (const n of list) byId.set(n.id, n);

  for (const file of tsFiles) {
    const sf = program.getSourceFile(file.abs);
    if (!sf) continue;
    covered.add(file.rel);
    stats.files++;
    const fileNodes = nodesByFile.get(file.rel) ?? [];
    const fileNode = fileNodeByRel.get(file.rel);

    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        stats.calls++;
        const target = resolveTarget(checker, node.expression, nodesByFile, relForAbs);
        if (target) {
          // Attribute to the enclosing def, falling back to the file node for
          // top-level calls — mirrors the heuristic so test-linkage and
          // centrality see the same call granularity.
          const src = enclosing(fileNodes, lineOf(node.getStart(sf))) ?? fileNode;
          if (src && src.id !== target.id) {
            add(edges, callKind(target), src.id, target.id);
            stats.resolved++;
            // Interface-typed method call (`svc.method()` where svc: IFoo): the
            // target is the interface node, and the method name is the accessed
            // property. Record it for the single-implementation bridge below.
            if (target.kind === 'interface' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
              interfaceCalls.push({ srcId: src.id, interfaceId: target.id, method: node.expression.name.text });
            }
          }
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        // JSX component usage (`<Foo/>`) is a render — a call in the graph.
        // Dominant cross-module link in React/Next code, which the heuristic and
        // a CallExpression-only walk both miss. Lowercase tags are intrinsic
        // HTML elements and resolve to nothing in-repo (skipped).
        if (isComponentTag(node.tagName)) {
          stats.jsx++;
          const target = resolveTarget(checker, node.tagName, nodesByFile, relForAbs);
          if (target) {
            const src = enclosing(fileNodes, lineOf(node.getStart(sf))) ?? fileNode;
            if (src && src.id !== target.id) {
              add(edges, callKind(target), src.id, target.id);
              stats.resolved++;
            }
          }
        }
      } else if (ts.isClassDeclaration(node) && node.heritageClauses) {
        const classLine = lineOf(node.getStart(sf));
        const src = enclosing(fileNodes, classLine);
        for (const clause of node.heritageClauses) {
          const kind: EdgeKind = clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
          for (const t of clause.types) {
            stats.heritage++;
            const target = resolveTarget(checker, t.expression, nodesByFile, relForAbs);
            if (src && target && src.id !== target.id) {
              add(edges, kind, src.id, target.id);
              stats.resolved++;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Single-implementation bridge: for each interface with EXACTLY ONE
  // implementing class, redirect its recorded interface-typed calls to the
  // implementation's matching method. This is the DI edge that makes impact_of /
  // tests_for / find_path work on the concrete service. Skipped when an
  // interface has zero or several implementations (genuinely ambiguous — the
  // references→interface edge already recorded the dependency).
  const implsByInterface = new Map<string, string[]>();
  for (const e of edges.values()) {
    if (e.kind !== 'implements' && e.kind !== 'extends') continue;
    if (byId.get(e.dst)?.kind !== 'interface') continue;
    const list = implsByInterface.get(e.dst);
    if (list) list.push(e.src);
    else implsByInterface.set(e.dst, [e.src]);
  }
  for (const { srcId, interfaceId, method } of interfaceCalls) {
    const impls = implsByInterface.get(interfaceId);
    if (!impls || impls.length !== 1) continue;
    const impl = byId.get(impls[0]);
    if (!impl) continue;
    const target = (nodesByFile.get(impl.file) ?? []).find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.qualifiedName === `${impl.qualifiedName}.${method}`,
    );
    if (target && target.id !== srcId) {
      add(edges, 'call', srcId, target.id);
      stats.resolved++;
    }
  }

  return { edges: [...edges.values()], coveredFiles: covered, stats };
}

/** A render/invoke target (function/method/class/component) is a `call`; other
 * kinds (interface/property/…) are `references`. */
function callKind(target: GraphNode): EdgeKind {
  return target.kind === 'function' ||
    target.kind === 'method' ||
    target.kind === 'class' ||
    target.kind === 'component'
    ? 'call'
    : 'references';
}

/** Is a JSX tag a component (resolvable in-repo) vs an intrinsic HTML element? */
function isComponentTag(tag: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tag)) return /^[A-Z]/.test(tag.text);
  // `<Namespace.Component/>` / `<obj.Member/>` — a property access is a component ref.
  return ts.isPropertyAccessExpression(tag);
}

function resolveTarget(
  checker: ts.TypeChecker,
  expr: ts.Node,
  nodesByFile: Map<string, GraphNode[]>,
  relForAbs: (abs: string) => string | undefined,
): GraphNode | null {
  let sym = checker.getSymbolAtLocation(expr);
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* keep original */
    }
  }
  const decls = sym.declarations;
  if (!decls) return null;
  for (const decl of decls) {
    const df = decl.getSourceFile();
    const rel = relForAbs(df.fileName);
    if (!rel) continue; // declaration is external (node_modules / lib)
    const fileNodes = nodesByFile.get(rel);
    if (!fileNodes) continue;
    const line = df.getLineAndCharacterOfPosition(decl.getStart(df)).line + 1;
    // Pick the node for this declaration, using its syntax kind to disambiguate
    // when several nodes start on the same line (e.g. a single-line class and
    // its method) — the type checker knows whether we want the method or the
    // class, so a name/line collision never picks the wrong one.
    const node = pickNode(fileNodes, line, expectedKinds(decl));
    if (node) return node;
  }
  return null;
}

/** Node kinds a declaration could map to (for same-line tie-breaking). */
function expectedKinds(decl: ts.Node): Set<NodeKind> {
  if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) return new Set(['method']);
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) {
    return new Set(['function', 'method', 'component']);
  }
  if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return new Set(['class', 'component']);
  if (ts.isInterfaceDeclaration(decl)) return new Set(['interface']);
  if (
    ts.isPropertyDeclaration(decl) ||
    ts.isPropertySignature(decl) ||
    ts.isGetAccessorDeclaration(decl) ||
    ts.isSetAccessorDeclaration(decl)
  ) {
    return new Set(['property', 'method']);
  }
  if (ts.isConstructorDeclaration(decl)) return new Set(['class', 'method']);
  if (ts.isVariableDeclaration(decl)) return new Set(['function', 'property', 'component']);
  return new Set();
}

/**
 * The node for a declaration at `line`: among nodes starting exactly there,
 * prefer one whose kind the declaration expects, then the smallest span, then
 * the lexicographically smaller id (a stable, order-independent tiebreak). Falls
 * back to the smallest enclosing node when nothing starts on that line.
 */
function pickNode(nodes: GraphNode[], line: number, want: Set<NodeKind>): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.span.start !== line) continue;
    if (!best || better(n, best, want)) best = n;
  }
  return best ?? enclosing(nodes, line);
}

function better(n: GraphNode, best: GraphNode, want: Set<NodeKind>): boolean {
  const nWanted = want.has(n.kind);
  const bWanted = want.has(best.kind);
  if (nWanted !== bWanted) return nWanted;
  const nSize = n.span.end - n.span.start;
  const bSize = best.span.end - best.span.start;
  if (nSize !== bSize) return nSize < bSize;
  return n.id < best.id;
}

function compilerOptions(root: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    noResolve: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
  };
  // Honor the project's tsconfig (paths/baseUrl) for accurate module resolution.
  // Prefer tsconfig.json, then tsconfig.base.json (Nx/Turborepo), and follow
  // `extends` chains — real monorepos put path aliases in a base config that
  // per-package configs extend. getParsedCommandLineOfConfigFile resolves the
  // whole chain (parseJsonConfigFileContent does not).
  const configPath =
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.base.json');
  if (configPath) {
    try {
      const host: ts.ParseConfigFileHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {
          /* tolerate broken config — fall back to base */
        },
      };
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
      if (parsed) {
        // Keep the project's module map (baseUrl/paths) but force our read-only,
        // permissive compile settings on top so resolution is maximal.
        return { ...parsed.options, ...base, baseUrl: parsed.options.baseUrl, paths: parsed.options.paths };
      }
    } catch {
      /* fall back to base */
    }
  }
  return base;
}

function add(map: Map<string, GraphEdge>, kind: EdgeKind, src: string, dst: string): void {
  const id = edgeId(kind, src, dst);
  const existing = map.get(id);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    return;
  }
  map.set(id, { id, kind, src, dst, resolution: PRECISE_KIND, confidence: 1.0, count: 1 });
}

function enclosing(nodes: GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes) {
    if (n.span.start <= line && n.span.end >= line) {
      if (!best || n.span.end - n.span.start < best.span.end - best.span.start) best = n;
    }
  }
  return best;
}

function normalize(p: string): string {
  return path.resolve(p).split(path.sep).join('/');
}
