import * as fs from 'node:fs';
import * as path from 'node:path';
import { stableStringify } from './serialize.js';
import type { CasStore } from './cas.js';
import type { FileParse } from './types.js';

/**
 * Incremental parse cache. Maps a file's content hash to its parsed
 * symbol/edge tables, so a rebuild re-parses only files whose content actually
 * changed (VG-DEVELOPMENT-PLAN Phase 0.4). Lives under `.vibgrate/cache/` and is
 * gitignored — never part of the committed artifact.
 *
 * The cache is a pure performance optimisation: a reused FileParse is identical
 * to a freshly-parsed one (parsing is pure over content), so the graph is
 * byte-identical whether or not the cache was warm. CI-enforced by the
 * mutation-corpus identity gate (incremental-identity.test.ts): warm
 * incremental rebuild ≡ cold full rebuild, byte for byte, across
 * edit/add/delete/rename/touch mutations and the production refresh path.
 *
 * This file is a path-keyed *hint* over the content-addressed store
 * (`cas.ts`): a miss here falls through to the CAS by content hash, so a
 * rename, a sibling branch, or another worktree reuses the parse; a fresh
 * parse is written to both. The CAS is never pruned to the current tree —
 * only this per-checkout hint is — which is what lets `main → feature → main`
 * find every `main`-only parse still there.
 */

// Bumped to /4: optional mtime+size fingerprint for stat-skip fast path.
const CACHE_VERSION = 'vg-parse-cache/5';

interface CacheEntry {
  hash: string;
  mtimeMs?: number;
  size?: number;
  parse: FileParse;
}

interface CacheFile {
  version: string;
  toolVersion: string;
  grammars: string;
  entries: Record<string, CacheEntry>;
}

export interface ParseCache {
  /**
   * Parse for `rel` at content `hash`. `lang` enables the content-addressed
   * fallback (a parse is a function of bytes *and* language).
   */
  get(rel: string, hash: string, lang?: string): FileParse | undefined;
  /** Fast path: mtime+size match → reuse parse without re-reading bytes. */
  getByStat(rel: string, mtimeMs: number, size: number): { parse: FileParse; hash: string } | undefined;
  set(rel: string, parse: FileParse, stat?: { mtimeMs: number; size: number }): void;
  /** Drop entries for files no longer present. */
  prune(currentRels: Set<string>): void;
  /** Every cached parse, sorted by rel — used to recover architecture roles. */
  allParses(): FileParse[];
  save(): void;
}

export function cacheDir(root: string): string {
  return path.join(root, '.vibgrate', 'cache');
}

function cachePath(root: string): string {
  return path.join(cacheDir(root), 'parse-cache.json');
}

export function loadCache(
  root: string,
  opts: { toolVersion: string; grammars: string; disabled?: boolean; cas?: CasStore | null },
): ParseCache {
  const cas = opts.cas ?? null;
  const file = cachePath(root);
  let data: CacheFile = {
    version: CACHE_VERSION,
    toolVersion: opts.toolVersion,
    grammars: opts.grammars,
    entries: {},
  };

  if (!opts.disabled && fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheFile;
      // Accept v3 → v4 (stat fields optional).
      if (
        (loaded.version === CACHE_VERSION || loaded.version === 'vg-parse-cache/3') &&
        loaded.toolVersion === opts.toolVersion &&
        loaded.grammars === opts.grammars &&
        loaded.entries
      ) {
        data = { ...loaded, version: CACHE_VERSION };
      }
    } catch {
      /* corrupt cache — start fresh */
    }
  }

  return {
    get(rel, hash, lang) {
      const entry = data.entries[rel];
      if (entry && entry.hash === hash) return entry.parse;
      if (!cas || !lang) return undefined;
      const shared = cas.getParse(hash, lang, rel);
      if (!shared) return undefined;
      // Warm the path hint so the next build takes the stat fast path.
      data.entries[rel] = { hash, parse: shared };
      return shared;
    },
    getByStat(rel, mtimeMs, size) {
      const entry = data.entries[rel];
      if (!entry) return undefined;
      if (entry.mtimeMs === mtimeMs && entry.size === size && entry.parse) {
        return { parse: entry.parse, hash: entry.hash };
      }
      return undefined;
    },
    set(rel, parse, stat) {
      data.entries[rel] = {
        hash: parse.hash,
        parse,
        mtimeMs: stat?.mtimeMs,
        size: stat?.size,
      };
      cas?.putParse(parse);
    },
    prune(currentRels) {
      for (const rel of Object.keys(data.entries)) {
        if (!currentRels.has(rel)) delete data.entries[rel];
      }
    },
    allParses() {
      return Object.keys(data.entries)
        .sort((a, b) => a.localeCompare(b))
        .map((rel) => data.entries[rel]!.parse);
    },
    save() {
      fs.mkdirSync(cacheDir(root), { recursive: true });
      fs.writeFileSync(file, stableStringify(data, 0));
    },
  };
}
