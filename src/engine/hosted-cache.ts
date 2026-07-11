/**
 * On-disk TTL cache for hosted `/v1/lib/docs` answers, so repeat lookups of the same library
 * docs are instant and offline-tolerant. Lives under `.vibgrate/cache/` (gitignored, like the
 * parse cache) and is a pure performance layer: a cache miss falls through to `fetchHostedDocs`,
 * every failure path degrades to "no cache" (never throws, never blocks the local-first answer),
 * and entries expire after `ttlMs` so version bumps and catalog refreshes surface within a day.
 *
 * Keying is exact-request: name/targetId/query/verbosity/budget PLUS the resolved host and the
 * caller's DSN key id — a workspace-tier answer (which may include PRIVATE docs) is never served
 * to a different identity or an anonymous call from the cache.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir } from './cache.js';
import { fetchHostedDocs, hostedBase, type HostedDocsRequest, type HostedDocsResult, type HostedOptions } from './hosted.js';

const CACHE_VERSION = 'vg-hosted-docs/1';
/** Default freshness window — hosted docs change at most with catalog re-ingests. */
export const HOSTED_DOCS_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded file size: oldest entries are evicted beyond this. */
const MAX_ENTRIES = 64;

interface CacheEntry {
  at: number;
  result: HostedDocsResult;
}
interface CacheFile {
  version: string;
  entries: Record<string, CacheEntry>;
}

function cachePath(root: string): string {
  return path.join(cacheDir(root), 'hosted-docs.json');
}

/** Deterministic cache key over the request identity (see module doc for why auth is included). */
export function hostedDocsCacheKey(req: HostedDocsRequest, opts: HostedOptions = {}): string {
  const material = JSON.stringify([
    req.name ?? '',
    req.targetId ?? '',
    req.query ?? '',
    req.verbosity ?? '',
    req.maxTokens ?? 0,
    hostedBase(opts),
    opts.auth?.keyId ?? 'anon',
  ]);
  return createHash('sha256').update(material).digest('hex');
}

function loadFile(root: string): CacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(root), 'utf8')) as CacheFile;
    if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { version: CACHE_VERSION, entries: {} };
}

function saveFile(root: string, file: CacheFile): void {
  try {
    // Evict oldest beyond the cap so the file stays small.
    const keys = Object.keys(file.entries);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.sort((a, b) => file.entries[a].at - file.entries[b].at).slice(0, keys.length - MAX_ENTRIES)) {
        delete file.entries[k];
      }
    }
    fs.mkdirSync(cacheDir(root), { recursive: true });
    fs.writeFileSync(cachePath(root), JSON.stringify(file));
  } catch {
    /* a failed cache write must never fail the lookup */
  }
}

export interface HostedCacheOptions extends HostedOptions {
  /** Freshness window; entries older than this re-fetch. Default HOSTED_DOCS_TTL_MS. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Skip reading (still writes) — e.g. an explicit refresh. */
  bypass?: boolean;
}

/**
 * `fetchHostedDocs` behind the disk cache: a fresh hit answers instantly (flagged
 * `metadata.cached: true`); a miss fetches and caches only REAL answers (nulls — offline,
 * rate-capped, not found — are never cached, so the next call retries).
 */
export async function fetchHostedDocsCached(root: string, req: HostedDocsRequest, opts: HostedCacheOptions = {}): Promise<HostedDocsResult | null> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? HOSTED_DOCS_TTL_MS;
  const key = hostedDocsCacheKey(req, opts);
  const file = loadFile(root);

  if (!opts.bypass) {
    const hit = file.entries[key];
    if (hit && now() - hit.at < ttl && hit.result?.content) {
      return { ...hit.result, metadata: { ...(hit.result.metadata ?? {}), cached: true } };
    }
  }

  const result = await fetchHostedDocs(req, opts);
  if (result) {
    file.entries[key] = { at: now(), result };
    saveFile(root, file);
  }
  return result;
}
