/**
 * Automatic workspace discovery (Fusion Runtime Phase 6).
 *
 * Finds additional package roots under a primary project without inventing
 * product names — package.json workspaces, pnpm-workspace.yaml, git
 * submodules, and VS Code `.code-workspace` folders. Pure over an injected
 * filesystem so unit tests never touch the real disk layout of the monorepo.
 *
 * Conservative: only returns paths that look like package roots (have
 * package.json or are listed explicitly). No network.
 */

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { normalizeWorkspaceRoots, type WorkspaceRoot } from '../engine/workspace-roots.js';

export const DISCOVER_WORKSPACES_VERSION = 'discover-workspaces/0' as const;

export interface DiscoverFs {
  readFile(absPath: string): string | null;
  /** Directory entries (names only). Missing dir → []. */
  readdir(absPath: string): string[];
  isDirectory(absPath: string): boolean;
  exists(absPath: string): boolean;
}

export type DiscoverSource =
  | 'package-workspaces'
  | 'pnpm-workspace'
  | 'git-submodule'
  | 'code-workspace'
  | 'explicit';

export interface DiscoveredRoot {
  root: string;
  label: string;
  source: DiscoverSource;
}

export interface DiscoverWorkspacesResult {
  schemaVersion: typeof DISCOVER_WORKSPACES_VERSION;
  primaryRoot: string;
  /** Unique absolute roots including the primary. Sorted by path. */
  roots: DiscoveredRoot[];
}

/**
 * Discover workspace package roots under `primaryRoot`. Always includes the
 * primary itself as `source: 'explicit'`.
 */
export function discoverWorkspaceRoots(
  primaryRoot: string,
  fs: DiscoverFs,
  options: { maxDepth?: number; maxRoots?: number } = {},
): DiscoverWorkspacesResult {
  const primary = path.resolve(primaryRoot);
  const maxDepth = options.maxDepth ?? 4;
  const maxRoots = options.maxRoots ?? 64;
  const byRoot = new Map<string, DiscoveredRoot>();

  const add = (abs: string, source: DiscoverSource, label?: string): void => {
    const root = path.resolve(abs);
    if (byRoot.has(root)) {
      // Prefer a more specific source label if we already have explicit.
      return;
    }
    if (byRoot.size >= maxRoots) return;
    byRoot.set(root, {
      root,
      label: label ?? (path.basename(root) || root),
      source,
    });
  };

  add(primary, 'explicit', path.basename(primary) || primary);

  // package.json "workspaces"
  for (const dir of expandPackageWorkspaces(primary, fs, maxDepth)) {
    add(dir, 'package-workspaces');
  }

  // pnpm-workspace.yaml
  for (const dir of expandPnpmWorkspace(primary, fs, maxDepth)) {
    add(dir, 'pnpm-workspace');
  }

  // .gitmodules
  for (const dir of expandGitSubmodules(primary, fs)) {
    add(dir, 'git-submodule');
  }

  // *.code-workspace next to primary or inside it
  for (const dir of expandCodeWorkspace(primary, fs)) {
    add(dir, 'code-workspace');
  }

  const roots = [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
  return {
    schemaVersion: DISCOVER_WORKSPACES_VERSION,
    primaryRoot: primary,
    roots,
  };
}

/** Convert discovery result into normalizeWorkspaceRoots-compatible paths. */
export function discoveredToWorkspaceRoots(result: DiscoverWorkspacesResult): WorkspaceRoot[] {
  return normalizeWorkspaceRoots(
    result.roots.map((r) => r.root),
    result.primaryRoot,
  );
}

// ── expanders ──────────────────────────────────────────────────────────────

function expandPackageWorkspaces(primary: string, fs: DiscoverFs, maxDepth: number): string[] {
  const pkgPath = path.join(primary, 'package.json');
  const raw = fs.readFile(pkgPath);
  if (!raw) return [];
  let pkg: { workspaces?: unknown };
  try {
    pkg = JSON.parse(raw) as { workspaces?: unknown };
  } catch {
    return [];
  }
  const patterns = workspacePatterns(pkg.workspaces);
  return expandGlobPatterns(primary, patterns, fs, maxDepth);
}

function workspacePatterns(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  }
  if (workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages)) {
    return ((workspaces as { packages: unknown[] }).packages).filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0,
    );
  }
  return [];
}

function expandPnpmWorkspace(primary: string, fs: DiscoverFs, maxDepth: number): string[] {
  const raw = fs.readFile(path.join(primary, 'pnpm-workspace.yaml'));
  if (!raw) return [];
  const patterns: string[] = [];
  // Minimal YAML: lines under `packages:` that look like `  - 'packages/*'`
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^\S/.test(line) && !/^\s/.test(line)) break; // next top-level key
      const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
      if (m?.[1]) patterns.push(m[1].trim());
    }
  }
  return expandGlobPatterns(primary, patterns, fs, maxDepth);
}

function expandGitSubmodules(primary: string, fs: DiscoverFs): string[] {
  const raw = fs.readFile(path.join(primary, '.gitmodules'));
  if (!raw) return [];
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    if (!m?.[1]) continue;
    const abs = path.resolve(primary, m[1].trim());
    if (fs.exists(abs) && fs.isDirectory(abs)) out.push(abs);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function expandCodeWorkspace(primary: string, fs: DiscoverFs): string[] {
  const out: string[] = [];
  const candidates = [
    ...fs.readdir(primary).filter((n) => n.endsWith('.code-workspace')).map((n) => path.join(primary, n)),
  ];
  // Also accept a single workspace file named after the folder.
  for (const file of candidates) {
    const raw = fs.readFile(file);
    if (!raw) continue;
    let doc: { folders?: Array<{ path?: string; name?: string }> };
    try {
      doc = JSON.parse(raw) as { folders?: Array<{ path?: string; name?: string }> };
    } catch {
      continue;
    }
    const base = path.dirname(file);
    for (const folder of doc.folders ?? []) {
      if (typeof folder.path !== 'string' || !folder.path.trim()) continue;
      const abs = path.resolve(base, folder.path.trim());
      if (fs.exists(abs) && fs.isDirectory(abs)) out.push(abs);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Expand simple workspace globs (star segments, double-star walk, or exact
 * relative paths). No full micromatch — keep deterministic and dependency-free.
 */
function expandGlobPatterns(
  primary: string,
  patterns: string[],
  fs: DiscoverFs,
  maxDepth: number,
): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p || p.startsWith('..')) continue; // never climb out via pattern
    if (p.includes('*')) {
      for (const hit of expandSimpleGlob(primary, p, fs, maxDepth)) {
        if (looksLikePackageRoot(hit, fs)) out.add(hit);
      }
    } else {
      const abs = path.resolve(primary, p);
      if (fs.exists(abs) && fs.isDirectory(abs) && looksLikePackageRoot(abs, fs)) out.add(abs);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function expandSimpleGlob(primary: string, pattern: string, fs: DiscoverFs, maxDepth: number): string[] {
  // Support: packages/*, packages/*/*, apps/**
  const parts = pattern.split('/').filter(Boolean);
  let currents = [primary];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next: string[] = [];
    const isLast = i === parts.length - 1;
    for (const cur of currents) {
      if (part === '**') {
        // One-level recursive: all dirs up to maxDepth from cur.
        for (const d of walkDirs(cur, fs, Math.min(maxDepth, 3))) next.push(d);
        continue;
      }
      if (part === '*') {
        for (const name of fs.readdir(cur)) {
          const abs = path.join(cur, name);
          if (fs.isDirectory(abs)) next.push(abs);
        }
        continue;
      }
      const abs = path.join(cur, part);
      if (fs.exists(abs) && (isLast ? fs.isDirectory(abs) || fs.exists(abs) : fs.isDirectory(abs))) {
        next.push(abs);
      }
    }
    currents = next;
    if (!currents.length) break;
  }
  return currents.filter((d) => fs.isDirectory(d));
}

function walkDirs(root: string, fs: DiscoverFs, depth: number): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];
  for (const name of fs.readdir(root)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
    const abs = path.join(root, name);
    if (!fs.isDirectory(abs)) continue;
    out.push(abs);
    out.push(...walkDirs(abs, fs, depth - 1));
  }
  return out;
}

function looksLikePackageRoot(dir: string, fs: DiscoverFs): boolean {
  return fs.exists(path.join(dir, 'package.json'));
}

/** Node fs adapter for production callers. */
export function nodeDiscoverFs(): DiscoverFs {
  return {
    readFile(absPath) {
      try {
        return nodeFs.readFileSync(absPath, 'utf8');
      } catch {
        return null;
      }
    },
    readdir(absPath) {
      try {
        return nodeFs.readdirSync(absPath).sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    },
    isDirectory(absPath) {
      try {
        return nodeFs.statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    },
    exists(absPath) {
      try {
        return nodeFs.existsSync(absPath);
      } catch {
        return false;
      }
    },
  };
}
