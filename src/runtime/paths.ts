/**
 * Global application paths for the Fusion Runtime (Phase 1).
 *
 * Generated artefacts (graph snapshots, parser caches, session transcripts)
 * must not land inside repositories by default. This module resolves the
 * platform-correct data / cache / runtime roots and content-addressed
 * per-repository store directories.
 *
 * Layout (defaults):
 *   Linux:   $XDG_DATA_HOME/vibgrate  | $XDG_CACHE_HOME/vibgrate  | $XDG_RUNTIME_DIR/vibgrate
 *   macOS:   ~/Library/Application Support/Vibgrate | ~/Library/Caches/Vibgrate
 *   Windows: %LOCALAPPDATA%\Vibgrate
 *
 * Pure path construction — no mkdir side effects. Callers create directories
 * when they write. Override roots via VIBGRATE_DATA_DIR / VIBGRATE_CACHE_DIR /
 * VIBGRATE_RUNTIME_DIR for tests and locked-down installs.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { shortId } from '../engine/hash.js';
import { branchGraphSnapshotId } from './git-ref.js';

const APP = 'vibgrate';
const APP_MAC = 'Vibgrate';
const APP_WIN = 'Vibgrate';

export type VibgratePathKind = 'data' | 'cache' | 'runtime';

export interface VibgratePaths {
  data: string;
  cache: string;
  runtime: string;
}

/**
 * Resolve the three global roots. Deterministic given env + platform + homedir.
 * Does not create directories.
 */
export function resolveVibgratePaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): VibgratePaths {
  return {
    data: overrideOr(env.VIBGRATE_DATA_DIR, () => defaultDataDir(env, platform, home)),
    cache: overrideOr(env.VIBGRATE_CACHE_DIR, () => defaultCacheDir(env, platform, home)),
    runtime: overrideOr(env.VIBGRATE_RUNTIME_DIR, () => defaultRuntimeDir(env, platform, home)),
  };
}

export function vibgrateDataDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return resolveVibgratePaths(env, platform, home).data;
}

export function vibgrateCacheDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return resolveVibgratePaths(env, platform, home).cache;
}

export function vibgrateRuntimeDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return resolveVibgratePaths(env, platform, home).runtime;
}

/**
 * Stable repository id from an absolute (or cwd-resolved) root path.
 * Used as the directory key under the global data store so two checkouts of
 * the same path share artefacts, while distinct paths stay isolated.
 */
export function repositoryIdFromRoot(root: string): string {
  const normalized = normalizeRoot(root);
  return shortId(`repo:${normalized}`);
}

/** Global store for a repository's generated artefacts (graphs, sessions, …). */
export function repositoryStoreDir(root: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  const id = repositoryIdFromRoot(root);
  return path.join(vibgrateDataDir(env, platform, home), 'repos', id);
}

/** Default path for a content-addressed graph snapshot inside the global store. */
export function globalGraphPath(root: string, snapshotId = 'current', env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return path.join(repositoryStoreDir(root, env, platform, home), 'graphs', `${snapshotId}.graph.json`);
}

/**
 * Path for a branch-keyed graph snapshot (Fusion §4.1.1).
 * Uses {@link branchGraphSnapshotId} so branch names become a single path segment.
 */
export function globalGraphPathForRef(
  root: string,
  gitRef: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): string {
  return globalGraphPath(root, branchGraphSnapshotId(gitRef), env, platform, home);
}

/** Daemon / session IPC directory (sockets, pid files). */
export function daemonDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string {
  return path.join(vibgrateRuntimeDir(env, platform, home), 'daemon');
}

function overrideOr(value: string | undefined, fallback: () => string): string {
  const trimmed = value?.trim();
  if (trimmed) return path.resolve(trimmed);
  return fallback();
}

function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_MAC);
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(base, APP_WIN);
  }
  const xdg = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  return path.join(xdg, APP);
}

function defaultCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', APP_MAC);
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(base, APP_WIN, 'Cache');
  }
  const xdg = env.XDG_CACHE_HOME?.trim() || path.join(home, '.cache');
  return path.join(xdg, APP);
}

function defaultRuntimeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    // macOS has no XDG_RUNTIME_DIR; keep sockets under Application Support.
    return path.join(home, 'Library', 'Application Support', APP_MAC, 'run');
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(base, APP_WIN, 'Run');
  }
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return path.join(xdg, APP);
  // Fallback when the session has no runtime dir (some CI / SSH setups).
  return path.join(home, '.local', 'state', APP, 'run');
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  // Windows: drive letters vary in case; normalize for stable ids.
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}
