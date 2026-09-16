/**
 * L0 workspace map fallback: one card per package (or area/root fallback), aggregate edges.
 *
 * This is deliberately NOT a classifier. It never reads a symbol's role or
 * purpose — those come only from `@vibgrate/haile` (`HaileProvider.projectOverview`,
 * see `../haile/haile-provider.ts` and `server.ts`'s `overviewOf`), which is
 * the sole implementation of Vibgrate's architecture taxonomy. This function
 * is the honest degraded view used only when that module isn't installed or
 * fails to load: plain package/file topology, no role-based rollup.
 */
import type { VgGraph } from '../../schema.js';
import type { HaileSidecar } from '../haile/types.js';
import { ARCH_OVERVIEW_MAGIC, OVERVIEW_PACKAGE_CAP, type ArchOverview, type ArchPackageEdge, type ArchPackageNode } from './arch-types.js';
import { indexPackages, isSymbolNode } from './packages.js';

const L0_EDGE_KINDS = new Set([
  'import',
  'depends_on',
  'call',
  'implements',
  'extends',
  'provisions',
  'deploys',
  'triggers',
]);

export function projectOverview(graph: VgGraph, _sidecar: HaileSidecar | null): ArchOverview {
  const { packages, packageOf } = indexPackages(graph);
  const symbolCount = graph.nodes.filter(isSymbolNode).length;
  const cards: ArchPackageNode[] = [];

  for (const pkg of packages) {
    let symbols = 0;
    for (const node of graph.nodes) {
      if (packageOf.get(node.id) !== pkg.id) continue;
      if (!isSymbolNode(node)) continue;
      symbols += 1;
    }
    cards.push({
      id: pkg.id,
      name: displayName(pkg.name, pkg.path),
      path: pkg.path,
      kind: pkg.kind,
      symbols,
      findings: 0,
      missingSteps: 0,
      job: jobOf(pkg.kind, pkg.path, pkg.name),
      policy: null,
      lane: 'unclassified',
      mix: `${symbols} symbols`,
      unclassified: symbols,
    });
  }

  cards.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const visible = cards.slice(0, OVERVIEW_PACKAGE_CAP);
  const visibleIds = new Set(visible.map((c) => c.id));

  const edgeKey = new Map<string, ArchPackageEdge>();
  for (const edge of graph.edges) {
    if (!L0_EDGE_KINDS.has(edge.kind)) continue;
    const srcPkg = packageOf.get(edge.src) ?? packageIdOfNode(graph, edge.src, packageOf);
    const dstPkg = packageOf.get(edge.dst) ?? packageIdOfNode(graph, edge.dst, packageOf);
    if (!srcPkg || !dstPkg || srcPkg === dstPkg) continue;
    if (!visibleIds.has(srcPkg) || !visibleIds.has(dstPkg)) continue;
    const kind = edge.kind === 'call' ? 'calls' : edge.kind;
    const id = `${srcPkg}|${kind}|${dstPkg}`;
    const prev = edgeKey.get(id);
    if (prev) {
      prev.weight += 1;
    } else {
      edgeKey.set(id, { id, src: srcPkg, dst: dstPkg, kind, weight: 1 });
    }
  }

  const edges = [...edgeKey.values()].sort(
    (a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.kind.localeCompare(b.kind),
  );

  const root = graph.meta.root || 'repository';
  const title = root === '.' ? 'Code map' : `Code map · ${root}`;

  return {
    magic: ARCH_OVERVIEW_MAGIC,
    packages: visible,
    edges,
    meta: {
      architectureLoaded: false,
      policy: null,
      policyLabel: null,
      symbols: symbolCount,
      packages: visible.length,
      findings: 0,
      missingSteps: 0,
      title,
    },
  };
}

export function locateInOverview(
  graph: VgGraph,
  key: string,
): { nodeId: string; packageId: string } | null {
  const needle = key.trim();
  if (!needle) return null;
  const { packageOf } = indexPackages(graph);
  const node = graph.nodes.find(
    (n) => n.id === needle || n.qualifiedName === needle || n.name === needle,
  );
  if (!node) return null;
  const packageId = packageOf.get(node.id);
  if (!packageId) return null;
  return { nodeId: node.id, packageId };
}

function packageIdOfNode(
  graph: VgGraph,
  nodeId: string,
  packageOf: Map<string, string>,
): string | null {
  if (packageOf.has(nodeId)) return packageOf.get(nodeId) ?? null;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (node.kind === 'package') return node.id;
  return null;
}

function displayName(name: string, path: string): string {
  if (path && path !== '.') return path;
  return name || 'repository';
}

function jobOf(kind: PackageRecordKind, path: string, name: string): string {
  if (kind === 'area') return 'cluster';
  if (kind === 'root') return 'workspace';
  const blob = `${path} ${name}`.toLowerCase();
  if (/(^|\/)(web|ui|app|frontend|client)s?(\/|$)/.test(blob)) return 'web';
  if (/(^|\/)(api|server|service|backend)s?(\/|$)/.test(blob)) return 'service';
  if (/(^|\/)(db|data|prisma|sql)(\/|$)/.test(blob)) return 'data';
  if (/(^|\/)(infra|deploy|ops|chart)s?(\/|$)/.test(blob)) return 'infra';
  if (/(^|\/)(cli|tool)s?(\/|$)/.test(blob)) return 'tool';
  return 'package';
}

type PackageRecordKind = 'package' | 'area' | 'root';

export function packagePathOf(graph: VgGraph, packageId: string): string | null {
  const { packages } = indexPackages(graph);
  return packages.find((p) => p.id === packageId)?.path ?? null;
}
