/**
 * L1 project slice fallback: plain graph-kind columns, no role/purpose data.
 *
 * This is deliberately NOT a classifier. The real column/card layout —
 * role→lane assignment, cluster/DTO folding, rank scoring, purpose chips —
 * lives only in `@vibgrate/haile` (`HaileProvider.projectSlice`, see
 * `../haile/haile-provider.ts` and `server.ts`'s `sliceOf`), the sole
 * implementation of Vibgrate's architecture taxonomy. This function is the
 * honest degraded view used only when that module isn't installed or fails
 * to load: one card per file, two lanes (`ui` for route/component nodes,
 * `unclassified` for everything else), no classification of any kind.
 */
import type { GraphNode, VgGraph } from '../../schema.js';
import type { HaileSidecar } from '../haile/types.js';
import { indexFor } from '../relations.js';
import {
  ARCH_SLICE_MAGIC,
  LANE_CARD_CAP,
  type ArchCard,
  type ArchSlice,
  type ArchSliceColumn,
  type ArchSliceEdge,
  type ArchSliceSpec,
} from './arch-types.js';
import { indexPackages, isSymbolNode, posixPath } from './packages.js';

const TEST_PATH = /(?:^|\/)(?:__tests__|tests|test|spec)(?:\/|$)/i;
const TEST_FILE = /\.(?:test|spec|tests)\.[^.]+$/i;

type FallbackLane = 'ui' | 'unclassified';

interface Draft {
  id: string;
  lane: FallbackLane;
  file: string;
  members: GraphNode[];
}

export function projectSlice(graph: VgGraph, _sidecar: HaileSidecar | null, spec: ArchSliceSpec): ArchSlice {
  const { packages, packageOf } = indexPackages(graph);
  const pkg = packages.find((p) => p.id === spec.packageId) ?? packages[0];
  const packageId = pkg?.id ?? spec.packageId;
  const packageName = pkg?.path && pkg.path !== '.' ? pkg.path : (pkg?.name ?? packageId);
  const cap = Math.max(1, Math.min(spec.expand === true ? 120 : (spec.cap ?? LANE_CARD_CAP), 120));
  const showTests = spec.tests === true;
  const index = indexFor(graph);

  const drafts = new Map<string, Draft>();
  const symbolCard = new Map<string, string>();

  for (const node of graph.nodes) {
    if (!isSymbolNode(node)) continue;
    if (packageOf.get(node.id) !== packageId) continue;
    if (!showTests && isTestNode(node)) continue;
    const lane: FallbackLane = node.kind === 'route' || node.kind === 'component' ? 'ui' : 'unclassified';
    const file = posixPath(node.file);
    const id = `card:${packageId}:${lane}:${file}`;
    let draft = drafts.get(id);
    if (!draft) {
      draft = { id, lane, file, members: [] };
      drafts.set(id, draft);
    }
    draft.members.push(node);
    symbolCard.set(node.id, id);
  }

  const focusNode = spec.focus
    ? graph.nodes.find((n) => n.id === spec.focus || n.qualifiedName === spec.focus || n.name === spec.focus)
    : undefined;
  const focusCardId = focusNode ? (symbolCard.get(focusNode.id) ?? null) : null;

  const cards = [...drafts.values()].map((d) => toCard(d, index, symbolCard));

  const byLane = new Map<FallbackLane, ArchCard[]>();
  for (const card of cards) {
    const lane = card.lane as FallbackLane;
    const list = byLane.get(lane) ?? [];
    list.push(card);
    byLane.set(lane, list);
  }

  const overflow: Record<string, number> = {};
  const laneDefs: Array<{ id: FallbackLane; title: string }> = [
    { id: 'ui', title: 'UI / Endpoint' },
    { id: 'unclassified', title: 'Unclassified' },
  ];
  const outColumns: ArchSliceColumn[] = [];
  for (const def of laneDefs) {
    const list = (byLane.get(def.id) ?? []).sort(
      (a, b) => b.count - a.count || a.title.localeCompare(b.title) || a.file.localeCompare(b.file),
    );
    const visible: ArchCard[] = [];
    const rest: ArchCard[] = [];
    for (const card of list) {
      if (card.id === focusCardId || visible.length < cap) visible.push(card);
      else rest.push(card);
    }
    if (focusCardId && list.some((c) => c.id === focusCardId) && !visible.some((c) => c.id === focusCardId)) {
      const focused = list.find((c) => c.id === focusCardId)!;
      const dropped = visible.pop();
      if (dropped) rest.push(dropped);
      visible.push(focused);
    }
    overflow[def.id] = rest.reduce((n, c) => n + c.count, 0);
    if (visible.length === 0 && !overflow[def.id]) continue;
    outColumns.push({ id: def.id, title: def.title, cards: visible });
  }

  const keptIds = new Set(outColumns.flatMap((c) => c.cards.map((card) => card.id)));
  const sliceEdges: ArchSliceEdge[] = [];
  const seenEdge = new Set<string>();
  for (const edge of graph.edges) {
    if (spec.view === 'calls' && edge.kind !== 'call') continue;
    if (
      edge.kind !== 'call' &&
      edge.kind !== 'import' &&
      edge.kind !== 'references' &&
      edge.kind !== 'implements' &&
      edge.kind !== 'extends'
    ) {
      continue;
    }
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

  return {
    magic: ARCH_SLICE_MAGIC,
    packageId,
    packageName,
    policy: 'kind',
    columns: outColumns,
    guards: [],
    edges: sliceEdges,
    overflow,
    emptyHint:
      spec.architecture !== false
        ? 'Architecture module not installed — run `vg module install arch` for role-based columns.'
        : null,
    focusCardId,
  };
}

function toCard(draft: Draft, index: ReturnType<typeof indexFor>, symbolCard: Map<string, string>): ArchCard {
  const members = [...draft.members].sort(
    (a, b) => b.importance - a.importance || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const head = members[0]!;
  const fileTitle = draft.file.split('/').pop() ?? draft.file;
  const title = members.length === 1 ? head.name : fileTitle;
  const job = kindLabel(head.kind);
  const subtitle = members.length === 1 ? job : `${members.length} symbols · ${job}`;

  const calls = uniqueLinks(members.flatMap((m) => index.callees(m.id)), symbolCard);
  const calledBy = uniqueLinks(members.flatMap((m) => index.callers(m.id)), symbolCard);

  return {
    id: draft.id,
    title,
    subtitle,
    lane: draft.lane,
    file: draft.file,
    line: head.span?.start ?? null,
    symbolId: head.id,
    count: members.length,
    job,
    color: '#64748b',
    classified: false,
    pulse: false,
    missingStep: false,
    callsOut: calls.length,
    calls,
    calledBy,
    members: members.slice(0, 8).map((n) => ({
      id: n.id,
      name: n.name,
      job: kindLabel(n.kind),
      file: n.file,
      line: n.span?.start ?? null,
    })),
  };
}

function uniqueLinks(
  hits: ReturnType<ReturnType<typeof indexFor>['callees']>,
  symbolCard: Map<string, string>,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const hit of hits) {
    const key = symbolCard.get(hit.node.id) ?? hit.node.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: hit.node.id, name: hit.node.name });
    if (out.length >= 8) break;
  }
  return out;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'route':
      return 'HTTP handler';
    case 'component':
      return 'Component';
    case 'class':
      return 'Type';
    case 'interface':
      return 'Contract';
    case 'method':
      return 'Method';
    case 'function':
      return 'Function';
    default:
      return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Symbol';
  }
}

function isTestNode(node: GraphNode): boolean {
  if (node.kind === 'test') return true;
  const file = posixPath(node.file);
  return TEST_PATH.test(file) || TEST_FILE.test(file);
}
