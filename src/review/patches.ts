/**
 * Deterministic proposed-fix patches for `vg review --loop`.
 *
 * Only package.json declared-version bumps we can compute from a known
 * current → latest pair. No hosted model. No lockfile rewrite (that needs a
 * package manager). The human (or CI) refreshes the lockfile after the bump.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeterministicPatch {
  path: string;
  before: string;
  after: string;
  reason: string;
  packageName: string;
  fromVersion: string | null;
  toVersion: string;
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export function bumpDeclaredDependency(pkgJson: string, packageName: string, nextVersion: string): string | null {
  if (!packageName || !nextVersion || !VERSION.test(nextVersion)) return null;
  try {
    JSON.parse(pkgJson);
  } catch {
    return null;
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${escaped}"\\s*:\\s*")([^"]+)(")`);
  const match = pkgJson.match(re);
  if (!match) return null;
  const current = match[2] ?? '';
  if (declaredEquals(current, nextVersion)) return null;
  return pkgJson.replace(re, `$1${preservePrefix(current, nextVersion)}$3`);
}

export function patchesFromScanArtifact(root: string): DeterministicPatch[] {
  const file = path.join(root, '.vibgrate', 'scan_result.json');
  if (!fs.existsSync(file)) return [];
  let artifact: unknown;
  try {
    artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const deps = collectDriftedDeps(artifact);
  return patchesForManifests(root, deps);
}

export function patchesFromVersionPairs(
  root: string,
  pairs: { packageName: string; fromVersion?: string | null; toVersion: string | null | undefined }[],
): DeterministicPatch[] {
  const deps = pairs
    .filter((p): p is { packageName: string; fromVersion?: string | null; toVersion: string } =>
      Boolean(p.packageName && p.toVersion && VERSION.test(p.toVersion)),
    )
    .map((p) => ({ packageName: p.packageName, fromVersion: p.fromVersion ?? null, toVersion: p.toVersion }));
  return patchesForManifests(root, deps);
}

function patchesForManifests(
  root: string,
  deps: { packageName: string; fromVersion: string | null; toVersion: string }[],
): DeterministicPatch[] {
  const manifests = findPackageJsons(root);
  const out: DeterministicPatch[] = [];
  const seen = new Set<string>();
  for (const rel of manifests) {
    const abs = path.join(root, rel);
    let before: string;
    try {
      before = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let after = before;
    const reasons: string[] = [];
    for (const dep of deps) {
      const next = bumpDeclaredDependency(after, dep.packageName, dep.toVersion);
      if (!next || next === after) continue;
      const key = `${rel}\0${dep.packageName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      after = next;
      reasons.push(
        `${dep.packageName}${dep.fromVersion ? ` ${dep.fromVersion}` : ''} → ${dep.toVersion}`,
      );
    }
    if (after !== before) {
      out.push({
        path: rel,
        before,
        after,
        reason: `Declared dependency bump: ${reasons.join(', ')}. Refresh the lockfile with your package manager — this patch does not rewrite lockfiles.`,
        packageName: deps[0]?.packageName ?? 'dependencies',
        fromVersion: deps[0]?.fromVersion ?? null,
        toVersion: deps[0]?.toVersion ?? '',
      });
    }
  }
  return out;
}

function findPackageJsons(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 3) return;
    const abs = path.join(root, rel);
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.vibgrate') continue;
      const child = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(root, child);
      let st: fs.Stats;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isFile() && name === 'package.json') out.push(child);
      else if (st.isDirectory()) walk(child, depth + 1);
    }
  };
  walk('', 0);
  return out.sort();
}

function collectDriftedDeps(artifact: unknown): { packageName: string; fromVersion: string | null; toVersion: string }[] {
  const out: { packageName: string; fromVersion: string | null; toVersion: string }[] = [];
  if (!artifact || typeof artifact !== 'object') return out;
  const rec = artifact as Record<string, unknown>;
  const lists = [rec.dependencies, rec.topDependencies, rec.packages];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = String(row.package ?? row.name ?? '');
      const latest = String(row.latestStable ?? row.latestVersion ?? '');
      const current = row.resolvedVersion ?? row.currentVersion ?? row.version;
      if (!name || !VERSION.test(latest)) continue;
      const drift = String(row.drift ?? '');
      const majors = typeof row.majorsBehind === 'number' ? row.majorsBehind : 0;
      if (drift === 'current') continue;
      if (!drift && majors === 0 && current === latest) continue;
      out.push({
        packageName: name,
        fromVersion: typeof current === 'string' ? current : null,
        toVersion: latest,
      });
    }
  }
  return out;
}

function preservePrefix(declared: string, next: string): string {
  const prefix = declared.match(/^[\^~>=<\s]*/)?.[0] ?? '';
  return `${prefix}${next}`;
}

function declaredEquals(declared: string, next: string): boolean {
  return declared.replace(/^[\^~>=<\s]+/, '') === next;
}
