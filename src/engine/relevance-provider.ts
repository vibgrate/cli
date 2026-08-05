/**
 * Optional relevance-provider seam for ask / Task Capsule seed ranking.
 *
 * A relevance provider is an OPTIONAL, separately installed local module that
 * analyzes a natural-language question and returns weighted expansion terms
 * with provenance (plus inferred topics). When present, its expansions join
 * the built-in concept lexicon (engine/concepts.ts) inside `queryGraph`'s
 * term preparation; when absent (the default install), nothing changes —
 * the deterministic lexicon path is the complete, supported baseline.
 *
 * Loading mirrors the optional-embedder pattern (engine/embeddings.ts):
 *  - `VIBGRATE_NO_KERNEL=1` disables the seam entirely (off by default).
 *  - `VIBGRATE_RELEVANCE_PATH` points at a provider module (a file, or a
 *    directory containing `index.js`).
 *  - Otherwise the default module location is probed:
 *    `$XDG_CACHE_HOME|~/.cache /vibgrate/modules/relevance/index.js`.
 * The module contract: it exports `createRelevanceProvider()` returning
 * `{ version(): string, analyzeQuery(q: string): RelevanceAnalysis }`.
 *
 * Trust boundary: provider output is sanitized here — terms lowercased,
 * weights clamped to [0,1], expansions whose provenance is a weak process
 * verb dropped (they could re-open the `add*` grab-bag failure the term-role
 * model closed), and the total capped — so a buggy or adversarial module can
 * widen vocabulary but never bypass the ranking invariants. Every failure
 * path degrades to `null` (no provider), never to an error: relevance
 * analysis is an enhancement, not a dependency.
 *
 * Determinism: given the same question and the same provider version, the
 * sanitized analysis is deterministic; the provider version is surfaced so
 * capsules can record it as ranking provenance.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WEAK_TERMS } from './concepts.js';

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

export interface RelevanceProvider {
  version(): string;
  analyzeQuery(question: string): RelevanceAnalysis;
  /** Optional build-time enrichment: deterministic topic tags for one node
   *  (path + identifier evidence). Providers without it still work. */
  tagNode?(input: { qualifiedName: string; file: string }): string[];
}

/** Upper bound on sanitized expansions accepted from a provider. */
const MAX_PROVIDER_EXPANSIONS = 24;
/** Caps on the hierarchical fields, same posture as expansions. */
const MAX_PROVIDER_PATHS = 6;
const MAX_PROVIDER_LEVELS = 8;
const MAX_PROVIDER_TERMS = 10;
const MAX_PROVIDER_VENDORS = 8;
const MAX_PROVIDER_CORRECTIONS = 8;
const MAX_PROVIDER_FILES = 8;
const MAX_PROVIDER_STANDARDS = 4;
const MAX_PROVIDER_CATEGORIES = 10;
/** A category is a lowercase slug from the site vocabulary — nothing else. */
const CATEGORY_SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
/**
 * A file hint is a filename, a path fragment or an extension — never an
 * absolute path, a parent traversal, or a glob. The capsule prints these, so
 * a provider must not be able to smuggle in something that reads as an
 * instruction or points outside the repository.
 */
const FILE_HINT = /^(?!\/|~|\.\.)[A-Za-z0-9._*/-]{1,48}$/;
/** A path segment is a slug: lowercase, digits, dash. Anything else is dropped. */
const PATH_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

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

/**
 * Run the provider over a question and sanitize the result. Returns `null`
 * when no provider is available or its output is unusable; the caller passes
 * the analysis into `queryGraph({ relevance })` as-is.
 */
export async function analyzeQuestion(question: string): Promise<RelevanceAnalysis | null> {
  const provider = await loadRelevanceProvider();
  if (!provider) return null;
  try {
    return sanitizeAnalysis(provider.analyzeQuery(question));
  } catch {
    return null;
  }
}

/** Enforce the trust boundary on raw provider output (exported for tests). */
export function sanitizeAnalysis(raw: RelevanceAnalysis): RelevanceAnalysis | null {
  if (!raw || typeof raw.version !== 'string') return null;
  const seen = new Set<string>();
  const expansions: RelevanceExpansion[] = [];
  for (const e of raw.expansions ?? []) {
    const term = String(e?.term ?? '').toLowerCase().trim();
    const from = String(e?.from ?? '').toLowerCase().trim();
    const weight = Number(e?.weight);
    if (!term || !from || term.includes(' ')) continue;
    // A weak process verb as provenance means the provider expanded the ACTION
    // ("add", "create"), not the topic — exactly the grab-bag failure the
    // term-role model suppresses. Never accept those.
    if (WEAK_TERMS.has(from) || WEAK_TERMS.has(term)) continue;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    expansions.push({ term, from, weight: Math.min(1, weight) });
    if (expansions.length >= MAX_PROVIDER_EXPANSIONS) break;
  }
  const topics = (raw.topics ?? [])
    .filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.score))
    .map((t) => ({ id: t.id, score: Math.max(0, Math.min(1, t.score)) }));

  // Hierarchical fields (provider schema 4). Same trust posture as
  // expansions: shapes validated, scores clamped, everything capped, and a
  // malformed entry is dropped rather than repaired — a provider can widen
  // vocabulary and name a domain, never smuggle in a path the host will
  // treat as structure it did not verify.
  const clamp01 = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : 0);
  const cleanFiles = (raw: unknown, cap: number): string[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((f): f is string => typeof f === 'string' && FILE_HINT.test(f) && !f.includes('..'))
      .slice(0, cap);
  const cleanStandards = (raw: unknown, cap: number): RelevanceStandard[] =>
    (Array.isArray(raw) ? raw : [])
      .filter(
        (st): st is RelevanceStandard =>
          !!st &&
          typeof st.name === 'string' &&
          st.name.length > 0 &&
          st.name.length <= 80 &&
          typeof st.publisher === 'string' &&
          st.publisher.length <= 80 &&
          validPath(st.node),
      )
      .map((st) => ({
        name: st.name,
        publisher: st.publisher,
        node: st.node,
        kind: st.kind === 'regulation' ? 'regulation' : 'standard',
        categories: cleanCategories(st.categories, MAX_PROVIDER_CATEGORIES),
      }))
      .slice(0, cap);
  const cleanCategories = (raw: unknown, cap: number): string[] => {
    const out: string[] = [];
    for (const c of Array.isArray(raw) ? raw : []) {
      const slug = String(c ?? '').toLowerCase().trim();
      if (!CATEGORY_SLUG.test(slug) || out.includes(slug)) continue;
      out.push(slug);
      if (out.length >= cap) break;
    }
    return out;
  };
  const cleanTerms = (raw: unknown, cap: number): string[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 40)
      .map((t) => t.toLowerCase())
      .slice(0, cap);
  const validPath = (p: unknown): p is string =>
    typeof p === 'string' && p.length > 0 && p.length <= 120 && p.split('/').every((seg) => PATH_SEGMENT.test(seg));

  const taxonomy: RelevanceTaxonomyMatch[] = [];
  for (const m of raw.taxonomy ?? []) {
    if (!m || !validPath(m.path)) continue;
    const levels = (m.levels ?? [])
      .filter((l) => l && validPath(l.path) && typeof l.id === 'string')
      .slice(0, MAX_PROVIDER_LEVELS)
      .map((l) => ({ id: l.id, path: l.path, score: clamp01(l.score), terms: cleanTerms(l.terms, MAX_PROVIDER_TERMS) }));
    // A path with no chain is unusable for prefix matching — drop it.
    if (!levels.length || levels[levels.length - 1]!.path !== m.path) continue;
    taxonomy.push({
      path: m.path,
      levels,
      score: clamp01(m.score),
      evidence: Number.isFinite(Number(m.evidence)) ? Math.max(0, Number(m.evidence)) : 0,
      via: (m.via ?? []).filter((v): v is string => typeof v === 'string' && v.length <= 80).slice(0, 8),
      terms: cleanTerms(m.terms, MAX_PROVIDER_TERMS),
      files: cleanFiles(m.files, MAX_PROVIDER_FILES),
      standards: cleanStandards(m.standards, MAX_PROVIDER_STANDARDS),
    });
    if (taxonomy.length >= MAX_PROVIDER_PATHS) break;
  }

  const vendors: RelevanceVendorMatch[] = [];
  for (const v of raw.vendors ?? []) {
    const name = String(v?.name ?? '').toLowerCase().trim();
    const from = String(v?.from ?? '').toLowerCase().trim();
    if (!name || !from || name.length > 60) continue;
    vendors.push({
      name,
      from,
      ...(validPath(v.node) ? { node: v.node } : {}),
      topic: typeof v.topic === 'string' ? v.topic : '',
      score: clamp01(v.score),
      files: cleanFiles(v.files, MAX_PROVIDER_FILES),
    });
    if (vendors.length >= MAX_PROVIDER_VENDORS) break;
  }

  const corrections: RelevanceCorrection[] = [];
  for (const c of raw.corrections ?? []) {
    const from = String(c?.from ?? '').toLowerCase().trim();
    const to = String(c?.to ?? '').toLowerCase().trim();
    const distance = Number(c?.distance);
    if (!from || !to || from === to || from.length > 60 || to.length > 60) continue;
    if (!Number.isInteger(distance) || distance < 1 || distance > 3) continue;
    corrections.push({ from, to, distance });
    if (corrections.length >= MAX_PROVIDER_CORRECTIONS) break;
  }

  const files = cleanFiles(raw.files, MAX_PROVIDER_FILES);
  const standards = cleanStandards(raw.standards, MAX_PROVIDER_STANDARDS);
  const categories = cleanCategories(raw.categories, MAX_PROVIDER_CATEGORIES);

  return { version: raw.version, topics, expansions, taxonomy, vendors, corrections, files, standards, categories };
}
