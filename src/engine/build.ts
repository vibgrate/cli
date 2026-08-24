import * as fs from 'node:fs';
import * as path from 'node:path';
import { discover, mergeExcludes, type DiscoveredFile } from './discover.js';
import { parseFiles } from './pool.js';
import { resolve } from './resolve.js';
import { buildModuleResolver } from './module-resolver.js';
import { assembleTsResult, tsWalkFiles, type TsFilePartial } from './ts-resolver.js';
import { decodeScipIndex, scipEdges } from './scip.js';
import { analyze, type AnalysisTier, type ClusterMode } from './analyze.js';
import { applyStaticTestLinkage } from './tests.js';
import { loadCoverage, applyCoverage } from './coverage.js';
import { buildFacts } from './facts.js';
import { groundGraph } from './grounding.js';
import { loadCache } from './cache.js';
import { ambientFingerprint, loadTscCache, tsConfigFingerprint, tscKeys } from './tsc-cache.js';
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
import { discoverDocs, documentNodesFromDocs } from './docs-ingest.js';
import { extractToolchain } from './toolchain/index.js';
import { toolchainGrammarSetVersion } from './toolchain/grammars.js';
import { shardTsProjects } from './ts-projects.js';
import { writeGraphIndex } from './index-db.js';
import { StageTimer, type StageTimings } from './timing.js';
import { buildSummaries } from './summaries.js';
import { extractManifests } from './manifests.js';
import { hashFilesParallel } from './hash-files.js';
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
import { fileRolesFromParses } from './ast-roles.js';
import type { AstRoleHit } from '../core-open/scanners/architecture/ast-roles.js';

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
  /**
   * Fast mode: skip tsc precise resolve (heuristic only). Useful for XL cold
   * builds when precision can wait for a focused rebuild.
   */
  fast?: boolean;
  /** Force analysis tier (default: auto by node count). */
  analysisTier?: AnalysisTier;
  /** Skip writing the SQLite serve index. */
  noIndex?: boolean;
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
  timing: { totalMs: number; stages: StageTimings };
  reparsed: number;
  reused: number;
  /** Files skipped via mtime+size fingerprint (subset of reused). */
  statHits: number;
  totalFiles: number;
  /** Stat+hash of every file in the corpus — input for the freshness snapshot. */
  fileStats: FileStat[];
  resolveStats: ResolveResult['stats'];
  /** Present when the TypeScript Compiler API resolver ran (TS/JS files). */
  tsc?: {
    files: number;
    calls: number;
    jsx: number;
    heritage: number;
    resolved: number;
    shards?: number;
    /** Files whose checker output was reused from the tsc cache (change-scoped
     * downstream, gap-closure 2c). Subset of `files`. */
    reusedFiles?: number;
  };
  /** Present when a SCIP index was ingested. */
  scip?: { documents: number; references: number; resolved: number; tool?: string };
  /** SQLite index write result. */
  index?: { ok: boolean; path?: string; reason?: string };
  warnings: string[];
  /** Architecture role hits extracted during the parse already paid for. */
  fileRoles: AstRoleHit[];
}

export async function buildGraph(options: BuildOptions): Promise<BuildResult> {
  const timer = new StageTimer();
  timer.start('total');
  const root = path.resolve(options.root);
  const exclude = mergeExcludes(root, options.exclude);
  timer.start('discover');
  const files = discover({
    root,
    only: options.only,
    exclude,
    paths: options.paths,
  });
  timer.end('discover');

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

  // The toolchain grammar set is a determinism input too: an HCL grammar change
  // can change the Terraform structure extracted, so it belongs in the
  // reproducibility fingerprint alongside the source grammars.
  const grammars = `${grammarSetVersion()}+${toolchainGrammarSetVersion()}`;
  const cache = loadCache(root, {
    toolVersion: VERSION,
    grammars,
    disabled: options.noCache,
  });

  // Hash every discovered file (mtime+size fast path → content hash) and split
  // into reuse vs reparse. The stat is taken *before* the read so a mid-read
  // edit shows up as a stat mismatch on the next freshness probe.
  timer.start('hash');
  const hashes = new Map<string, string>();
  const fileStats: FileStat[] = [];
  const toParse: DiscoveredFile[] = [];
  const reused: FileParse[] = [];
  const buildWarnings: string[] = [];
  let statHits = 0;
  const pendingHash: { file: DiscoveredFile; size: number; mtimeMs: number }[] = [];
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

    // Fast path: unchanged mtime+size → reuse parse without reading bytes.
    const byStat = options.noCache
      ? undefined
      : cache.getByStat(file.rel, stat.mtimeMs, stat.size);
    if (byStat) {
      hashes.set(file.rel, byStat.hash);
      if (byStat.parse.hash !== byStat.hash) byStat.parse.hash = byStat.hash;
      fileStats.push({
        rel: file.rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: byStat.hash,
      });
      reused.push(byStat.parse);
      statHits++;
      continue;
    }

    // Defer content hashing to a parallel batch (below) for files that miss
    // the mtime fast path — big monorepos spend real time in sequential reads.
    pendingHash.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // Parallel content hash for the pending set.
  if (pendingHash.length) {
    const jobs = pendingHash.map((p) => ({ rel: p.file.rel, abs: p.file.abs }));
    const results = await hashFilesParallel(jobs, options.jobs);
    const byRel = new Map(results.map((r) => [r.rel, r]));
    // Stable order: process pendingHash in discovery order (already sorted).
    for (const p of pendingHash) {
      const r = byRel.get(p.file.rel);
      if (!r || !r.ok) continue;
      hashes.set(p.file.rel, r.hash);
      fileStats.push({
        rel: p.file.rel,
        size: p.size,
        mtimeMs: p.mtimeMs,
        hash: r.hash,
      });
      const cached = cache.get(p.file.rel, r.hash);
      if (cached) {
        reused.push(cached);
        cache.set(p.file.rel, cached, { mtimeMs: p.mtimeMs, size: p.size });
      } else {
        toParse.push(p.file);
      }
    }
  }
  timer.end('hash');

  timer.start('parse');
  const parsedNew = await parseFiles(toParse, {
    jobs: options.jobs,
    inline: options.inline,
    onProgress: options.onParseProgress,
    grammarsDir: options.grammarsDir,
    memoryBudgetMb: limits.memoryBudgetMb,
  });
  timer.end('parse');
  checkMemoryBudget('parse', limits.memoryBudgetMb);
  for (const p of parsedNew) {
    // Never persist a failed parse: a transient parse-runtime crash (e.g. a
    // corrupted wasm heap) would otherwise poison the cache for that content
    // hash and every later build would reuse the empty parse instead of
    // re-parsing the file.
    if (p.defs.length === 0 && p.warnings?.some((w) => w.startsWith('parse failed:'))) continue;
    const st = fileStats.find((f) => f.rel === p.rel);
    cache.set(p.rel, p, st ? { mtimeMs: st.mtimeMs, size: st.size } : undefined);
  }

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
  timer.start('resolve');
  const moduleResolver = buildModuleResolver(root, new Set(parses.map((p) => p.rel)));
  const resolved = resolve(parses, moduleResolver);
  timer.end('resolve');
  checkMemoryBudget('resolve', limits.memoryBudgetMb);

  // Package manifests (package.json / go.mod) → package nodes + dep import edges.
  // Runs after source resolve so package hubs participate in centrality/areas.
  const manifests = extractManifests(root, {
    exclude,
    paths: options.paths,
  });
  if (manifests.files > 0) {
    const byId = new Map(resolved.nodes.map((n) => [n.id, n]));
    for (const n of manifests.nodes) {
      if (!byId.has(n.id)) {
        byId.set(n.id, n);
        resolved.nodes.push(n);
      }
    }
    const edgeById = new Map(resolved.edges.map((e) => [e.id, e]));
    for (const e of manifests.edges) {
      if (!edgeById.has(e.id)) {
        edgeById.set(e.id, e);
        resolved.edges.push(e);
      }
    }
    resolved.nodes.sort((a, b) => a.id.localeCompare(b.id));
    resolved.edges.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
    );
  }

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
  const skipTsc = options.noTsc || options.fast;
  let tsFiles = skipTsc
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
  timer.start('tsc');
  if (tsFiles.length) {
    // Shard by nearest tsconfig/package.json so monorepos never pay for one
    // giant Program over every package.
    const shards = shardTsProjects(root, tsFiles);
    let filesCovered = 0;
    let calls = 0;
    let jsx = 0;
    let heritage = 0;
    let resolvedCount = 0;
    let tscReusedFiles = 0;
    const coveredAll = new Set<string>();
    const preciseAll: GraphEdge[] = [];

    // Change-scoped downstream (gap-closure 2c): per-file checker results are
    // cached under a key covering the file's content, its transitive import
    // closure, and the shard's ambient surface — so a warm refresh re-walks
    // only the changed files and their reverse-dependency closure instead of
    // the whole corpus. assembleTsResult re-merges cached + fresh partials in
    // original file order, so the output is byte-identical to a full walk
    // (enforced by incremental-identity.test.ts).
    const tscCache = loadTscCache(root, { toolVersion: VERSION, disabled: options.noCache });
    const cfgFingerprint = tsConfigFingerprint(root);

    for (const shard of shards) {
      const ambientFiles = shard.files.filter((f) => tscCache.isAmbient(f.rel, hashes.get(f.rel)!, f.abs));
      const ambientHash = ambientFingerprint(
        ambientFiles.map((f) => ({ rel: f.rel, hash: hashes.get(f.rel)! })),
        cfgFingerprint,
      );
      const keys = tscKeys(shard.files.map((f) => f.rel), hashes, resolved.importsByFile, ambientHash);

      const partials = new Map<string, TsFilePartial>();
      const walkFiles: typeof shard.files = [];
      for (const f of shard.files) {
        const cached = tscCache.get(f.rel, keys.get(f.rel)!);
        if (cached) {
          partials.set(f.rel, cached);
          tscReusedFiles++;
        } else {
          walkFiles.push(f);
        }
      }
      // Ambient files must be in the program even when their own results are
      // cached — their global declarations shape checker answers everywhere.
      const walkRels = new Set(walkFiles.map((f) => f.rel));
      const extraRoots = ambientFiles.filter((f) => !walkRels.has(f.rel));
      const fresh = tsWalkFiles(root, walkFiles, shard.files, extraRoots, resolved.nodes);
      for (const [rel, partial] of fresh) {
        partials.set(rel, partial);
        tscCache.set(rel, hashes.get(rel)!, keys.get(rel)!, partial);
      }

      const res = assembleTsResult(shard.files.map((f) => f.rel), partials, resolved.nodes);
      if (res.stats.files === 0) continue;
      filesCovered += res.stats.files;
      calls += res.stats.calls;
      jsx += res.stats.jsx;
      heritage += res.stats.heritage;
      resolvedCount += res.stats.resolved;
      for (const f of res.coveredFiles) coveredAll.add(f);
      preciseAll.push(...res.edges);
    }

    tscCache.prune(new Set(tsFiles.map((f) => f.rel)));
    tscCache.save();

    if (filesCovered > 0) {
      edges = mergePreciseEdges(edges, preciseAll, coveredAll, nodeFileById);
      for (const f of coveredAll) preciseCoveredFiles.add(f);
      if (!resolvers.includes('tsc')) resolvers.unshift('tsc');
      tscStats = {
        files: filesCovered,
        calls,
        jsx,
        heritage,
        resolved: resolvedCount,
        shards: shards.length,
        reusedFiles: tscReusedFiles,
      };
    }
    checkMemoryBudget('typescript resolution', limits.memoryBudgetMb);
  }
  timer.end('tsc');

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

  // Documentation / example-env text nodes for semantic ask (not AST-parsed).
  const docs = discoverDocs({
    root,
    exclude,
    paths: options.paths,
  });
  for (const d of docs) {
    try {
      const st = fs.statSync(d.abs);
      const hash = hashBytes(fs.readFileSync(d.abs));
      hashes.set(d.rel, hash);
      fileStats.push({ rel: d.rel, size: st.size, mtimeMs: st.mtimeMs, hash });
    } catch {
      /* skip unreadable docs */
    }
  }
  const docNodes = documentNodesFromDocs(docs);
  if (docNodes.length) nodes = [...nodes, ...docNodes];

  // Structural extraction over the same discovered set (engine/toolchain/).
  // The `document` nodes above stay — they remain the semantic-ask surface —
  // and this adds the *structure*: resources, workloads, jobs, images, charts.
  //
  // NB: this reads `docs`, not the source corpus. Registering `.tf`/`.yaml` as
  // source languages would change file counts that feed billing tiers, so the
  // toolchain corpus is deliberately kept separate.
  timer.start('toolchain');
  const fileNodesByPath = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'file') fileNodesByPath.set(node.file.replace(/\\/g, '/'), node.id);
  }
  const toolchainResult = await extractToolchain(docs, { fileNodes: fileNodesByPath });
  if (toolchainResult.nodes.length) nodes = [...nodes, ...toolchainResult.nodes];
  timer.end('toolchain');

  // Analyse → centrality/areas/surprise (test/coverage edges excluded from these).
  timer.start('analyze');
  const graphEdges = toolchainResult.edges.length
    ? [...linked.edges, ...toolchainResult.edges]
    : linked.edges;
  const analysis = analyze(nodes, graphEdges, {
    cluster: options.cluster,
    tier: options.analysisTier,
  });
  timer.end('analyze');
  checkMemoryBudget('analysis', limits.memoryBudgetMb);

  const languages = [
    ...new Set([
      ...parses.map((p) => p.lang),
      ...docNodes.map((n) => n.lang),
      ...toolchainResult.nodes.map((n) => n.lang),
    ]),
  ].sort();
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
      analysisTier: analysis.tier,
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

  // Hub blast-radius summaries (cheap agent answers for "what breaks if X changes").
  graph.summaries = buildSummaries(graph);

  // Deterministic open facts (contracts / invariants / characterization) are
  // cheap AST-level work and ship on every build so `vg facts` works without a
  // second pass. `--deep` remains the switch for heavier semantic layers.
  {
    const facts = buildFacts(parses, analysis.nodes, analysis.edges);
    if (facts.length) graph.facts = facts;
  }
  // Grounding (default on).
  if (!options.noGround) {
    const grounding = groundGraph(analysis.nodes, analysis.edges, parses);
    if (grounding.length) graph.grounding = grounding;
  }

  let indexResult: BuildResult['index'];
  if (!options.noIndex) {
    timer.start('index');
    const wr = writeGraphIndex(root, graph);
    indexResult = { ok: wr.ok, path: wr.ok ? wr.path : undefined, reason: wr.reason };
    timer.end('index');
  }

  timer.end('total');
  const stages = timer.snapshot();

  return {
    graph,
    timing: { totalMs: stages.total ?? 0, stages },
    reparsed: parsedNew.length,
    reused: reused.length,
    statHits,
    totalFiles: files.length,
    fileStats,
    resolveStats: resolved.stats,
    tsc: tscStats,
    scip: scipStats,
    index: indexResult,
    warnings,
    fileRoles: fileRolesFromParses(parses),
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

/**
 * blake3 over the sorted (path, content-hash) list — the corpus identity.
 * Includes documentation / env-example files (in `hashes`) as well as parsed
 * source, so README edits invalidate the map identity and embedding cache.
 */
function computeCorpusHash(parses: FileParse[], hashes: Map<string, string>): string {
  const fromParses = parses.map((p) => [p.rel, hashes.get(p.rel) ?? p.hash] as const);
  const fromHashes = [...hashes.entries()].map(([rel, hash]) => [rel, hash] as const);
  const byRel = new Map<string, string>();
  for (const [rel, hash] of [...fromParses, ...fromHashes]) byRel.set(rel, hash);
  const list = [...byRel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hashString(canonicalize(list));
}

