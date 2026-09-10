/**
 * L0 workspace map: one card per package (or area/root fallback), aggregate edges.
 */
import type { VgGraph } from '../../schema.js';
import type { HaileSidecar } from '../haile/types.js';
import { findHaileSymbol } from '../haile/sidecar.js';
import { policyLabel } from './labels.js';
import {
  ARCH_OVERVIEW_MAGIC,
  OVERVIEW_PACKAGE_CAP,
  type ArchOverview,
  type ArchPackageEdge,
  type ArchPackageNode,
} from './arch-types.js';
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

export function projectOverview(graph: VgGraph, sidecar: HaileSidecar | null): ArchOverview {
  const { packages, packageOf } = indexPackages(graph);
  const symbolCount = graph.nodes.filter(isSymbolNode).length;
  const cards: ArchPackageNode[] = [];

  for (const pkg of packages) {
    let symbols = 0;
    let findings = 0;
    let missingSteps = 0;
    for (const node of graph.nodes) {
      if (packageOf.get(node.id) !== pkg.id) continue;
      if (!isSymbolNode(node)) continue;
      symbols += 1;
      const symbol = findHaileSymbol(sidecar, node.id);
      if (symbol?.findings?.some((f) => f && typeof f.message === 'string')) findings += 1;
      const gaps = (symbol as { extract_gaps?: unknown[] } | undefined)?.extract_gaps;
      if (Array.isArray(gaps) && gaps.length > 0) missingSteps += 1;
    }
    cards.push({
      id: pkg.id,
      name: displayName(pkg.name, pkg.path),
      path: pkg.path,
      kind: pkg.kind,
      symbols,
      findings,
      missingSteps,
      job: jobOf(pkg.kind, pkg.path, pkg.name),
      policy: sidecar?.policy ?? null,
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
  const findings = visible.reduce((n, p) => n + p.findings, 0);
  const missingSteps = visible.reduce((n, p) => n + p.missingSteps, 0);

  return {
    magic: ARCH_OVERVIEW_MAGIC,
    packages: visible,
    edges,
    meta: {
      architectureLoaded: Boolean(sidecar),
      policy: sidecar?.policy ?? null,
      policyLabel: sidecar ? policyLabel(sidecar.policy) : null,
      symbols: symbolCount,
      packages: visible.length,
      findings,
      missingSteps,
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
