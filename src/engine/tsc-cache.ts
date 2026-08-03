import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { cacheDir } from './cache.js';
import { stableStringify } from './serialize.js';
import type { TsFilePartial } from './ts-resolver.js';

/**
 * Incremental cache for the tsc precise-resolution rung — the change-scoped
 * downstream stage of VG gap-closure item 2c. The parse cache made parse
 * incremental; this makes the single most expensive downstream stage (the
 * ts.Program + checker walk, ~70% of warm-refresh time) scale with change
 * size instead of repo size.
 *
 * Soundness: a file's checker output can depend only on (a) its own content,
 * (b) the content of files it transitively imports, and (c) ambient
 * declarations (`.d.ts` files and `declare global` / `declare module`
 * blocks), which shape checker answers program-wide without any import edge.
 * The per-file cache key therefore hashes all three, so any change that could
 * alter the output invalidates the entry — an over-approximation, never an
 * under-approximation. The mutation-corpus byte-identity gate
 * (incremental-identity.test.ts) enforces warm ≡ cold over this cache.
 */

// /1: initial version.
const TSC_CACHE_VERSION = 'vg-tsc-cache/1';

const AMBIENT_RE = /\bdeclare\s+(global|module)\b/;

interface TscEntry {
  /** Content hash the ambient flag (and key, if present) was computed from. */
  hash: string;
  /** File contributes ambient declarations (.d.ts / declare global / declare module). */
  ambient: boolean;
  /** Full invalidation key (own hash + import closure + ambient hash). */
  key?: string;
  partial?: TsFilePartial;
}

interface TscCacheFile {
  version: string;
  toolVersion: string;
  ts: string;
  entries: Record<string, TscEntry>;
}

export interface TscCache {
  /** The cached per-file result, iff the invalidation key matches. */
  get(rel: string, key: string): TsFilePartial | undefined;
  set(rel: string, hash: string, key: string, partial: TsFilePartial): void;
  /**
   * Whether a file contributes ambient declarations. Reuses the stored flag
   * when the content hash matches; otherwise re-reads the file (changed files
   * only — cheap) and re-scans.
   */
  isAmbient(rel: string, hash: string, abs: string): boolean;
  /** Drop entries for files no longer present. */
  prune(currentRels: Set<string>): void;
  save(): void;
}

function tscCachePath(root: string): string {
  return path.join(cacheDir(root), 'tsc-cache.json');
}

export function loadTscCache(root: string, opts: { toolVersion: string; disabled?: boolean }): TscCache {
  const file = tscCachePath(root);
  let data: TscCacheFile = {
    version: TSC_CACHE_VERSION,
    toolVersion: opts.toolVersion,
    ts: ts.version,
    entries: {},
  };

  if (!opts.disabled && fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as TscCacheFile;
      if (
        loaded.version === TSC_CACHE_VERSION &&
        loaded.toolVersion === opts.toolVersion &&
        loaded.ts === ts.version &&
        loaded.entries
      ) {
        data = loaded;
      }
    } catch {
      /* corrupt cache — start fresh */
    }
  }

  return {
    get(rel, key) {
      if (opts.disabled) return undefined;
      const entry = data.entries[rel];
      return entry && entry.key === key ? entry.partial : undefined;
    },
    set(rel, hash, key, partial) {
      const ambient = data.entries[rel]?.hash === hash ? data.entries[rel].ambient : detectAmbient(rel, abs$(root, rel));
      data.entries[rel] = { hash, ambient, key, partial };
    },
    isAmbient(rel, hash, abs) {
      const entry = data.entries[rel];
      if (entry && entry.hash === hash) return entry.ambient;
      const ambient = detectAmbient(rel, abs);
      // Record hash+ambient now (key/partial filled in after a walk); a later
      // `set` for the same hash reuses this flag without re-reading the file.
      data.entries[rel] = { hash, ambient };
      return ambient;
    },
    prune(currentRels) {
      for (const rel of Object.keys(data.entries)) {
        if (!currentRels.has(rel)) delete data.entries[rel];
      }
    },
    save() {
      if (opts.disabled) return;
      fs.mkdirSync(cacheDir(root), { recursive: true });
      fs.writeFileSync(file, stableStringify(data, 0));
    },
  };
}

function abs$(root: string, rel: string): string {
  return path.join(root, rel);
}

function detectAmbient(rel: string, abs: string): boolean {
  if (rel.endsWith('.d.ts')) return true;
  try {
    return AMBIENT_RE.test(fs.readFileSync(abs, 'utf8'));
  } catch {
    // Unreadable → treat as ambient so it always invalidates rather than
    // silently going stale.
    return true;
  }
}

/**
 * A stable fingerprint of the effective compiler configuration: the fully
 * resolved tsconfig option set (extends chains flattened), so a config edit
 * anywhere in the chain invalidates every entry.
 */
export function tsConfigFingerprint(root: string): string {
  const configPath =
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.base.json');
  if (!configPath) return sha('none');
  try {
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    return sha(stableStringify(parsed?.options ?? 'unparsed', 0));
  } catch {
    return sha('unparsed');
  }
}

/**
 * Per-file invalidation keys for a set of TS/JS files, from the heuristic
 * resolver's file-level import graph. Each key covers the file's own content
 * hash, the content hashes of its transitive import closure, and the shared
 * ambient hash (all ambient files + resolved tsconfig + compiler version).
 */
export function tscKeys(
  rels: string[],
  hashes: Map<string, string>,
  importsByFile: Map<string, Set<string>>,
  ambientHash: string,
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const rel of rels) {
    // Transitive import closure, restricted to hashed corpus files. Iterative
    // BFS; cycles terminate via the visited set.
    const closure: string[] = [];
    const visited = new Set<string>([rel]);
    const queue = [rel];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const dep of importsByFile.get(cur) ?? []) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        if (hashes.has(dep)) closure.push(dep);
        queue.push(dep);
      }
    }
    closure.sort();
    const lines = closure.map((c) => `${c}\x00${hashes.get(c)}`);
    keys.set(rel, sha(`${TSC_CACHE_VERSION}\n${ambientHash}\n${rel}\x00${hashes.get(rel)}\n${lines.join('\n')}`));
  }
  return keys;
}

/** The shared ambient component: every ambient file's (rel, hash) plus the
 * resolved compiler configuration and compiler version. */
export function ambientFingerprint(
  ambient: Array<{ rel: string; hash: string }>,
  configFingerprint: string,
): string {
  const lines = ambient
    .map((a) => `${a.rel}\x00${a.hash}`)
    .sort()
    .join('\n');
  return sha(`${configFingerprint}\n${ts.version}\n${lines}`);
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
