/**
 * Project scoping for memory — fail closed.
 *
 * Project-scoped memories are keyed by the git toplevel of the working
 * directory. When no toplevel can be resolved (not a repo, git missing, a
 * bare `--cwd` that does not exist) the key is the `NO_PROJECT` sentinel:
 * memories can still be *listed*, but they are never *injected*, so a memory
 * written in one project cannot leak into an unrelated one.
 *
 * The git runner is injectable so tests never spawn a subprocess.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashString } from '../engine/hash.js';
import { NO_PROJECT } from './types.js';

/** Runs `git rev-parse --show-toplevel`-style commands; returns stdout or null. */
export type GitRunner = (args: string[], cwd: string) => string | null;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    if (!fs.existsSync(cwd)) return null;
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
};

/** Normalise a root for hashing: realpath when possible, no trailing separator. */
export function normalizeRoot(root: string): string {
  let r = root;
  try {
    r = fs.realpathSync.native(root);
  } catch {
    r = path.resolve(root);
  }
  r = r.replace(/\\/g, '/');
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

/** `[A-Za-z0-9._-]` survive; runs of anything else collapse to one `-`; ≤ 64 chars. */
export function sanitizeIdentity(name: string): string {
  const s = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64);
  return s || 'root';
}

/**
 * Stable key for a project root: `<sanitised basename>-<hash16>`. Same repo
 * on the same machine → same key on every run; different machines with the
 * same path → same key (the hash is over the normalised path, not inode).
 */
export function projectKey(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) return NO_PROJECT;
  const normalized = normalizeRoot(trimmed);
  const base = path.posix.basename(normalized) || 'root';
  return `${sanitizeIdentity(base)}-${hashString(normalized).slice(0, 16)}`;
}

export interface ResolveProjectOptions {
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
}

export interface ResolvedProject {
  /** Absolute root, or null when unresolved. */
  root: string | null;
  key: string;
  resolved: boolean;
  source: 'env' | 'explicit' | 'git' | 'none';
}

/**
 * Resolve the project root for `cwd`: explicit `root` > `VG_MEMORY_PROJECT_ROOT`
 * > git toplevel > unresolved (fail closed).
 */
export function resolveProject(cwd: string, opts: ResolveProjectOptions & { root?: string } = {}): ResolvedProject {
  const env = opts.env ?? process.env;
  const git = opts.git ?? defaultGitRunner;
  if (opts.root && opts.root.trim()) {
    const r = path.resolve(opts.root.trim());
    return { root: r, key: projectKey(r), resolved: true, source: 'explicit' };
  }
  const fromEnv = env.VG_MEMORY_PROJECT_ROOT?.trim();
  if (fromEnv) {
    const r = path.resolve(fromEnv);
    return { root: r, key: projectKey(r), resolved: true, source: 'env' };
  }
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  const top = out?.split(/\r?\n/)[0]?.trim();
  if (top) return { root: top, key: projectKey(top), resolved: true, source: 'git' };
  return { root: null, key: NO_PROJECT, resolved: false, source: 'none' };
}
