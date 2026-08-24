/**
 * Relevance-provider seam for ask / Task Capsule seed ranking.
 *
 * Since the 2026-08 relevance relocation, the separately installed local
 * module (`@vibgrate/relevance`, auto-provisioned by the CLI) IS the ranking
 * engine: `rankQuestion` hands it the ask plus a name-only symbol view of
 * the loaded graph and receives an ordered, provenance-annotated seed list
 * and the plain-language concept map. When the module is unavailable —
 * offline install failure, explicit decline, `VIBGRATE_NO_KERNEL=1`, or a
 * pre-ranking module version — callers fall back to the host's mechanical
 * exact-name matcher (engine/query.ts) and proceed unchanged.
 *
 * Loading mirrors the optional-embedder pattern (engine/embeddings.ts):
 *  - `VIBGRATE_NO_KERNEL=1` disables the seam entirely.
 *  - `VIBGRATE_RELEVANCE_PATH` points at a provider module (a file, or a
 *    directory containing `index.js`).
 *  - Otherwise the default module location is probed:
 *    `$XDG_CACHE_HOME|~/.cache /vibgrate/modules/relevance/index.js`.
 * The module contract: it exports `createRelevanceProvider()` returning
 * `{ version(), analyzeQuery(q), tagNode?(input), rankSymbols?(q, symbols, opts) }`.
 *
 * Trust boundary: everything a module returns is sanitized here before it
 * can shape a capsule. A ranking may only ORDER symbols the loaded graph
 * actually has (`sanitizeRank`: unknown ids dropped, scores validated,
 * every printable string stripped of control characters and length-capped).
 * Every failure path degrades to `null` (→ mechanical fallback), never to an
 * error: the module is the brain, not a dependency.
 *
 * Determinism: given the same question, graph, and provider version, the
 * sanitized ranking is deterministic; the provider version is surfaced so
 * capsules can record it as ranking provenance.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface RelevanceExpansion {
  /** Single lowercase word, ready for identifier-part matching. */
  term: string;
  /** The question token/phrase (or topic id) that produced it. */
  from: string;
  /** 0..1 relative confidence; scales the expansion's scoring contribution. */
  weight: number;
}

export interface RelevanceTopic {
  id: string;
  /** 0..1, normalized within one analysis. */
  score: number;
}

/** One level of a matched taxonomy path, root-first. */
export interface RelevanceTaxonomyLevel {
  id: string;
  path: string;
  /** 0..1 — never lower than the levels beneath it. */
  score: number;
  /** This level's own vocabulary. */
  terms: string[];
}

/** A hierarchical match: the most specific node plus its ancestor chain. */
export interface RelevanceTaxonomyMatch {
  /** "infrastructure/networking/dns/cname" */
  path: string;
  levels: RelevanceTaxonomyLevel[];
  score: number;
  /** Absolute evidence behind the match, not relative to other matches. */
  evidence: number;
  /** What matched — "~" prefixes a fuzzy repair. */
  via: string[];
  /** The matched node's OWN vocabulary, for explaining the domain. */
  terms: string[];
  /** Filenames and extensions this node's work lives in, nearest first. */
  files: string[];
  /** Standards governing this node, current revision first. */
  standards: RelevanceStandard[];
}

/** A product the ask names, including through a misspelling. */
export interface RelevanceVendorMatch {
  name: string;
  from: string;
  node?: string;
  topic: string;
  score: number;
  /** Filenames and extensions this vendor's configuration lives in. */
  files: string[];
}

/** A standard governing the matched area, at the revision the pack tracks. */
export interface RelevanceStandard {
  name: string;
  publisher: string;
  node: string;
  /** "standard" or "regulation". */
  kind: string;
  /** Lowercase category slugs from the website's own vocabulary. */
  categories: string[];
}

/** A misspelling the provider resolved. */
export interface RelevanceCorrection {
  from: string;
  to: string;
  distance: number;
}

export interface RelevanceAnalysis {
  version: string;
  topics: RelevanceTopic[];
  expansions: RelevanceExpansion[];
  /** Hierarchical matches, most specific first. Absent from older providers. */
  taxonomy?: RelevanceTaxonomyMatch[];
  vendors?: RelevanceVendorMatch[];
  corrections?: RelevanceCorrection[];
  /** Every file hint the analysis implies, most specific first. */
  files?: string[];
  /** Standards governing what the ask is about, most specific node first. */
  standards?: RelevanceStandard[];
  /** Deduped lowercase category slugs across those standards. */
  categories?: string[];
}

/** One graph symbol, as handed to the provider's ranker: identity and name
 *  material only — never source contents. */
export interface RankableSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  file: string;
  importance: number;
}

export interface RankOptions {
  limit?: number;
  priorQuestion?: string | null;
  topicTags?: Record<string, readonly string[]> | null;
}

export interface RankedSeed {
  id: string;
  score: number;
  why: string;
}

/** The provider's full ranking answer (schema 5), pre-sanitization. */
export interface RankResult {
  version: string;
  hasContent: boolean;
  seeds: RankedSeed[];
  conceptMap: string[];
}

export interface RelevanceProvider {
  version(): string;
  analyzeQuery(question: string): RelevanceAnalysis;
  /** Optional build-time enrichment: deterministic topic tags for one node
   *  (path + identifier evidence). Providers without it still work. */
  tagNode?(input: { qualifiedName: string; file: string }): string[];
  /**
   * Schema-5: rank the given symbols for one ask. When present, the module
   * IS the relevance engine — the host delegates seed selection here and
   * keeps only mechanical name matching as its module-less fallback. A
   * provider without it is treated as no ranking engine at all.
   */
  rankSymbols?(question: string, symbols: RankableSymbol[], opts?: RankOptions): RankResult;
}

function disabled(): boolean {
  const v = process.env.VIBGRATE_NO_KERNEL;
  return v === '1' || v === 'true';
}

/** Default install location for the optional relevance module (shared with
 *  the install flow in install/relevance-module.ts). */
export function relevanceModuleDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'modules', 'relevance');
}

function defaultModulePath(): string {
  return path.join(relevanceModuleDir(), 'index.js');
}

function candidatePaths(): string[] {
  const custom = process.env.VIBGRATE_RELEVANCE_PATH;
  if (custom) {
    const p = path.resolve(custom);
    try {
      if (fs.statSync(p).isDirectory()) return [path.join(p, 'index.js')];
    } catch {
      /* fall through — treat as a file path */
    }
    return [p];
  }
  return [defaultModulePath()];
}

let cached: RelevanceProvider | null | undefined;

/** Reset the memoized provider (tests only). */
export function resetRelevanceProviderCache(): void {
  cached = undefined;
}

/**
 * Load the optional relevance provider. Memoized per process; returns `null`
 * when disabled, not installed, or the module fails to load or violates the
 * contract — callers treat `null` as "no analysis" and proceed unchanged.
 */
export async function loadRelevanceProvider(): Promise<RelevanceProvider | null> {
  if (cached !== undefined) return cached;
  cached = null;
  if (disabled()) return cached;
  for (const p of candidatePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = (await import(pathToFileURL(p).href)) as {
        createRelevanceProvider?: () => RelevanceProvider;
      };
      const provider = mod.createRelevanceProvider?.();
      if (provider && typeof provider.version === 'function' && typeof provider.analyzeQuery === 'function') {
        cached = provider;
        return cached;
      }
    } catch {
      // A broken module must never break ask/capsule — fall through to null.
    }
  }
  return cached;
}

/** Sanitized module ranking, ready for `queryGraph({ ranked })`. */
export interface SanitizedRank {
  version: string;
  hasContent: boolean;
  seeds: RankedSeed[];
  conceptMap: string[];
}

const MAX_RANK_SEEDS = 64;
const MAX_CONCEPT_LINES = 24;
const MAX_WHY_LEN = 240;
const MAX_LINE_LEN = 400;

/** Printable one-line string, control characters stripped, length-capped. */
function cleanLine(raw: unknown, cap: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * Enforce the trust boundary on a provider ranking (exported for tests).
 * Seed ids must name symbols the LOADED graph actually has — a module can
 * order the host's own symbols, never invent one — and every string the
 * capsule will print is stripped and capped. Malformed entries drop; a
 * malformed envelope drops the whole ranking (→ mechanical fallback).
 */
export function sanitizeRank(raw: RankResult, validIds: ReadonlySet<string>): SanitizedRank | null {
  if (!raw || typeof raw.version !== 'string' || typeof raw.hasContent !== 'boolean') return null;
  if (!Array.isArray(raw.seeds) || !Array.isArray(raw.conceptMap)) return null;
  const seen = new Set<string>();
  const seeds: RankedSeed[] = [];
  for (const s of raw.seeds) {
    const id = typeof s?.id === 'string' ? s.id : '';
    const score = Number(s?.score);
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    if (!Number.isFinite(score) || score <= 0) continue;
    seen.add(id);
    seeds.push({ id, score, why: cleanLine(s.why, MAX_WHY_LEN) });
    if (seeds.length >= MAX_RANK_SEEDS) break;
  }
  const conceptMap = raw.conceptMap
    .map((l) => cleanLine(l, MAX_LINE_LEN))
    .filter((l) => l.length > 0)
    .slice(0, MAX_CONCEPT_LINES);
  return { version: raw.version.slice(0, 120), hasContent: raw.hasContent, seeds, conceptMap };
}

/** Per-graph symbol view for the ranker, cached on graph object identity. */
const symbolViewCache = new WeakMap<object, { symbols: RankableSymbol[]; ids: Set<string> }>();

function symbolViewOf(graph: {
  nodes: Array<{ id: string; name: string; qualifiedName: string; file: string; kind: string; importance: number }>;
}): { symbols: RankableSymbol[]; ids: Set<string> } {
  const hit = symbolViewCache.get(graph);
  if (hit) return hit;
  const symbols: RankableSymbol[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    symbols.push({ id: n.id, name: n.name, qualifiedName: n.qualifiedName, file: n.file, importance: n.importance });
    ids.add(n.id);
  }
  const view = { symbols, ids };
  symbolViewCache.set(graph, view);
  return view;
}

/**
 * Rank a question over a graph's symbols via the installed module. Returns
 * `null` when no module is installed, the installed module predates the
 * ranking API, or its output fails sanitization — callers fall back to the
 * host's mechanical matcher and proceed unchanged. Every failure path is a
 * degrade, never an error.
 */
export async function rankQuestion(
  graph: { nodes: Array<{ id: string; name: string; qualifiedName: string; file: string; kind: string; importance: number }> },
  question: string,
  opts: { limit?: number; priorQuestion?: string | null; topicTags?: Map<string, readonly string[]> | null } = {},
): Promise<SanitizedRank | null> {
  const provider = await loadRelevanceProvider();
  if (!provider || typeof provider.rankSymbols !== 'function') return null;
  try {
    const { symbols, ids } = symbolViewOf(graph);
    const topicTags = opts.topicTags ? Object.fromEntries(opts.topicTags) : null;
    const raw = provider.rankSymbols(question, symbols, {
      limit: opts.limit,
      priorQuestion: opts.priorQuestion ?? null,
      topicTags,
    });
    return sanitizeRank(raw, ids);
  } catch {
    return null;
  }
}

