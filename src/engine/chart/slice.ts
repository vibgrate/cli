/**
 * L1 project slice: collapse file+role into cards, paint ≤ 120, policy columns.
 */
import type { GraphNode, VgGraph } from '../../schema.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { findHaileSymbol } from '../haile/sidecar.js';
import { KIND_COLOR, LANE_FOR_ROLE, ROLE_COLOR, kindLabel } from './labels.js';
import {
  ARCH_SLICE_MAGIC,
  SLICE_CARD_CAP,
  type ArchCard,
  type ArchPolicyId,
  type ArchSlice,
  type ArchSliceColumn,
  type ArchSliceEdge,
  type ArchSliceSpec,
  type ArchSliceView,
} from './arch-types.js';
import { indexPackages, isSymbolNode, posixPath } from './packages.js';
import { viewNode } from './model.js';

const TEST_PATH = /(?:^|\/)(?:__tests__|tests|test|spec)(?:\/|$)/i;
const TEST_FILE = /\.(?:test|spec|tests)\.[^.]+$/i;

interface ColumnDef {
  id: string;
  title: string;
  roles: Set<string>;
  kinds: Set<string>;
}

interface DraftCard {
  id: string;
  lane: string;
  file: string;
  role: string;
  members: GraphNode[];
  ghost: boolean;
}

export function projectSlice(graph: VgGraph, sidecar: HaileSidecar | null, spec: ArchSliceSpec): ArchSlice {
  const { packages, packageOf } = indexPackages(graph);
  const pkg = packages.find((p) => p.id === spec.packageId) ?? packages[0];
  const packageId = pkg?.id ?? spec.packageId;
  const packageName = pkg?.path && pkg.path !== '.' ? pkg.path : (pkg?.name ?? packageId);
  const archOn = spec.architecture !== false;
  const policy: ArchPolicyId =
    archOn && sidecar?.policy?.startsWith('layered')
      ? 'layered-v1'
      : archOn && sidecar
        ? 'hexagonal-v1'
        : 'kind';
  const columns = columnDefs(policy);
  const cap = Math.max(1, Math.min(spec.cap ?? SLICE_CARD_CAP, SLICE_CARD_CAP));
  const view: ArchSliceView = spec.view ?? 'job';
  const showTests = spec.tests === true;

  const drafts = new Map<string, DraftCard>();
  const symbolCard = new Map<string, string>();
  const guards: DraftCard[] = [];

  for (const node of graph.nodes) {
    if (!isSymbolNode(node)) continue;
    const owner = packageOf.get(node.id);
    if (owner !== packageId) continue;
    if (!showTests && isTestNode(node, sidecar)) continue;
    const symbol = findHaileSymbol(sidecar, node.id);
    const role = archOn && symbol ? symbol.role.primary : '';
    const lane = laneOf(node, symbol, policy, archOn, columns);
    if (lane === 'guards') {
      const id = cardId(node.file, 'guards', role || node.kind);
      let draft = drafts.get(id);
      if (!draft) {
        draft = { id, lane: 'guards', file: posixPath(node.file), role: role || node.kind, members: [], ghost: false };
        drafts.set(id, draft);
        guards.push(draft);
      }
      draft.members.push(node);
      symbolCard.set(node.id, id);
      continue;
    }
    const id = cardId(posixPath(node.file), lane, role || node.kind);
    let draft = drafts.get(id);
    if (!draft) {
      draft = { id, lane, file: posixPath(node.file), role: role || node.kind, members: [], ghost: false };
      drafts.set(id, draft);
    }
    draft.members.push(node);
    symbolCard.set(node.id, id);
  }

  // One-hop external packages as ghost cards (rightmost column).
  const lastLane = columns[columns.length - 1]?.id ?? 'infra';
  for (const edge of graph.edges) {
    if (edge.kind !== 'call' && edge.kind !== 'import') continue;
    const srcCard = symbolCard.get(edge.src);
    if (!srcCard) continue;
    const dstPkg = packageOf.get(edge.dst);
    if (!dstPkg || dstPkg === packageId) continue;
    const dstNode = graph.nodes.find((n) => n.id === edge.dst);
    if (!dstNode) continue;
    const ghostId = `ghost:${dstPkg}`;
    if (!drafts.has(ghostId)) {
      const rec = packages.find((p) => p.id === dstPkg);
      drafts.set(ghostId, {
        id: ghostId,
        lane: lastLane,
        file: rec?.path ?? dstNode.file,
        role: 'external',
        members: [dstNode],
        ghost: true,
      });
    }
    symbolCard.set(edge.dst, ghostId);
  }

  let cards = [...drafts.values()].map((d) => toCard(d, graph, sidecar, archOn));
  if (view === 'missing') cards = cards.filter((c) => c.missingStep);
  if (view === 'problems') cards = cards.filter((c) => c.pulse);

  const focusNode = spec.focus
    ? graph.nodes.find((n) => n.id === spec.focus || n.qualifiedName === spec.focus || n.name === spec.focus)
    : undefined;
  let focusCardId = focusNode ? (symbolCard.get(focusNode.id) ?? null) : null;

  if (focusCardId && (view === 'job' || view === 'calls')) {
    const keep = neighbourhood(focusCardId, graph, symbolCard, 2, 1);
    cards = cards.filter((c) => keep.has(c.id) || c.id === focusCardId);
  }

  cards.sort((a, b) => importanceOf(b, drafts) - importanceOf(a, drafts) || a.title.localeCompare(b.title));

  const overflow: Record<string, number> = {};
  for (const col of columns) overflow[col.id] = 0;
  overflow.guards = 0;

  const kept: ArchCard[] = [];
  for (const card of cards) {
    if (card.id === focusCardId || kept.length < cap) {
      kept.push(card);
    } else {
      overflow[card.lane] = (overflow[card.lane] ?? 0) + 1;
    }
  }
  if (focusCardId && !kept.some((c) => c.id === focusCardId)) {
    const focused = cards.find((c) => c.id === focusCardId);
    if (focused) {
      const dropped = kept.pop();
      if (dropped) overflow[dropped.lane] = (overflow[dropped.lane] ?? 0) + 1;
      kept.push(focused);
    }
  }

  const keptIds = new Set(kept.map((c) => c.id));
  const sliceEdges: ArchSliceEdge[] = [];
  const seenEdge = new Set<string>();
  for (const edge of graph.edges) {
    if (view === 'calls' && edge.kind !== 'call') continue;
    if (edge.kind !== 'call' && edge.kind !== 'import' && edge.kind !== 'references') continue;
    const src = symbolCard.get(edge.src);
    const dst = symbolCard.get(edge.dst);
    if (!src || !dst || src === dst) continue;
    if (!keptIds.has(src) || !keptIds.has(dst)) continue;
    const kind = edge.kind === 'call' ? 'calls' : edge.kind;
    const id = `${src}|${kind}|${dst}`;
    if (seenEdge.has(id)) continue;
    seenEdge.add(id);
    sliceEdges.push({ id, src, dst, kind });
  }
  sliceEdges.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.kind.localeCompare(b.kind));

  const byLane = new Map<string, ArchCard[]>();
  for (const card of kept) {
    const list = byLane.get(card.lane) ?? [];
    list.push(card);
    byLane.set(card.lane, list);
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title) || a.file.localeCompare(b.file));
  }

  const outColumns: ArchSliceColumn[] = columns.map((col) => ({
    id: col.id,
    title: col.title,
    cards: byLane.get(col.id) ?? [],
  }));
  const guardCards = (byLane.get('guards') ?? []).sort((a, b) => a.title.localeCompare(b.title));

  return {
    magic: ARCH_SLICE_MAGIC,
    packageId,
    packageName,
    policy,
    columns: outColumns,
    guards: guardCards,
    edges: sliceEdges,
    overflow,
    focusCardId,
  };
}

function columnDefs(policy: ArchPolicyId): ColumnDef[] {
  if (policy === 'layered-v1') {
    return [
      col('ui', 'UI / Endpoint', ['controller', 'transport', 'user_interface', 'entry_point'], ['route', 'component']),
      col('app', 'Application', ['application_service', 'use_case', 'port'], ['method', 'function']),
      col('io', 'Persistence / IO', ['repository', 'persistence', 'infrastructure', 'adapter', 'integration', 'messaging', 'worker'], ['resource']),
    ];
  }
  if (policy === 'kind') {
    return [
      col('ui', 'UI / Endpoint', [], ['route', 'component']),
      col('app', 'Application', [], ['function', 'method']),
      col('io', 'Types / IO', [], ['class', 'interface', 'property', 'resource', 'workload']),
    ];
  }
  return [
    col('adapters', 'Adapters / UI', ['controller', 'transport', 'user_interface', 'entry_point'], ['route', 'component']),
    col('app', 'Application', ['application_service', 'use_case', 'port'], ['method']),
    col('domain', 'Domain', ['domain_model', 'domain_service'], ['class', 'interface']),
    col('infra', 'Ports / Infra', ['repository', 'persistence', 'infrastructure', 'adapter', 'integration', 'messaging', 'worker'], ['resource']),
  ];
}

function col(id: string, title: string, roles: string[], kinds: string[]): ColumnDef {
  return { id, title, roles: new Set(roles), kinds: new Set(kinds) };
}

function laneOf(
  node: GraphNode,
  symbol: HaileSymbol | undefined,
  policy: ArchPolicyId,
  archOn: boolean,
  columns: ColumnDef[],
): string {
  const role = archOn && symbol ? symbol.role.primary : '';
  if (role === 'cross_cutting') return 'guards';
  if (role === 'test_support') return 'guards';
  if (role) {
    for (const column of columns) {
      if (column.roles.has(role)) return column.id;
    }
    const fallback = LANE_FOR_ROLE[role];
    if (fallback === 'Guards') return 'guards';
    if (fallback === 'Handlers') return columns[0]?.id ?? 'ui';
    if (fallback === 'Services') return columns.find((c) => c.id === 'app')?.id ?? columns[1]?.id ?? 'app';
  }
  for (const column of columns) {
    if (column.kinds.has(node.kind)) return column.id;
  }
  return columns[columns.length - 1]?.id ?? 'infra';
}

function isTestNode(node: GraphNode, sidecar: HaileSidecar | null): boolean {
  if (node.kind === 'test') return true;
  const file = posixPath(node.file);
  if (TEST_PATH.test(file) || TEST_FILE.test(file)) return true;
  const symbol = findHaileSymbol(sidecar, node.id);
  if (symbol?.role.primary === 'test_support') return true;
  if (symbol?.purposes?.some((p) => p.purpose === 'test')) return true;
  return false;
}

function cardId(file: string, lane: string, role: string): string {
  return `card:${file}:${lane}:${role}`;
}

function toCard(draft: DraftCard, graph: VgGraph, sidecar: HaileSidecar | null, archOn: boolean): ArchCard {
  const members = [...draft.members].sort(
    (a, b) => b.importance - a.importance || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const head = members[0]!;
  const views = members.map((m) => viewNode(m, graph, sidecar));
  const view = views[0]!;
  const title = cardTitle(members, draft);
  const subtitle =
    members.length === 1
      ? view.purposes[0]?.label || view.job
      : `${members.length} functions`;
  const pulse = views.some((v) => v.pulse);
  const missingStep = views.some((v) => v.missingStep);
  return {
    id: draft.id,
    title,
    subtitle,
    lane: draft.lane,
    file: draft.file,
    line: head.span?.start ?? null,
    symbolId: head.id,
    count: members.length,
    job: archOn ? view.job : kindLabel(head.kind),
    color: draft.ghost
      ? '#64748b'
      : archOn
        ? (ROLE_COLOR[draft.role] ?? view.color)
        : (KIND_COLOR[head.kind] ?? '#94a3b8'),
    classified: view.classified,
    pulse,
    missingStep,
    ...(draft.ghost ? { ghost: true } : {}),
  };
}

function cardTitle(members: GraphNode[], draft: DraftCard): string {
  if (draft.ghost) {
    const path = draft.file;
    return path && path !== '.' ? path : members[0]?.name || 'external';
  }
  if (members.length === 1) return members[0]!.name;
  const prefixes = members
    .map((m) => {
      const q = m.qualifiedName || m.name;
      const i = q.lastIndexOf('.');
      return i > 0 ? q.slice(0, i) : '';
    })
    .filter(Boolean);
  if (prefixes.length === members.length && prefixes.every((p) => p === prefixes[0])) {
    const leaf = prefixes[0]!.split('.').pop();
    if (leaf) return leaf;
  }
  const stem = draft.file.split('/').pop() ?? draft.file;
  return stem.replace(/\.[^.]+$/, '') || members[0]!.name;
}

function importanceOf(card: ArchCard, drafts: Map<string, DraftCard>): number {
  const draft = drafts.get(card.id);
  if (!draft) return 0;
  let max = 0;
  for (const m of draft.members) if (m.importance > max) max = m.importance;
  return max;
}

function neighbourhood(
  root: string,
  graph: VgGraph,
  symbolCard: Map<string, string>,
  downHops: number,
  upHops: number,
): Set<string> {
  const keep = new Set<string>([root]);
  const cardNodes = new Map<string, string[]>();
  for (const [nodeId, cardId] of symbolCard) {
    const list = cardNodes.get(cardId) ?? [];
    list.push(nodeId);
    cardNodes.set(cardId, list);
  }
  walk(root, 'down', downHops);
  walk(root, 'up', upHops);
  return keep;

  function walk(start: string, dir: 'down' | 'up', hops: number): void {
    let frontier = new Set<string>([start]);
    for (let i = 0; i < hops; i++) {
      const next = new Set<string>();
      for (const card of frontier) {
        for (const nodeId of cardNodes.get(card) ?? []) {
          for (const edge of graph.edges) {
            if (edge.kind !== 'call') continue;
            const other = dir === 'down' ? (edge.src === nodeId ? edge.dst : null) : edge.dst === nodeId ? edge.src : null;
            if (!other) continue;
            const otherCard = symbolCard.get(other);
            if (!otherCard || keep.has(otherCard)) continue;
            keep.add(otherCard);
            next.add(otherCard);
          }
        }
      }
      frontier = next;
    }
  }
}


