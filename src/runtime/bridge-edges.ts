/**
 * Cross-workspace bridge edges (Fusion Runtime Phase 6).
 *
 * schemaVersion: bridge-edge/0
 *
 * Conservative edges between federation members when one package.json
 * depends on another member's package name (workspace:*, link:, file:, or
 * exact version). Low-confidence edges are marked so high-stakes capsules
 * can exclude them. Pure over injected package.json readers.
 */

import * as path from 'node:path';
import { repositoryIdFromRoot } from './paths.js';

export const BRIDGE_EDGE_SCHEMA_VERSION = 'bridge-edge/0' as const;

export type BridgeKind =
  | 'workspace-package'
  | 'path-dependency'
  | 'git-submodule'
  | 'openapi-ref'
  | 'compose-service'
  | 'protobuf-import'
  | 'graphql-ref';

export interface BridgeEdge {
  schemaVersion: typeof BRIDGE_EDGE_SCHEMA_VERSION;
  fromRepositoryId: string;
  toRepositoryId: string;
  fromRoot: string;
  toRoot: string;
  kind: BridgeKind;
  /** 0..1 — workspace:* is high; bare version match is medium. */
  confidence: number;
  /** Short, secret-free evidence string for transparency UIs. */
  evidence: string;
  packageName?: string;
}

export interface BridgeMember {
  root: string;
  repositoryId?: string;
}

export interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Build bridge edges among `members` by reading each member's package.json.
 * Deterministic: sorted by (fromRoot, toRoot, packageName).
 */
export function discoverBridgeEdges(
  members: BridgeMember[],
  readPackageJson: (root: string) => PackageManifest | null,
  options: { minConfidence?: number } = {},
): BridgeEdge[] {
  const min = options.minConfidence ?? 0;
  const packages = new Map<string, { root: string; repositoryId: string; name: string }>();

  for (const m of members) {
    const root = path.resolve(m.root);
    const pkg = readPackageJson(root);
    const name = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
    if (!name) continue;
    const repositoryId = m.repositoryId ?? repositoryIdFromRoot(root);
    packages.set(name, { root, repositoryId, name });
  }

  const edges: BridgeEdge[] = [];
  const seen = new Set<string>();

  for (const m of members) {
    const fromRoot = path.resolve(m.root);
    const fromId = m.repositoryId ?? repositoryIdFromRoot(fromRoot);
    const pkg = readPackageJson(fromRoot);
    if (!pkg) continue;

    const deps = collectDeps(pkg);
    for (const [depName, range] of deps) {
      const target = packages.get(depName);
      if (!target) continue;
      if (target.root === fromRoot) continue;

      const { kind, confidence } = classifyDependency(range, fromRoot, target.root);
      if (confidence < min) continue;

      const key = `${fromId}->${target.repositoryId}:${depName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        schemaVersion: BRIDGE_EDGE_SCHEMA_VERSION,
        fromRepositoryId: fromId,
        toRepositoryId: target.repositoryId,
        fromRoot,
        toRoot: target.root,
        kind,
        confidence,
        evidence: `${path.basename(fromRoot)} depends on ${depName} (${range})`,
        packageName: depName,
      });
    }
  }

  return edges.sort(
    (a, b) =>
      a.fromRoot.localeCompare(b.fromRoot) ||
      a.toRoot.localeCompare(b.toRoot) ||
      (a.packageName ?? '').localeCompare(b.packageName ?? ''),
  );
}

/** High-confidence bridges only (workspace:/link:/file: or confidence ≥ 0.8). */
export function highConfidenceBridges(edges: BridgeEdge[]): BridgeEdge[] {
  return edges.filter((e) => e.confidence >= 0.8);
}

function collectDeps(pkg: PackageManifest): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const block = pkg[field];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof name === 'string' && typeof range === 'string') out.push([name, range]);
    }
  }
  // Stable order for determinism.
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function classifyDependency(
  range: string,
  fromRoot: string,
  toRoot: string,
): { kind: BridgeKind; confidence: number } {
  const r = range.trim();
  if (r.startsWith('workspace:') || r.startsWith('link:')) {
    return { kind: 'workspace-package', confidence: 0.95 };
  }
  if (r.startsWith('file:')) {
    // Confirm the file: path resolves under the target when possible.
    const rel = r.slice('file:'.length).trim();
    try {
      const resolved = path.resolve(fromRoot, rel);
      if (path.resolve(resolved) === path.resolve(toRoot)) {
        return { kind: 'path-dependency', confidence: 0.9 };
      }
    } catch {
      /* ignore */
    }
    return { kind: 'path-dependency', confidence: 0.75 };
  }
  // Same monorepo package name without workspace protocol — medium confidence.
  return { kind: 'workspace-package', confidence: 0.55 };
}

/** Parse package.json text into a manifest (or null). */
export function parsePackageManifest(raw: string): PackageManifest | null {
  try {
    const o = JSON.parse(raw) as PackageManifest;
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch {
    return null;
  }
}
