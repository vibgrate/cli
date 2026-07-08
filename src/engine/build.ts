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
import {
  resolveLimits,
  checkMemoryBudget,
  formatBytes,
  ResourceLimitError,
  type ResourceLimits,
} from './limits.js';
import { hashString, hashBytes, canonicalize, shortId } from './hash.js';
import { grammarSetVersion } from './grammars.js';
import { classifyEpistemic } from './epistemic.js';
import { VERSION } from '../version.js';
import {
  SCHEMA_VERSION,
  type EdgeKind,
  type GraphEdge,
  type ResolverKind,
  type Toolchain,
  type VgGraph,
} from '../schema.js';
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
  /** Resource-safeguard overrides (else VG_MAX_FILE_BYTES / VG_MAX_FILES /
   * VG_TSC_MAX_FILES / VG_MEMORY_BUDGET_MB env vars, else defaults). */
  limits?: Partial<ResourceLimits>;
}

/** Stat + content hash of one corpus file at build time. */
export interface FileStat {
  rel: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface BuildResult {
  graph: VgGraph;
  timing: { totalMs: number };
  reparsed: number;
  reused: number;
  totalFiles: number;
  /** Stat+hash of every file in the corpus — input for the freshness snapshot. */
  fileStats: FileStat[];
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

  // Resource safeguards (see limits.ts): stop a pathological corpus before it
  // OOM-kills the process. Skips are deterministic functions of the input.
  const limits = resolveLimits(options.limits);
  if (limits.maxFiles > 0 && files.length > limits.maxFiles) {
    throw new ResourceLimitError(
      `graph build stopped: ${files.length.toLocaleString()} files exceed the ` +
        `${limits.maxFiles.toLocaleString()}-file limit. Scope the build (pass sub-paths, add ` +
        `--exclude globs, or --only <langs>), or set VG_MAX_FILES to raise the limit ` +
        `(0 disables it).`,
    );
  }
  checkMemoryBudget('discovery', limits.memoryBudgetMb);

  const grammars = grammarSetVersion();
  const cache = loadCache(root, {
    toolVersion: VERSION,
    grammars,
    disabled: options.noCache,
  });

  // Hash every discovered file (cheap) and split into reuse vs reparse. The
  // stat is taken *before* the read so a mid-read edit shows up as a stat
  // mismatch on the next freshness probe (never a silently-missed change).
  const hashes = new Map<string, string>();
  const fileStats: FileStat[] = [];
  const toParse: DiscoveredFile[] = [];
  const reused: FileParse[] = [];
  const buildWarnings: string[] = [];
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.abs);
    } catch {
      // Unreadable now (race/permissions) — skip; it just won't be in the graph.
      continue;
    }
    if (limits.maxFileBytes > 0 && stat.size > limits.maxFileBytes) {
      // Too large to parse (almost always generated/minified). It stays in
      // fileStats — under a size-derived sentinel hash, so the file is never
      // read into memory — because the freshness probe re-discovers it; were
      // it absent from the snapshot every probe would report phantom "added"
      // drift and auto-refresh would rebuild in a loop.
      fileStats.push({
        rel: file.rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: hashString(`vg:oversize:${stat.size}`),
      });
      buildWarnings.push(
        `${file.rel}: skipped — ${formatBytes(stat.size)} exceeds the ` +
          `${formatBytes(limits.maxFileBytes)} per-file limit (set VG_MAX_FILE_BYTES to raise it, 0 to disable)`,
      );
      continue;
    }
    let hash = '';
    try {
      hash = hashBytes(fs.readFileSync(file.abs));
    } catch {
      continue;
    }
    hashes.set(file.rel, hash);
    fileStats.push({ rel: file.rel, size: stat.size, mtimeMs: stat.mtimeMs, hash });
    const cached = cache.get(file.rel, hash);
    if (cached) reused.push(cached);
    else toParse.push(file);
  }

  const parsedNew = await parseFiles(toParse, {
    jobs: options.jobs,
    inline: options.inline,
    onProgress: options.onParseProgress,
    grammarsDir: options.grammarsDir,
    memoryBudgetMb: limits.memoryBudgetMb,
  });
  checkMemoryBudget('parse', limits.memoryBudgetMb);
  for (const p of parsedNew) cache.set(p.rel, p);

  // Persist the cache for the next incremental build.
  const currentRels = new Set(files.map((f) => f.rel));
  cache.prune(currentRels);
  cache.save();

  const parses = [...reused, ...parsedNew].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );

  const warnings = [...buildWarnings, ...parses.flatMap((p) => p.warnings ?? [])];

  // Resolve → nodes/edges. The module resolver follows relative imports plus
  // tsconfig path aliases and workspace-package names (so monorepo cross-package
  // imports resolve, not just relative ones).
  const moduleResolver = buildModuleResolver(root, new Set(parses.map((p) => p.rel)));
  const resolved = resolve(parses, moduleResolver);
  checkMemoryBudget('resolve', limits.memoryBudgetMb);

  // Precise resolution rungs sit above the heuristic floor and are authoritative
  // for the files they cover (their relational edges replace the heuristic ones,
  // not merely augment them). Order: heuristic → tsc → scip. Runs before
  // test-linkage so it sharpens those edges too.
  const nodeFileById = new Map(resolved.nodes.map((n) => [n.id, n.file]));
  let edges = resolved.edges;
  const resolvers: ResolverKind[] = [...resolved.stats.resolvers];
  // Files a precise rung (tsc/scip) covered — their heuristic unknowns are
  // superseded by the authoritative resolver and must not be reported as unknown.
  const preciseCoveredFiles = new Set<string>();

  // Rung 1 — TypeScript Compiler API for TS/JS (default-on, in-process, no
  // external tool). The type checker resolves member/`this`/imported/aliased
  // calls and heritage that the heuristic structurally cannot.
  let tscStats: BuildResult['tsc'];
  // `hashes` holds exactly the parsed corpus — oversized (size-capped) files
  // are excluded here too, so the TS program never loads them.
  let tsFiles = options.noTsc
    ? []
    : files
        .filter((f) => (f.lang.id === 'ts' || f.lang.id === 'tsx' || f.lang.id === 'js') && hashes.has(f.rel))
        .map((f) => ({ rel: f.rel, abs: f.abs }));
  if (limits.tscMaxFiles > 0 && tsFiles.length > limits.tscMaxFiles) {
    // A ts.Program over the whole corpus is the largest single memory consumer
    // in the build. Past the cap, fall back to the heuristic floor (still a
    // complete graph, just less precise call resolution).
    warnings.push(
      `typescript resolver skipped — ${tsFiles.length.toLocaleString()} TS/JS files exceed the ` +
        `${limits.tscMaxFiles.toLocaleString()}-file limit; calls use the heuristic resolver ` +
        `(set VG_TSC_MAX_FILES to raise it, 0 to disable)`,
    );
    tsFiles = [];
  }
  if (tsFiles.length) {
    const res = tsResolveEdges(root, tsFiles, resolved.nodes);
    if (res.stats.files > 0) {
      edges = mergePreciseEdges(edges, res.edges, res.coveredFiles, nodeFileById);
      for (const f of res.coveredFiles) preciseCoveredFiles.add(f);
      if (!resolvers.includes('tsc')) resolvers.unshift('tsc');
      tscStats = res.stats;
    }
    checkMemoryBudget('typescript resolution', limits.memoryBudgetMb);
  }

  // Rung 2 — a real SCIP index (if present), the most precise rung for any
  // language an indexer covers.
  const scip = options.noScip ? null : loadScipIndex(root, options.scip);
  let scipStats: BuildResult['scip'];
  if (scip) {
    const res = scipEdges(scip.index, resolved.nodes, toRepoRel);
    edges = mergePreciseEdges(edges, res.edges, res.coveredFiles, nodeFileById);
    for (const f of res.coveredFiles) preciseCoveredFiles.add(f);
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
  checkMemoryBudget('analysis', limits.memoryBudgetMb);

  const languages = [...new Set(parses.map((p) => p.lang))].sort();
  const edgeKinds = [...new Set(analysis.edges.map((e) => e.kind))].sort() as EdgeKind[];
  const corpusHash = computeCorpusHash(parses, hashes);

  // Edge-level epistemic tier: stamp every edge with how it was resolved
  // (observed / name-matched / declared) so consumers can filter by assurance.
  // Pure function of the edge's fields + its destination node kind → deterministic.
  const nodeKindById = new Map(analysis.nodes.map((n) => [n.id, n.kind]));
  for (const e of analysis.edges) {
    e.epistemic = classifyEpistemic(e, nodeKindById.get(e.dst));
  }

  const toolchain = computeToolchain(grammars, resolvers);

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
      toolchain,
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

  // Unknowns: heuristic references we could not resolve, minus any site a precise
  // rung authoritatively covered. Ranked/consumed by `vg unknowns`. Deterministic
  // (already sorted by resolve()); only ids that survived analysis are kept.
  const survivingIds = new Set(analysis.nodes.map((n) => n.id));
  const unknowns = resolved.unresolved
    .filter((u) => !preciseCoveredFiles.has(u.fromRel) && survivingIds.has(u.from))
    .map((u) => ({ from: u.from, name: u.name, kind: u.kind, count: u.count }));
  if (unknowns.length) graph.unknowns = unknowns;

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
    fileStats,
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

/**
 * The reproducibility fingerprint: a short content-address over the parts of the
 * toolchain that deterministically shape graph *content* — schema, tool version,
 * tree-sitter grammar set, and the resolver kinds available. Node/OS versions are
 * deliberately excluded so the graph stays byte-stable across host runtimes; the
 * fingerprint pins the parse/resolve toolchain, which is what actually changes
 * edges between a CI run and a laptop run. This is the value `vg attest` signs and
 * `vg verify` compares against a committed graph.
 */
function computeToolchain(grammars: string, resolvers: ResolverKind[]): Toolchain {
  const sortedResolvers = [...new Set(resolvers)].sort();
  return {
    schema: SCHEMA_VERSION,
    tool: VERSION,
    grammars,
    resolvers: sortedResolvers,
    fingerprint: shortId(
      canonicalize({
        schema: SCHEMA_VERSION,
        tool: VERSION,
        grammars,
        resolvers: sortedResolvers,
      }),
    ),
  };
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
