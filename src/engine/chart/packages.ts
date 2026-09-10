/**
 * Assign graph symbols to workspace packages (or area/root fallbacks).
 * Deterministic: path-longest match, then sorted ids.
 */
import type { GraphNode, VgGraph } from '../../schema.js';

const SKIPPED = new Set(['file', 'document']);
const MANIFEST_NAMES = new Set([
  'package.json',
  'go.mod',
  'cargo.toml',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'gemfile',
  'packages.config',
]);

export interface PackageRecord {
  id: string;
  name: string;
  path: string;
  kind: 'package' | 'area' | 'root';
  qualifiedName: string;
}

export interface PackageIndex {
  packages: PackageRecord[];
  /** symbol node id → package id */
  packageOf: Map<string, string>;
}

export function posixPath(file: string): string {
  return file.replace(/\\/g, '/');
}

export function dirOfManifest(file: string): string {
  const p = posixPath(file);
  const slash = p.lastIndexOf('/');
  if (slash <= 0) return '.';
  return p.slice(0, slash);
}

export function isSymbolNode(node: GraphNode): boolean {
  if (SKIPPED.has(node.kind)) return false;
  if (node.kind === 'package' || node.kind === 'external') return false;
  return true;
}

export function indexPackages(graph: VgGraph): PackageIndex {
  const pkgNodes = graph.nodes
    .filter((n) => n.kind === 'package' && !posixPath(n.file).includes('node_modules/'))
    .map((n) => {
      const path = dirOfManifest(n.file);
      return {
        id: n.id,
        name: n.name || n.qualifiedName || path,
        path,
        kind: 'package' as const,
        qualifiedName: n.qualifiedName || n.name,
        rank: path === '.' ? 0 : path.split('/').filter(Boolean).length,
      };
    })
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));

  const packageOf = new Map<string, string>();
  const used = new Set<string>();

  for (const node of graph.nodes) {
    if (!isSymbolNode(node)) continue;
    const file = posixPath(node.file);
    let hit: string | null = null;
    for (const pkg of pkgNodes) {
      if (pkg.path === '.') {
        hit = pkg.id;
        break;
      }
      if (file === pkg.path || file.startsWith(`${pkg.path}/`)) {
        hit = pkg.id;
        break;
      }
    }
    if (hit) {
      packageOf.set(node.id, hit);
      used.add(hit);
    }
  }

  const packages: PackageRecord[] = pkgNodes
    .filter((p) => used.has(p.id) || p.kind === 'package')
    .map(({ rank: _rank, ...rest }) => rest);

  const assigned = new Set(packageOf.keys());
  const orphans = graph.nodes.filter((n) => isSymbolNode(n) && !assigned.has(n.id));

  if (orphans.length > 0) {
    const byArea = new Map<number, GraphNode[]>();
    for (const node of orphans) {
      const list = byArea.get(node.area) ?? [];
      list.push(node);
      byArea.set(node.area, list);
    }
    const areaIds = [...byArea.keys()].sort((a, b) => a - b);
    const useAreas = packages.length === 0 && areaIds.length > 0 && graph.areas.length > 0;
    if (useAreas) {
      for (const areaId of areaIds) {
        const area = graph.areas.find((a) => a.id === areaId);
        const rec: PackageRecord = {
          id: `area:${areaId}`,
          name: area?.label || `Area ${areaId}`,
          path: area?.label || '.',
          kind: 'area',
          qualifiedName: area?.label || `area:${areaId}`,
        };
        packages.push(rec);
        for (const node of byArea.get(areaId) ?? []) packageOf.set(node.id, rec.id);
      }
    } else {
      const root = packages.find((p) => p.path === '.') ?? {
        id: 'root',
        name: graph.meta.root && graph.meta.root !== '.' ? graph.meta.root : 'repository',
        path: '.',
        kind: 'root' as const,
        qualifiedName: graph.meta.root || 'repository',
      };
      if (!packages.some((p) => p.id === root.id)) packages.push(root);
      for (const node of orphans) packageOf.set(node.id, root.id);
    }
  }

  if (packages.length === 0) {
    const root: PackageRecord = {
      id: 'root',
      name: graph.meta.root && graph.meta.root !== '.' ? graph.meta.root : 'repository',
      path: '.',
      kind: 'root',
      qualifiedName: graph.meta.root || 'repository',
    };
    packages.push(root);
    for (const node of graph.nodes) {
      if (isSymbolNode(node)) packageOf.set(node.id, root.id);
    }
  }

  packages.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  return { packages, packageOf };
}

export function looksLikeManifest(file: string): boolean {
  const base = posixPath(file).split('/').pop()?.toLowerCase() ?? '';
  return MANIFEST_NAMES.has(base);
}
