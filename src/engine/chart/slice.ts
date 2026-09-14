/**
 * L1 project slice. Sidecar roles/purposes/intent own columns and cards.
 * Kind and file stem are not the layout authority.
 */
import type { GraphNode, VgGraph } from '../../schema.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { indexFor } from '../relations.js';
import {
  ARCH_SLICE_MAGIC,
  LANE_CARD_CAP,
  type ArchCard,
  type ArchCardLink,
  type ArchPolicyId,
  type ArchSlice,
  type ArchSliceColumn,
  type ArchSliceEdge,
  type ArchSliceSpec,
  type ArchSliceView,
} from './arch-types.js';
import { indexPackages, isSymbolNode, posixPath } from './packages.js';
import {
  architectureBound,
  cardTitleFor,
  clusterKey,
  dtoOwnerName,
  indexSymbols,
  intentLine,
  isDtoLike,
  isTestNode,
  jobColor,
  jobLabel,
  laneOf,
  lanesFor,
  overflowPhrase,
  purposeChips,
  rankScore,
  resolveRole,
  strongPurposes,
  type LaneId,
} from './layout.js';

interface Draft {
  id: string;
  lane: LaneId;
  cluster: string;
  file: string;
  role: string;
  members: GraphNode[];
  ghost: boolean;
  types: string[];
}

export function projectSlice(graph: VgGraph, sidecar: HaileSidecar | null, spec: ArchSliceSpec): ArchSlice {
  const { packages, packageOf } = indexPackages(graph);
  const pkg = packages.find((p) => p.id === spec.packageId) ?? packages[0];
  const packageId = pkg?.id ?? spec.packageId;
  const packageName = pkg?.path && pkg.path !== '.' ? pkg.path : (pkg?.name ?? packageId);
  const bound = architectureBound(graph, sidecar, spec.architecture !== false);
  const policy: ArchPolicyId =
    bound && sidecar?.policy?.startsWith('layered')
      ? 'layered-v1'
      : bound
        ? 'hexagonal-v1'
        : 'kind';
  const laneDefs = lanesFor(policy === 'kind' ? 'layered-v1' : policy);
  const expandCap = spec.expand === true ? 120 : undefined;
  const cap = Math.max(1, Math.min(expandCap ?? spec.cap ?? LANE_CARD_CAP, 120));
  const view: ArchSliceView = spec.view ?? 'job';
  const showTests = spec.tests === true;
  const symbols = bound ? indexSymbols(sidecar) : new Map<string, HaileSymbol>();
  const symbolOf = (id: string) => symbols.get(id);
  const index = indexFor(graph);

  const drafts = new Map<string, Draft>();
  const symbolCard = new Map<string, string>();

  for (const node of graph.nodes) {
    if (!isSymbolNode(node)) continue;
    if (packageOf.get(node.id) !== packageId) continue;
    const haile = symbolOf(node.id);
    if (!showTests && isTestNode(node, haile)) continue;
    const lane = laneOf(node, haile, policy === 'kind' ? 'layered-v1' : policy, bound);
    const cluster = clusterKey(node, haile);
    const id = `card:${packageId}:${lane}:${cluster}`;
    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        id,
        lane,
        cluster,
        file: posixPath(node.file),
        role: resolveRole(haile) || (bound ? 'unknown' : ''),
        members: [],
        ghost: false,
        types: [],
      };
      drafts.set(id, draft);
    }
    if (isDtoLike(node, haile)) {
      const owner = dtoOwnerName(node.name) || dtoOwnerName(node.qualifiedName);
      if (owner) {
        const ownerId = [...drafts.values()].find((d) => d.cluster === owner && !d.ghost)?.id;
        if (ownerId && ownerId !== id) {
          const host = drafts.get(ownerId)!;
          host.types.push(node.name);
          host.members.push(node);
          symbolCard.set(node.id, ownerId);
          continue;
        }
        draft.types.push(node.name);
      }
    }
    draft.members.push(node);
    if (node.importance >= (draft.members[0]?.importance ?? 0)) {
      draft.file = posixPath(node.file);
      const role = resolveRole(haile);
      if (role && role !== 'unknown') draft.role = role;
    }
    symbolCard.set(node.id, id);
  }

  // Fold leftover DTO-only clusters onto a same-named owner.
  for (const draft of [...drafts.values()]) {
    if (draft.ghost || draft.members.length === 0) continue;
    if (!draft.members.every((m) => isDtoLike(m, symbolOf(m.id)))) continue;
    const owner = dtoOwnerName(draft.cluster) || draft.cluster;
    const host = [...drafts.values()].find((d) => d !== draft && d.cluster === owner);
    if (!host) continue;
    host.types.push(...draft.types, ...draft.members.map((m) => m.name));
    host.members.push(...draft.members);
    for (const m of draft.members) symbolCard.set(m.id, host.id);
    drafts.delete(draft.id);
  }

  for (const draft of [...drafts.values()]) {
    if (draft.ghost || draft.lane !== 'unclassified') continue;
    if (draft.members.length && draft.members.every((m) => isDtoLike(m, symbolOf(m.id)))) {
      for (const m of draft.members) symbolCard.delete(m.id);
      drafts.delete(draft.id);
    }
  }

  const persistLane: LaneId = policy === 'hexagonal-v1' ? 'adapters_out' : 'io';
  for (const edge of graph.edges) {
    if (edge.kind !== 'call' && edge.kind !== 'import' && edge.kind !== 'references') continue;
    const srcCard = symbolCard.get(edge.src);
    if (!srcCard) continue;
    const dstPkg = packageOf.get(edge.dst);
    if (!dstPkg || dstPkg === packageId) continue;
    const dstNode = index.node(edge.dst);
    if (!dstNode) continue;
    const ghostId = `ghost:${dstPkg}`;
    if (!drafts.has(ghostId)) {
      const rec = packages.find((p) => p.id === dstPkg);
      drafts.set(ghostId, {
        id: ghostId,
        lane: persistLane,
        cluster: rec?.path || rec?.name || dstPkg,
        file: rec?.path ?? posixPath(dstNode.file),
        role: 'external',
        members: [dstNode],
        ghost: true,
        types: [],
      });
    }
    symbolCard.set(edge.dst, ghostId);
  }

  let cards = [...drafts.values()].map((d) => toCard(d, bound, symbolOf, index, symbolCard, drafts));
  if (view === 'missing') cards = cards.filter((c) => c.missingStep);
  if (view === 'problems') cards = cards.filter((c) => c.pulse);

  const focusNode = spec.focus
    ? graph.nodes.find((n) => n.id === spec.focus || n.qualifiedName === spec.focus || n.name === spec.focus)
    : undefined;
  const focusCardId = focusNode ? (symbolCard.get(focusNode.id) ?? null) : null;

  const byLane = new Map<string, RankedCard[]>();
  for (const card of cards) {
    const list = byLane.get(card.lane) ?? [];
    list.push(card);
    byLane.set(card.lane, list);
  }

  const overflow: Record<string, number> = {};
  const overflowHint: Record<string, string> = {};
  const kept: ArchCard[] = [];
  for (const def of laneDefs) {
    const list = (byLane.get(def.id) ?? []).sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
    const visible: RankedCard[] = [];
    const rest: RankedCard[] = [];
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
    const publicVisible = visible.map(stripRank);
    byLane.set(def.id, visible);
    kept.push(...publicVisible);
    overflow[def.id] = rest.reduce((n, c) => n + c.count, 0);
    if (rest.length) overflowHint[def.id] = overflowPhrase(rest);
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
    const kind = edge.kind === 'call' ? 'calls' : edge.kind === 'import' ? 'import' : 'calls';
    const id = `${src}|${kind}|${dst}`;
    if (seenEdge.has(id)) continue;
    seenEdge.add(id);
    sliceEdges.push({ id, src, dst, kind });
  }
  sliceEdges.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.kind.localeCompare(b.kind));

  const outColumns: ArchSliceColumn[] = [];
  for (const def of laneDefs) {
    const laneCards = byLane.get(def.id) ?? [];
    if (def.id === 'unclassified') {
      if (laneCards.length === 0 && !overflow[def.id]) continue;
    } else if (laneCards.length === 0 && !overflow[def.id]) {
      continue;
    }
    outColumns.push({
      id: def.id,
      title: def.title,
      cards: (byLane.get(def.id) ?? [])
        .map(stripRank)
        .sort((a, b) => a.title.localeCompare(b.title) || a.file.localeCompare(b.file)),
    });
  }

  const hasUi = outColumns.some((c) => c.id === 'ui' || c.id === 'adapters_in');
  let emptyHint: string | null = null;
  if (bound && !hasUi) {
    emptyHint = 'No UI adapters in this package · CLI / library';
  } else if (!bound && spec.architecture !== false) {
    emptyHint = 'Architecture jobs are still catching up with this map. Reopen the slice in a moment.';
  }

  return {
    magic: ARCH_SLICE_MAGIC,
    packageId,
    packageName,
    policy: bound ? policy : 'kind',
    columns: outColumns,
    guards: [],
    edges: sliceEdges,
    overflow,
    overflowHint,
    emptyHint,
    focusCardId,
  };
}

type RankedCard = ArchCard & { rank: number };

function toCard(
  draft: Draft,
  bound: boolean,
  symbolOf: (id: string) => HaileSymbol | undefined,
  index: ReturnType<typeof indexFor>,
  symbolCard: Map<string, string>,
  drafts: Map<string, Draft>,
): RankedCard {
  const members = [...draft.members].sort(
    (a, b) => b.importance - a.importance || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const head = members[0]!;
  const headSym = symbolOf(head.id);
  const role = draft.role || resolveRole(headSym);
  const job = draft.ghost ? 'external' : jobLabel(role, bound, head.kind);
  const chips = purposeChips(headSym);
  const title = cardTitleFor(members, draft.cluster, draft.ghost, draft.file);
  const subtitle =
    members.length === 1
      ? [job, ...chips].filter(Boolean).join(' · ')
      : [`${members.length} functions`, job, chips[0]].filter(Boolean).join(' · ');
  const pulse = members.some((m) => (symbolOf(m.id)?.findings ?? []).some((f) => typeof f.line === 'number' && f.line > 0));
  const missingStep = members.some((m) => {
    const gaps = (symbolOf(m.id) as HaileSymbol & { extract_gaps?: unknown[] } | undefined)?.extract_gaps;
    return Array.isArray(gaps) && gaps.length > 0;
  });
  const guard = role === 'cross_cutting' || strongPurposes(headSym).some((p) => p === 'authenticate' || p === 'authorise' || p === 'validate');

  const calls: ArchCardLink[] = [];
  const calledBy: ArchCardLink[] = [];
  const seenCall = new Set<string>();
  const seenCaller = new Set<string>();
  for (const m of members) {
    for (const hit of index.callees(m.id)) {
      const otherCard = symbolCard.get(hit.node.id);
      const other = otherCard ? drafts.get(otherCard) : undefined;
      const name = other && other.cluster !== hit.node.name ? `${other.cluster}.${hit.node.name}` : hit.node.name;
      const key = otherCard ?? hit.node.id;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      calls.push({ id: hit.node.id, name });
      if (calls.length >= 8) break;
    }
    if (calls.length >= 8) break;
  }
  for (const m of members) {
    for (const hit of index.callers(m.id)) {
      const otherCard = symbolCard.get(hit.node.id);
      const other = otherCard ? drafts.get(otherCard) : undefined;
      const name = other && other.cluster !== hit.node.name ? `${other.cluster}.${hit.node.name}` : hit.node.name;
      const key = otherCard ?? hit.node.id;
      if (seenCaller.has(key)) continue;
      seenCaller.add(key);
      calledBy.push({ id: hit.node.id, name });
      if (calledBy.length >= 8) break;
    }
    if (calledBy.length >= 8) break;
  }

  const memberViews = members.slice(0, 8).map((n) => ({
    id: n.id,
    name: n.name,
    job: jobLabel(resolveRole(symbolOf(n.id)), bound, n.kind),
    file: n.file,
    line: n.span?.start ?? null,
  }));

  return {
    id: draft.id,
    title,
    subtitle: subtitle || job,
    lane: draft.lane,
    file: draft.file,
    line: head.span?.start ?? null,
    symbolId: head.id,
    count: members.length,
    job,
    color: draft.ghost ? '#64748b' : jobColor(role, bound),
    classified: bound && Boolean(headSym),
    pulse,
    missingStep,
    rank: rankScore(members, symbolOf),
    ...(draft.ghost ? { ghost: true } : {}),
    intent: intentLine(headSym),
    callsOut: seenCall.size,
    calls,
    calledBy,
    members: memberViews,
    types: uniqueSorted(draft.types),
    ...(guard ? { guard: true } : {}),
  };
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function stripRank(card: RankedCard): ArchCard {
  const { rank: _rank, ...rest } = card;
  return rest;
}
