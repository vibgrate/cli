import * as fs from 'node:fs';
import * as path from 'node:path';
import { discover, type DiscoveredFile } from './discover.js';
import { parseFiles } from './pool.js';
import { resolve } from './resolve.js';
import { buildModuleResolver } from './module-resolver.js';
import { tsResolveEdges } from './ts-resolver.js';
import { decodeScipIndex, scipEdges } from './scip.js';
import { analyze, type ClusterMode } from './analyze.js';
import { applyStaticTestLinkage } from './tests.js';
import { loadCoverage, applyCoverage } from './coverage.js';
import { buildFacts } from './facts.js';
import { groundGraph } from './grounding.js';
import { loadCache } from './cache.js';
import { hashString, hashBytes, canonicalize } from './hash.js';
import { grammarSetVersion } from './grammars.js';
import { VERSION } from '../version.js';
import { SCHEMA_VERSION, type EdgeKind, type GraphEdge, type ResolverKind, type VgGraph } from '../schema.js';
import type { ScipIndex } from './scip.js';
import type { FileParse } from './types.js';
import type { ResolveResult } from './resolve.js';

export interface BuildOptions {
  /** Directory to build (default cwd). */
  root: string;
  /** Restrict to language ids. */
  only?: string[];
  /** Extra ignore globs (gitignore syntax). */
  exclude?: string[];
  /** Sub-paths to scope to. */
  paths?: string[];
  /** Worker count; 1 forces inline. */
  jobs?: number;
  /** Force single-threaded parsing. */
  inline?: boolean;
  /** Disable the incremental cache (full rebuild). */
  noCache?: boolean;
  /** Heavier open passes (recorded in provenance; Phase 1+ wires the analyses). */
  deep?: boolean;
  /** Community detection mode (default 'louvain'). */
  cluster?: ClusterMode;
  /** Coverage report paths (default: auto-detect lcov/istanbul). */
  coverage?: string[];
  /** Skip coverage ingestion. */
  noCoverage?: boolean;
  /** Skip grounding (free knowledge pack). Default: grounding on. */
  noGround?: boolean;
  /** Path to a SCIP index to ingest (default: auto-detect index.scip). */
  scip?: string;
  /** Skip SCIP ingestion even if an index is present. */
  noScip?: boolean;
  /** Skip the in-process TypeScript Compiler API resolver (heuristic floor only). */
  noTsc?: boolean;
  /** Pin the artifact timestamp for byte-deterministic output. */
  generatedAt?: string;
  /** Live progress during the parse phase (files done of total). */
  onParseProgress?: (done: number, total: number) => void;
  /** Override directory for grammar .wasm files (offline / air-gapped). */
  grammarsDir?: string;
}

export interface BuildResult {
  graph: VgGraph;
  timing: { totalMs: number };
  reparsed: number;
  reused: number;
  totalFiles: number;
  resolveStats: ResolveResult['stats'];
  /** Present when the TypeScript Compiler API resolver ran (TS/JS files). */
  tsc?: { files: number; calls: number; jsx: number; heritage: number; resolved: number };
  /** Present when a SCIP index was ingested. */
  scip?: { documents: number; references: number; resolved: number; tool?: string };
  warnings: string[];
}

export async function buildGraph(options: BuildOptions): Promise<BuildResult> {
  const start = nowMs();
  const root = path.resolve(options.root);
  const files = discover({
    root,
    only: options.only,
    exclude: options.exclude,
    paths: options.paths,
  });

  const grammars = grammarSetVersion();
  const cache = loadCache(root, {
    toolVersion: VERSION,
    grammars,
    disabled: options.noCache,
  });

  // Hash every discovered file (cheap) and split into reuse vs reparse.
  const hashes = new Map<string, string>();
  const toParse: DiscoveredFile[] = [];
  const reused: FileParse[] = [];
  for (const file of files) {
    let hash = '';
    try {
      hash = hashBytes(fs.readFileSync(file.abs));
    } catch {
      // Unreadable now (race/permissions) — skip; it just won't be in the graph.
      continue;
    }
    hashes.set(file.rel, hash);
    const cached = cache.get(file.rel, hash);
    if (cached) reused.push(cached);
    else toParse.push(file);
  }

  const parsedNew = await parseFiles(toParse, {
    jobs: options.jobs,
    inline: options.inline,
    onProgress: options.onParseProgress,
    grammarsDir: options.grammarsDir,
  });
  for (const p of parsedNew) cache.set(p.rel, p);

  // Persist the cache for the next incremental build.
  const currentRels = new Set(files.map((f) => f.rel));
  cache.prune(currentRels);
  cache.save();

  const parses = [...reused, ...parsedNew].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );

  const warnings = parses.flatMap((p) => p.warnings ?? []);

  // Resolve → nodes/edges. The module resolver follows relative imports plus
  // tsconfig path aliases and workspace-package names (so monorepo cross-package
  // imports resolve, not just relative ones).
  const moduleResolver = buildModuleResolver(root, new Set(parses.map((p) => p.rel)));
  const resolved = resolve(parses, moduleResolver);

  // Precise resolution rungs sit above the heuristic floor and are authoritative
  // for the files they cover (their relational edges replace the heuristic ones,
  // not merely augment them). Order: heuristic → tsc → scip. Runs before
  // test-linkage so it sharpens those edges too.
  const nodeFileById = new Map(resolved.nodes.map((n) => [n.id, n.file]));
  let edges = resolved.edges;
  const resolvers: ResolverKind[] = [...resolved.stats.resolvers];

  // Rung 1 — TypeScript Compiler API for TS/JS (default-on, in-process, no
  // external tool). The type checker resolves member/`this`/imported/aliased
  // calls and heritage that the heuristic structurally cannot.
  let tscStats: BuildResult['tsc'];
  const tsFiles = options.noTsc
    ? []
    : files
        .filter((f) => f.lang.id === 'ts' || f.lang.id === 'tsx' || f.lang.id === 'js')
        .map((f) => ({ rel: f.rel, abs: f.abs }));
  if (tsFiles.length) {
    const res = tsResolveEdges(root, tsFiles, resolved.nodes);
    if (res.stats.files > 0) {
      edges = mergePreciseEdges(edges, res.edges, res.coveredFiles, nodeFileById);
      if (!resolvers.includes('tsc')) resolvers.unshift('tsc');
      tscStats = res.stats;
    }
  }

  // Rung 2 — a real SCIP index (if present), the most precise rung for any
  // language an indexer covers.
  const scip = options.noScip ? null : loadScipIndex(root, options.scip);
  let scipStats: BuildResult['scip'];
  if (scip) {
    const res = scipEdges(scip.index, resolved.nodes, toRepoRel);
    edges = mergePreciseEdges(edges, res.edges, res.coveredFiles, nodeFileById);
    if (!resolvers.includes('scip')) resolvers.unshift('scip');
    scipStats = { ...res.stats, tool: scip.tool };
  }

  // Test-awareness: static test→code linkage, then runtime coverage if present.
  const linked = applyStaticTestLinkage(resolved.nodes, edges);
  let nodes = linked.nodes;
  const coverage = options.noCoverage ? null : loadCoverage(root, options.coverage);
  if (coverage) nodes = applyCoverage(nodes, coverage);

  // Analyse → centrality/areas/surprise (test/coverage edges excluded from these).
  const analysis = analyze(nodes, linked.edges, { cluster: options.cluster });

  const languages = [...new Set(parses.map((p) => p.lang))].sort();
  const edgeKinds = [...new Set(analysis.edges.map((e) => e.kind))].sort() as EdgeKind[];
  const corpusHash = computeCorpusHash(parses, hashes);

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const testsCount = linked.testFiles.length;
  const untestedCount = analysis.nodes.filter(
    (n) => (n.kind === 'function' || n.kind === 'method') && n.tested === false,
  ).length;

  const graph: VgGraph = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    provenance: {
      tool: 'vg',
      version: VERSION,
      grammars: Object.fromEntries(languages.map((l) => [l, grammars])),
      resolver: resolvers,
      deep: options.deep ?? false,
      corpusHash,
    },
    meta: {
      root: path.basename(root) === '' ? '.' : '.',
      languages,
      counts: {
        nodes: analysis.nodes.length,
        edges: analysis.edges.length,
        areas: analysis.areas.length,
        tests: testsCount,
        untested: untestedCount,
      },
      cluster: analysis.cluster,
      edgeKinds,
    },
    nodes: analysis.nodes,
    edges: analysis.edges,
    areas: analysis.areas,
  };

  // Facts (--deep) and grounding (default on).
  if (options.deep) {
    const facts = buildFacts(parses, analysis.nodes, analysis.edges);
    if (facts.length) graph.facts = facts;
  }
  if (!options.noGround) {
    const grounding = groundGraph(analysis.nodes, analysis.edges, parses);
    if (grounding.length) graph.grounding = grounding;
  }

  return {
    graph,
    timing: { totalMs: Math.round((nowMs() - start) * 1000) / 1000 },
    reparsed: parsedNew.length,
    reused: reused.length,
    totalFiles: files.length,
    resolveStats: resolved.stats,
    tsc: tscStats,
    scip: scipStats,
    warnings,
  };
}

/** Repo-relative POSIX path for a SCIP document path. */
function toRepoRel(p: string): string {
  return p.split('\\').join('/').replace(/^\.?\//, '');
}

/** Auto-detect (or take an explicit) SCIP index and decode it. */
function loadScipIndex(root: string, explicit?: string): { index: ScipIndex; tool?: string } | null {
  const candidates = [
    explicit,
    path.join(root, 'index.scip'),
    path.join(root, '.vibgrate', 'index.scip'),
  ].filter((p): p is string => Boolean(p));
  for (const file of candidates) {
    const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
    if (!fs.existsSync(abs)) continue;
    try {
      const index = decodeScipIndex(new Uint8Array(fs.readFileSync(abs)));
      if (index.documents.length) {
        return { index, tool: index.toolVersion ? `${index.toolName} ${index.toolVersion}` : index.toolName };
      }
    } catch {
      /* unreadable/garbled index — fall back to heuristic */
    }
  }
  return null;
}

/** Relational edge kinds a precise resolver is authoritative for. Structural
 * kinds (import/contains/test/coverage) are produced elsewhere and preserved. */
const PRECISE_KINDS = new Set<EdgeKind>(['call', 'references', 'extends', 'implements']);

/**
 * Merge precise edges over the base set, treating the precise rung as
 * authoritative for the files it covered. For a covered file we DROP the
 * heuristic relational edges originating there (they are guesses the precise
 * resolver has now superseded) and replace them with the precise ones. Edges
 * whose source lives in an uncovered file, and non-relational edges, are kept.
 * Already-precise edges (tsc/scip) are never dropped. Precise wins on id
 * collision. Output is stably sorted for determinism.
 */
function mergePreciseEdges(
  base: GraphEdge[],
  precise: GraphEdge[],
  coveredFiles: Set<string>,
  nodeFileById: Map<string, string>,
): GraphEdge[] {
  const byId = new Map<string, GraphEdge>();
  for (const e of base) {
    if (PRECISE_KINDS.has(e.kind) && e.resolution === 'heuristic') {
      const srcFile = nodeFileById.get(e.src);
      if (srcFile && coveredFiles.has(srcFile)) continue; // superseded by precise rung
    }
    byId.set(e.id, e);
  }
  for (const e of precise) byId.set(e.id, e); // precise wins on id collision
  return [...byId.values()].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
  );
}

/** blake3 over the sorted (path, content-hash) list — the corpus identity. */
function computeCorpusHash(parses: FileParse[], hashes: Map<string, string>): string {
  const list = parses
    .map((p) => [p.rel, hashes.get(p.rel) ?? p.hash] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hashString(canonicalize(list));
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
