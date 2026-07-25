/**
 * Federated workspaces (Fusion Runtime Phase 6 foundation).
 *
 * A federation is a primary repository plus zero or more member roots that
 * share a local vgd session. Layout is declared in `.vibgrate/federation.json`
 * so multi-repo monorepos and sibling packages can register together without
 * inventing product names. When no file exists, {@link loadOrDiscoverFederation}
 * auto-discovers package workspaces / pnpm / submodules / `.code-workspace`
 * and attaches conservative package-dependency bridge edges.
 *
 * Schema: federation/0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { repositoryIdFromRoot, globalGraphPath, globalGraphPathForRef } from './paths.js';
import { detectGitRef } from './git-ref.js';
import { normalizeWorkspaceRoots } from '../engine/workspace-roots.js';
import {
  discoverBridgeEdges,
  highConfidenceBridges,
  parsePackageManifest,
  type BridgeEdge,
} from './bridge-edges.js';
import { discoverInterfaceBridges } from './interface-bridges.js';
import { discoverWorkspaceRoots, nodeDiscoverFs, type DiscoverFs } from './discover-workspaces.js';

export const FEDERATION_SCHEMA_VERSION = 'federation/0' as const;

export type FederationMemberRole = 'primary' | 'member';

export interface FederationMember {
  /** Absolute root path. */
  root: string;
  /** Optional human label (folder name by default). */
  label: string;
  role: FederationMemberRole;
  repositoryId: string;
  graphPath: string;
}

export interface FederatedWorkspace {
  schemaVersion: typeof FEDERATION_SCHEMA_VERSION;
  /** Absolute path of the primary root (where the federation file lives). */
  primaryRoot: string;
  members: FederationMember[];
  /**
   * Cross-member package dependency bridges (optional). High-stakes capsules
   * should prefer {@link highConfidenceBridges} only.
   */
  bridges?: BridgeEdge[];
}

export interface FederationFile {
  schemaVersion?: string;
  members?: Array<{ root?: string; label?: string; role?: string }>;
  bridges?: BridgeEdge[];
}

/**
 * Load `.vibgrate/federation.json` under `primaryRoot`, or synthesize a
 * single-member federation for the primary alone.
 */
export function loadFederation(primaryRoot: string, options: { requireFile?: boolean } = {}): FederatedWorkspace | null {
  const primary = path.resolve(primaryRoot);
  const file = federationPath(primary);
  if (!fs.existsSync(file)) {
    if (options.requireFile) return null;
    return singleMemberFederation(primary);
  }
  let raw: FederationFile;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FederationFile;
  } catch {
    return null;
  }
  return parseFederationFile(primary, raw);
}

/**
 * Load federation.json when present; otherwise auto-discover workspace package
 * roots and package-dependency bridges. Prefer this for host UIs / `vg code`
 * session start so monorepos work without a hand-written federation file.
 */
export function loadOrDiscoverFederation(
  primaryRoot: string,
  options: { discoverFs?: DiscoverFs; minBridgeConfidence?: number } = {},
): FederatedWorkspace {
  const primary = path.resolve(primaryRoot);
  const existing = loadFederation(primary, { requireFile: true });
  if (existing) {
    // File wins for membership; still compute bridges if absent.
    if (!existing.bridges?.length) {
      existing.bridges = bridgesForMembers(existing.members, options.minBridgeConfidence);
    }
    return existing;
  }

  const dfs = options.discoverFs ?? nodeDiscoverFs();
  const discovered = discoverWorkspaceRoots(primary, dfs);
  const roots = discovered.roots.map((r) => r.root);
  const fed = federationFromWorkspaceRoots(roots, { preferredPrimary: primary });
  fed.bridges = bridgesForMembers(fed.members, options.minBridgeConfidence);
  return fed;
}

function bridgesForMembers(members: FederationMember[], minConfidence = 0.5): BridgeEdge[] {
  const memberRefs = members.map((m) => ({ root: m.root, repositoryId: m.repositoryId }));
  const pkgEdges = discoverBridgeEdges(
    memberRefs,
    (root) => {
      try {
        const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        return parsePackageManifest(raw);
      } catch {
        return null;
      }
    },
    { minConfidence },
  );
  const ifaceEdges = discoverInterfaceBridges(
    memberRefs,
    {
      readFile(absPath) {
        try {
          return fs.readFileSync(absPath, 'utf8');
        } catch {
          return null;
        }
      },
      readdir(absPath) {
        try {
          return fs.readdirSync(absPath).sort((a, b) => a.localeCompare(b));
        } catch {
          return [];
        }
      },
      isDirectory(absPath) {
        try {
          return fs.statSync(absPath).isDirectory();
        } catch {
          return false;
        }
      },
    },
    { minConfidence },
  );
  // Merge package + interface bridges; stable unique by from/to/kind/evidence.
  const seen = new Set<string>();
  const out: BridgeEdge[] = [];
  for (const e of [...pkgEdges, ...ifaceEdges].sort(
    (a, b) =>
      a.fromRoot.localeCompare(b.fromRoot) ||
      a.toRoot.localeCompare(b.toRoot) ||
      a.kind.localeCompare(b.kind) ||
      a.evidence.localeCompare(b.evidence),
  )) {
    const key = `${e.fromRepositoryId}|${e.toRepositoryId}|${e.kind}|${e.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export { highConfidenceBridges, type BridgeEdge };

export function federationPath(primaryRoot: string): string {
  return path.join(path.resolve(primaryRoot), '.vibgrate', 'federation.json');
}

export function singleMemberFederation(primaryRoot: string): FederatedWorkspace {
  const primary = path.resolve(primaryRoot);
  const [ws] = normalizeWorkspaceRoots([primary], primary);
  return {
    schemaVersion: FEDERATION_SCHEMA_VERSION,
    primaryRoot: primary,
    members: [
      memberFromRoot(ws?.root ?? primary, 'primary', ws?.label ?? (path.basename(primary) || primary)),
    ],
  };
}

export function parseFederationFile(primaryRoot: string, raw: FederationFile): FederatedWorkspace | null {
  const primary = path.resolve(primaryRoot);
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.members) ? raw.members : [];
  if (!list.length) return singleMemberFederation(primary);

  const members: FederationMember[] = [];
  const seen = new Set<string>();
  let hasPrimary = false;

  for (const entry of list) {
    if (!entry || typeof entry.root !== 'string' || !entry.root.trim()) continue;
    const abs = path.resolve(primary, entry.root.trim());
    const id = repositoryIdFromRoot(abs);
    if (seen.has(id)) continue;
    seen.add(id);
    const role: FederationMemberRole = entry.role === 'primary' || abs === primary ? 'primary' : 'member';
    if (role === 'primary') hasPrimary = true;
    members.push(memberFromRoot(abs, role, typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : path.basename(abs) || abs));
  }

  if (!members.length) return singleMemberFederation(primary);
  if (!hasPrimary) {
    // Ensure the primary root is present and marked primary.
    const id = repositoryIdFromRoot(primary);
    if (!seen.has(id)) {
      members.unshift(memberFromRoot(primary, 'primary', path.basename(primary) || primary));
    } else {
      const existing = members.find((m) => m.repositoryId === id);
      if (existing) existing.role = 'primary';
    }
  }

  members.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
    return a.root.localeCompare(b.root);
  });

  const fed: FederatedWorkspace = {
    schemaVersion: FEDERATION_SCHEMA_VERSION,
    primaryRoot: primary,
    members,
  };
  if (Array.isArray(raw.bridges) && raw.bridges.length) {
    fed.bridges = raw.bridges
      .filter((b) => b && typeof b === 'object' && typeof b.fromRoot === 'string' && typeof b.toRoot === 'string')
      .map((b) => ({
        ...b,
        fromRoot: path.resolve(primary, b.fromRoot),
        toRoot: path.resolve(primary, b.toRoot),
      }));
  }
  return fed;
}

function memberFromRoot(root: string, role: FederationMemberRole, label: string): FederationMember {
  const git = detectGitRef(root);
  const graphPath = git.kind !== 'none' && git.ref ? globalGraphPathForRef(root, git.ref) : globalGraphPath(root);
  return {
    root,
    label,
    role,
    repositoryId: repositoryIdFromRoot(root),
    graphPath,
  };
}

/**
 * Build a federation from an explicit list of workspace folder paths (e.g. VS
 * Code multi-root `workspaceFolders`). First root (or `preferredPrimary`) is
 * primary; remaining roots are members. Pure over path math + git-ref detect.
 */
export function federationFromWorkspaceRoots(
  roots: string[],
  options: { preferredPrimary?: string } = {},
): FederatedWorkspace {
  const normalized = normalizeWorkspaceRoots(roots, options.preferredPrimary ?? roots[0] ?? process.cwd());
  if (!normalized.length) {
    const fallback = path.resolve(options.preferredPrimary ?? process.cwd());
    return singleMemberFederation(fallback);
  }
  const preferred = options.preferredPrimary?.trim()
    ? path.resolve(options.preferredPrimary.trim())
    : normalized[0]!.root;
  const primaryHit =
    normalized.find((r) => r.root === preferred) ??
    normalized.find((r) => r.id === repositoryIdFromRoot(preferred)) ??
    normalized[0]!;
  const primaryRoot = primaryHit.root;
  const members: FederationMember[] = normalized.map((ws) =>
    memberFromRoot(ws.root, ws.root === primaryRoot ? 'primary' : 'member', ws.label),
  );
  members.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
    return a.root.localeCompare(b.root);
  });
  return {
    schemaVersion: FEDERATION_SCHEMA_VERSION,
    primaryRoot,
    members,
  };
}

/**
 * Persist a federation under `primaryRoot/.vibgrate/federation.json`.
 * Returns the absolute path written. Creates `.vibgrate/` as needed.
 */
export function writeFederationFile(primaryRoot: string, federation: FederatedWorkspace): string {
  const primary = path.resolve(primaryRoot);
  const file = federationPath(primary);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: FederationFile = {
    schemaVersion: FEDERATION_SCHEMA_VERSION,
    members: federation.members.map((m) => ({
      // Prefer path relative to primary when possible so the file is portable.
      root: path.relative(primary, m.root) || '.',
      label: m.label,
      role: m.role,
    })),
  };
  if (federation.bridges?.length) {
    // Persist portable roots for bridges (relative to primary when possible).
    body.bridges = federation.bridges.map((b) => ({
      ...b,
      fromRoot: path.relative(primary, b.fromRoot) || '.',
      toRoot: path.relative(primary, b.toRoot) || '.',
    }));
  }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}
