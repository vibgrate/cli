import * as path from 'node:path';
import { readTextFile, pathExists, findPackageJsonFiles, readJsonFile, FileCache } from '../../core-open/index.js';
import type { PackageJson, DependencyGraphResult, DuplicatedPackage, PhantomDependency } from '../../core-open/index.js';

interface LockEntry {
  name: string;
  version: string;
}

/**
 * Parse pnpm-lock.yaml (v6/v9 format) by extracting package names and versions
 * from the `packages:` section. Lightweight regex-based — no YAML parser needed.
 */
function parsePnpmLock(content: string): LockEntry[] {
  const entries: LockEntry[] = [];
  // Match lines like "  /lodash@4.17.21:" or "  lodash@4.17.21:" (pnpm v9)
  // Also handles scoped: "  /@scope/pkg@1.0.0:"
  const regex = /^\s+\/?(@?[^@\s][^@\s]*?)@(\d+\.\d+\.\d+[^:\s]*)\s*:/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] && match[2]) {
      entries.push({ name: match[1], version: match[2] });
    }
  }
  return entries;
}

/**
 * Parse package-lock.json (v2/v3) by reading `packages` or `dependencies` keys.
 */
function parseNpmLock(content: string): LockEntry[] {
  const entries: LockEntry[] = [];
  try {
    const lock = JSON.parse(content);

    // v2/v3 format: `packages` keyed by path like "node_modules/lodash"
    if (lock.packages && typeof lock.packages === 'object') {
      for (const [key, value] of Object.entries(lock.packages)) {
        if (key === '') continue; // root entry
        const v = value as { version?: string };
        if (v.version) {
          const name = key.replace(/^node_modules\//, '').replace(/.*node_modules\//, '');
          entries.push({ name, version: v.version });
        }
      }
    }
    // v1 fallback: `dependencies`
    else if (lock.dependencies && typeof lock.dependencies === 'object') {
      function walkDeps(deps: Record<string, { version?: string; dependencies?: Record<string, unknown> }>) {
        for (const [name, data] of Object.entries(deps)) {
          if (data.version) entries.push({ name, version: data.version });
          if (data.dependencies) walkDeps(data.dependencies as typeof deps);
        }
      }
      walkDeps(lock.dependencies);
    }
  } catch { /* invalid JSON */ }
  return entries;
}

/**
 * Parse yarn.lock by extracting package name + resolved version pairs.
 */
function parseYarnLock(content: string): LockEntry[] {
  const entries: LockEntry[] = [];
  // Match blocks like: "lodash@^4.17.0:\n  version "4.17.21""
  const regex = /^"?(@?[^\s"@]+)@[^:]+:\s*\n\s+version\s+"([^"]+)"/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] && match[2]) {
      entries.push({ name: match[1], version: match[2] });
    }
  }
  return entries;
}

export async function scanDependencyGraph(rootDir: string, cache?: FileCache): Promise<DependencyGraphResult> {
  const result: DependencyGraphResult = {
    lockfileType: null,
    totalUnique: 0,
    totalInstalled: 0,
    duplicatedPackages: [],
    phantomDependencies: [],
  };

  // Try lockfiles in order of preference
  let entries: LockEntry[] = [];

  const pnpmLock = path.join(rootDir, 'pnpm-lock.yaml');
  const npmLock = path.join(rootDir, 'package-lock.json');
  const yarnLock = path.join(rootDir, 'yarn.lock');

  const _pathExists = cache ? (p: string) => cache.pathExists(p) : pathExists;
  const _readTextFile = cache ? (p: string) => cache.readTextFile(p) : readTextFile;

  if (await _pathExists(pnpmLock)) {
    result.lockfileType = 'pnpm';
    const content = await _readTextFile(pnpmLock);
    entries = parsePnpmLock(content);
  } else if (await _pathExists(npmLock)) {
    result.lockfileType = 'npm';
    const content = await _readTextFile(npmLock);
    entries = parseNpmLock(content);
  } else if (await _pathExists(yarnLock)) {
    result.lockfileType = 'yarn';
    const content = await _readTextFile(yarnLock);
    entries = parseYarnLock(content);
  }

  if (entries.length === 0) return result;

  // Build version map
  const versionMap = new Map<string, Set<string>>();
  for (const entry of entries) {
    const existing = versionMap.get(entry.name);
    if (existing) {
      existing.add(entry.version);
    } else {
      versionMap.set(entry.name, new Set([entry.version]));
    }
  }

  result.totalInstalled = entries.length;
  result.totalUnique = versionMap.size;

  // Find duplicated packages (multiple versions)
  const duplicated: DuplicatedPackage[] = [];
  for (const [name, versions] of versionMap) {
    if (versions.size > 1) {
      duplicated.push({
        name,
        versions: [...versions].sort(),
        consumers: versions.size,
      });
    }
  }
  duplicated.sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));
  result.duplicatedPackages = duplicated;

  // Detect phantom dependencies:
  // packages used in package.json deps that don't appear in the lockfile
  const lockedNames = new Set(versionMap.keys());
  const pkgFiles = cache
    ? await cache.findPackageJsonFiles(rootDir)
    : await findPackageJsonFiles(rootDir);
  const phantoms = new Set<string>();
  const phantomDetails: PhantomDependency[] = [];
  for (const pjPath of pkgFiles) {
    try {
      const pj = cache
        ? await cache.readJsonFile<PackageJson>(pjPath)
        : await readJsonFile<PackageJson>(pjPath);
      const relPath = path.relative(rootDir, pjPath);
      for (const section of ['dependencies', 'devDependencies'] as const) {
        const deps = pj[section];
        if (!deps) continue;
        for (const [name, version] of Object.entries(deps)) {
          const ver = typeof version === 'string' ? version : '';
          if (!lockedNames.has(name) && !ver.startsWith('workspace:')) {
            phantoms.add(name);
            phantomDetails.push({ package: name, spec: ver, sourcePath: relPath });
          }
        }
      }
    } catch { /* skip */ }
  }
  result.phantomDependencies = [...phantoms].sort();
  result.phantomDependencyDetails = phantomDetails.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.package.localeCompare(b.package));

  return result;
}
