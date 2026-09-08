/**
 * Project a vg-graph + optional classify sidecar into the map view-model.
 * Join is node_id → GraphNode.id. Missing sidecar → graph-only paint.
 */
import type { GraphNode, VgGraph } from '../../schema.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { haileJsonFields } from '../haile/format.js';
import { findHaileSymbol } from '../haile/sidecar.js';
import { indexFor } from '../relations.js';
import { pathDisconnect, shortestPath, type PathDisconnect } from '../paths.js';
import {
  KIND_COLOR,
  LANE_FOR_ROLE,
  PURPOSE_CHIP_CAP,
  PURPOSE_CONFIDENCE_FLOOR,
  ROLE_COLOR,
  kindLabel,
  policyLabel,
  purposeLabel,
  roleLabel,
} from './labels.js';

const HIDDEN_KINDS = new Set(['file', 'document']);

export interface ChartPurpose {
  slug: string;
  label: string;
}

export interface ChartFindingView {
  severity: string;
  message: string;
  rule: string;
  line: number | null;
  pulse: boolean;
}

export interface ChartNodeView {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  kindLabel: string;
  file: string;
  line: number | null;
  signature: string | null;
  area: number;
  areaLabel: string | null;
  importance: number;
  isHub: boolean;
  job: string;
  lane: string;
  color: string;
  intent: string | null;
  purposes: ChartPurpose[];
  classified: boolean;
  pulse: boolean;
  missingStep: boolean;
  missingStepText: string | null;
}

export interface ChartMeta {
  magic: 'vg.chart.service.v1';
  title: string;
  nodes: number;
  edges: number;
  areas: number;
  classified: number;
  pulses: number;
  missingSteps: number;
  architectureLoaded: boolean;
  policy: string | null;
  policyLabel: string | null;
}

export interface ChartPayload {
  meta: ChartMeta;
  nodes: ChartNodeView[];
  edges: Array<{ id: string; kind: string; src: string; dst: string }>;
  areas: Array<{ id: number; label: string; size: number }>;
}

export function projectChart(graph: VgGraph, sidecar: HaileSidecar | null): ChartPayload {
  const nodes = graph.nodes
    .filter((n) => !HIDDEN_KINDS.has(n.kind))
    .map((n) => viewNode(n, graph, sidecar));
  const visible = new Set(nodes.map((n) => n.id));
  const edges = graph.edges
    .filter((e) => visible.has(e.src) && visible.has(e.dst))
    .map((e) => ({ id: e.id, kind: e.kind, src: e.src, dst: e.dst }));
  return {
    meta: metaOf(graph, sidecar, nodes),
    nodes,
    edges,
    areas: graph.areas.map((a) => ({ id: a.id, label: a.label, size: a.size })),
  };
}

export function viewNode(node: GraphNode, graph: VgGraph, sidecar: HaileSidecar | null): ChartNodeView {
  const area = graph.areas.find((a) => a.id === node.area);
  const symbol = findHaileSymbol(sidecar, node.id);
  const purposes = visiblePurposes(symbol);
  const findings = visibleFindings(symbol);
  const gap = extractGap(symbol);
  const classified = Boolean(symbol);
  const job = classified ? roleLabel(symbol!.role.primary) : kindLabel(node.kind);
  const lane = classified
    ? (LANE_FOR_ROLE[symbol!.role.primary] ?? laneForKind(node.kind))
    : laneForKind(node.kind);
  const color = classified
    ? (ROLE_COLOR[symbol!.role.primary] ?? KIND_COLOR[node.kind] ?? '#94a3b8')
    : (KIND_COLOR[node.kind] ?? '#94a3b8');
  return {
    id: node.id,
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    kindLabel: kindLabel(node.kind),
    file: node.file,
    line: node.span?.start ?? null,
    signature: node.signature ?? null,
    area: node.area,
    areaLabel: area?.label ?? null,
    importance: node.importance,
    isHub: node.isHub,
    job,
    lane,
    color,
    intent: symbol?.intent?.text ?? node.doc ?? null,
    purposes,
    classified,
    pulse: findings.some((f) => f.pulse),
    missingStep: Boolean(gap),
    missingStepText: gap,
  };
}

export function showJsonFor(
  graph: VgGraph,
  node: GraphNode,
  sidecar: HaileSidecar | null,
): Record<string, unknown> {
  const index = indexFor(graph);
  const callees = unique(index.callees(node.id).map((x) => x.node));
  const callers = unique(index.callers(node.id).map((x) => x.node));
  const area = graph.areas.find((a) => a.id === node.area);
  const haile = findHaileSymbol(sidecar, node.id);
  return {
    id: node.id,
    name: node.qualifiedName,
    kind: node.kind,
    file: node.file,
    line: node.span.start,
    signature: node.signature ?? null,
    importance: node.importance,
    centrality: node.centrality,
    isHub: node.isHub,
    area: node.area,
    areaLabel: area?.label ?? null,
    tested: node.tested,
    calls: callees.map((n) => n.qualifiedName),
    calledBy: callers.map((n) => n.qualifiedName),
    arch: haileJsonFields(haile) ?? null,
    view: viewNode(node, graph, sidecar),
  };
}

export function pathJson(
  graph: VgGraph,
  srcId: string,
  dstId: string,
): { connected: true; ids: string[]; direction: 'forward' | 'reverse' } | PathDisconnect {
  const found = shortestPath(graph, srcId, dstId);
  if (found) return { connected: true, ids: found.ids, direction: found.direction };
  return pathDisconnect(graph, srcId, dstId);
}

export function searchNodes(payload: ChartPayload, q: string): ChartNodeView[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return payload.nodes.slice(0, 20);
  return payload.nodes
    .filter((n) => {
      const blob = [n.name, n.qualifiedName, n.job, n.intent ?? '', ...n.purposes.map((p) => p.label), n.file]
        .join(' ')
        .toLowerCase();
      return blob.includes(needle);
    })
    .slice(0, 30);
}

function metaOf(graph: VgGraph, sidecar: HaileSidecar | null, nodes: ChartNodeView[]): ChartMeta {
  const root = graph.meta.root || 'repository';
  const title = root === '.' ? 'Code map' : `Code map · ${root}`;
  return {
    magic: 'vg.chart.service.v1',
    title,
    nodes: nodes.length,
    edges: graph.meta.counts.edges,
    areas: graph.meta.counts.areas,
    classified: nodes.filter((n) => n.classified).length,
    pulses: nodes.filter((n) => n.pulse).length,
    missingSteps: nodes.filter((n) => n.missingStep).length,
    architectureLoaded: Boolean(sidecar),
    policy: sidecar?.policy ?? null,
    policyLabel: sidecar ? policyLabel(sidecar.policy) : null,
  };
}

function visiblePurposes(symbol: HaileSymbol | undefined): ChartPurpose[] {
  if (!symbol) return [];
  return (symbol.purposes ?? [])
    .filter(
      (p) =>
        typeof p.purpose === 'string' &&
        typeof p.confidence === 'number' &&
        p.confidence >= PURPOSE_CONFIDENCE_FLOOR,
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, PURPOSE_CHIP_CAP)
    .map((p) => ({ slug: p.purpose, label: purposeLabel(p.purpose) }));
}

function visibleFindings(symbol: HaileSymbol | undefined): ChartFindingView[] {
  const out: ChartFindingView[] = [];
  for (const finding of symbol?.findings ?? []) {
    if (!finding || typeof finding.message !== 'string') continue;
    const line = typeof finding.line === 'number' ? finding.line : null;
    out.push({
      severity: String(finding.severity ?? 'info'),
      message: finding.message,
      rule: String(finding.rule ?? ''),
      line,
      pulse: typeof line === 'number' && line > 0,
    });
  }
  return out;
}

function extractGap(symbol: HaileSymbol | undefined): string | null {
  const gaps = (symbol as HaileSymbol & { extract_gaps?: Array<{ message?: string }> })?.extract_gaps;
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const first = gaps[0];
  return typeof first?.message === 'string'
    ? first.message
    : 'A step in the source is missing from this map.';
}

function laneForKind(kind: string): string {
  if (kind === 'route' || kind === 'component') return 'Handlers';
  if (kind === 'function') return 'Guards';
  if (kind === 'method') return 'Services';
  return 'Models';
}

function unique<T extends { id: string }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
