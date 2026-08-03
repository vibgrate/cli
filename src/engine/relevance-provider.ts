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

export interface RelevanceAnalysis {
  version: string;
  topics: RelevanceTopic[];
  expansions: RelevanceExpansion[];
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
  return { version: raw.version, topics, expansions };
}
