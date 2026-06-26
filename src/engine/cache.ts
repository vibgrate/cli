import * as fs from 'node:fs';
import * as path from 'node:path';
import { stableStringify } from './serialize.js';
import type { FileParse } from './types.js';

/**
 * Incremental parse cache. Maps a file's content hash to its parsed
 * symbol/edge tables, so a rebuild re-parses only files whose content actually
 * changed (VG-DEVELOPMENT-PLAN Phase 0.4). Lives under `.vibgrate/cache/` and is
 * gitignored — never part of the committed artifact.
 *
 * The cache is a pure performance optimisation: a reused FileParse is identical
 * to a freshly-parsed one (parsing is pure over content), so the graph is
 * byte-identical whether or not the cache was warm. `--no-cache` / `vg verify`
 * prove this.
 */

const CACHE_VERSION = 'vg-parse-cache/2';

interface CacheFile {
  version: string;
  toolVersion: string;
  grammars: string;
  entries: Record<string, { hash: string; parse: FileParse }>;
}

export interface ParseCache {
  get(rel: string, hash: string): FileParse | undefined;
  set(rel: string, parse: FileParse): void;
  /** Drop entries for files no longer present. */
  prune(currentRels: Set<string>): void;
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
  opts: { toolVersion: string; grammars: string; disabled?: boolean },
): ParseCache {
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
      // Invalidate wholesale if the tool or grammars changed — those are
      // determinism inputs, so a stale parse could differ from a fresh one.
      if (
        loaded.version === CACHE_VERSION &&
        loaded.toolVersion === opts.toolVersion &&
        loaded.grammars === opts.grammars &&
        loaded.entries
      ) {
        data = loaded;
      }
    } catch {
      /* corrupt cache — start fresh */
    }
  }

  return {
    get(rel, hash) {
      const entry = data.entries[rel];
      return entry && entry.hash === hash ? entry.parse : undefined;
    },
    set(rel, parse) {
      data.entries[rel] = { hash: parse.hash, parse };
    },
    prune(currentRels) {
      for (const rel of Object.keys(data.entries)) {
        if (!currentRels.has(rel)) delete data.entries[rel];
      }
    },
    save() {
      fs.mkdirSync(cacheDir(root), { recursive: true });
      fs.writeFileSync(file, stableStringify(data, 0));
    },
  };
}
