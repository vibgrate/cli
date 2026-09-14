/**
 * Sidecar-first paint rules for the architecture map.
 * Kind and file stem are fallbacks only when classify is absent or stale.
 */
import type { GraphNode, VgGraph } from '../../schema.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import {
  PURPOSE_CONFIDENCE_FLOOR,
  PURPOSE_LABEL,
  ROLE_COLOR,
  ROLE_LABEL,
  kindLabel,
  purposeLabel,
  roleLabel,
} from './labels.js';
import type { ArchPolicyId } from './arch-types.js';
import { posixPath } from './packages.js';

export const LANE_CARD_CAP = 12;
export const PURPOSE_FLOOR = PURPOSE_CONFIDENCE_FLOOR;

const WEAK_TITLES = new Set([
  'constructor',
  'headers',
  'page',
  'default',
  'index',
  'handler',
  'render',
  'init',
  'setup',
]);

const DTO_NAME = /(?:Props|Dto|DTO|Request|Response|Error|Args|Options|Config|Type|Schema)$/;

const TEST_PATH = /(?:^|\/)(?:__tests__|tests|test|spec)(?:\/|$)/i;
const TEST_FILE = /\.(?:test|spec|tests)\.[^.]+$/i;

export type LaneId =
  | 'ui'
  | 'app'
  | 'io'
  | 'domain'
  | 'ports'
  | 'adapters_in'
  | 'adapters_out'
  | 'unclassified';

export interface LaneDef {
  id: LaneId;
  title: string;
}

const LAYERED_ROLE: Record<string, LaneId> = {
  user_interface: 'ui',
  controller: 'ui',
  transport: 'ui',
  entry_point: 'ui',
  application_service: 'app',
  use_case: 'app',
  domain_service: 'app',
  port: 'app',
  worker: 'app',
  cross_cutting: 'app',
  repository: 'io',
  persistence: 'io',
  adapter: 'io',
  integration: 'io',
  messaging: 'io',
  infrastructure: 'io',
};

const HEX_ROLE: Record<string, LaneId> = {
  user_interface: 'adapters_in',
  controller: 'adapters_in',
  transport: 'adapters_in',
  entry_point: 'adapters_in',
  application_service: 'app',
  use_case: 'app',
  worker: 'app',
  cross_cutting: 'app',
  domain_model: 'domain',
  domain_service: 'domain',
  port: 'ports',
  adapter: 'adapters_out',
  repository: 'adapters_out',
  persistence: 'adapters_out',
  integration: 'adapters_out',
  messaging: 'adapters_out',
  infrastructure: 'adapters_out',
};

export function architectureBound(
  _graph: VgGraph,
  sidecar: HaileSidecar | null,
  architectureFlag: boolean,
): boolean {
  if (architectureFlag === false) return false;
  // A sibling classify file still paints jobs when its corpus_hash is from
  // the previous rebuild. Requiring a match blanked Architecture on for the
  // whole classify spawn. Node ids that survived keep their jobs; new ids
  // stay unclassified until the replacement file lands.
  return Boolean(sidecar);
}

export function indexSymbols(sidecar: HaileSidecar | null): Map<string, HaileSymbol> {
  const map = new Map<string, HaileSymbol>();
  if (!sidecar) return map;
  for (const s of sidecar.symbols) {
    if (s?.node_id) map.set(s.node_id, s);
  }
  return map;
}

export function resolveRole(symbol: HaileSymbol | undefined): string {
  if (!symbol?.role) return '';
  const primary = symbol.role.primary || '';
  if (primary && primary !== 'unknown' && primary !== 'utility') return primary;
  const alt = symbol.role.alternatives?.find((a) => a?.role && a.role !== 'unknown' && a.role !== 'utility');
  if (alt?.role) return alt.role;
  return primary;
}

export function strongPurposes(symbol: HaileSymbol | undefined): string[] {
  if (!symbol?.purposes) return [];
  return symbol.purposes
    .filter((p) => p && typeof p.purpose === 'string' && (p.confidence ?? 0) >= PURPOSE_FLOOR)
    .map((p) => p.purpose);
}

export function lanesFor(policy: ArchPolicyId): LaneDef[] {
  if (policy === 'hexagonal-v1') {
    return [
      { id: 'adapters_in', title: 'Adapters / UI' },
      { id: 'app', title: 'Application' },
      { id: 'domain', title: 'Domain' },
      { id: 'ports', title: 'Ports' },
      { id: 'adapters_out', title: 'Ports / Infra' },
      { id: 'unclassified', title: 'Unclassified' },
    ];
  }
  return [
    { id: 'ui', title: 'UI / Endpoint' },
    { id: 'app', title: 'Application' },
    { id: 'io', title: 'Persistence / IO' },
    { id: 'unclassified', title: 'Unclassified' },
  ];
}

export function laneOf(
  node: GraphNode,
  symbol: HaileSymbol | undefined,
  policy: ArchPolicyId,
  bound: boolean,
): LaneId {
  if (!bound) {
    if (node.kind === 'route' || node.kind === 'component') return 'ui';
    return 'unclassified';
  }
  const purposes = strongPurposes(symbol);
  if (purposes.includes('test')) return 'unclassified';
  const role = resolveRole(symbol);
  if (role === 'test_support') return 'unclassified';

  let lane: LaneId | undefined;
  if (policy === 'hexagonal-v1') lane = HEX_ROLE[role];
  else lane = LAYERED_ROLE[role];

  const controller = role === 'controller' || role === 'transport';
  for (const p of purposes) {
    if (p === 'render' || p === 'respond') lane = policy === 'hexagonal-v1' ? 'adapters_in' : 'ui';
    else if (p === 'authenticate' || p === 'authorise' || p === 'authorize' || p === 'validate') {
      lane = 'app';
    } else if (
      p === 'persist' ||
      p === 'query' ||
      p === 'file_io' ||
      p === 'cache' ||
      p === 'publish' ||
      p === 'consume' ||
      p === 'subscribe'
    ) {
      lane = policy === 'hexagonal-v1' ? 'adapters_out' : 'io';
    } else if (p === 'network_io' && !controller) {
      lane = policy === 'hexagonal-v1' ? 'adapters_out' : 'io';
    }
  }

  if (role === 'utility' && !lane) return 'unclassified';
  if (role === 'unknown' || role === '') return 'unclassified';
  if (role === 'domain_model' && policy !== 'hexagonal-v1') {
    if (isDtoName(node.name) || isDtoName(node.qualifiedName)) return 'unclassified';
  }
  if (!lane) {
    const layer = symbol?.file_layer || symbol?.ast_role || '';
    if (layer === 'presentation' || layer === 'ui' || layer === 'controller') {
      return policy === 'hexagonal-v1' ? 'adapters_in' : 'ui';
    }
    if (layer === 'data' || layer === 'persistence' || layer === 'infrastructure') {
      return policy === 'hexagonal-v1' ? 'adapters_out' : 'io';
    }
    if (layer === 'application' || layer === 'service') return 'app';
    return 'unclassified';
  }
  return lane;
}

export function isTestNode(node: GraphNode, symbol: HaileSymbol | undefined): boolean {
  if (node.kind === 'test') return true;
  const file = posixPath(node.file);
  if (TEST_PATH.test(file) || TEST_FILE.test(file)) return true;
  if (resolveRole(symbol) === 'test_support') return true;
  if (strongPurposes(symbol).includes('test')) return true;
  return false;
}

export function isDtoLike(node: GraphNode, symbol: HaileSymbol | undefined): boolean {
  if (isDtoName(node.name) || isDtoName(qualifiedLeaf(node))) return true;
  if (node.kind === 'property') return true;
  const role = resolveRole(symbol);
  if (role === 'domain_model' && !strongPurposes(symbol).some((p) => p === 'persist' || p === 'query')) {
    return node.kind === 'interface' || node.kind === 'class' || isDtoName(node.name);
  }
  return false;
}

export function dtoOwnerName(name: string): string | null {
  const leaf = name.split('.').pop() ?? name;
  const stripped = leaf.replace(DTO_NAME, '');
  if (!stripped || stripped === leaf) return null;
  return stripped;
}

function isDtoName(name: string): boolean {
  const leaf = name.split('.').pop() ?? name;
  return DTO_NAME.test(leaf);
}

export function clusterKey(node: GraphNode, _symbol: HaileSymbol | undefined): string {
  const owner = owningType(node);
  if (owner && !isWeak(owner)) return owner;
  if (
    (node.kind === 'component' || node.kind === 'class' || node.kind === 'route') &&
    !isWeak(node.name)
  ) {
    return node.name;
  }
  const dto = dtoOwnerName(node.name) || dtoOwnerName(node.qualifiedName);
  if (dto) return dto;
  const stem = fileStem(node.file);
  if (stem === 'page' && node.name && !isWeak(node.name) && node.name.toLowerCase() !== 'page') {
    return node.name;
  }
  if (stem && !isWeak(stem)) return stem;
  if (node.name && !isWeak(node.name)) return node.name;
  return owner || stem || node.name || node.id;
}

export function cardTitleFor(members: GraphNode[], cluster: string, ghost: boolean, ghostPath?: string): string {
  if (ghost) return ghostPath && ghostPath !== '.' ? ghostPath : members[0]?.name || 'external';
  const ranked = [...members].sort(
    (a, b) => b.importance - a.importance || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const n of ranked) {
    if (!isWeak(n.name) && n.name.toLowerCase() !== cluster.toLowerCase()) {
      if (n.kind === 'component' || n.kind === 'class' || n.kind === 'route') return n.name;
    }
  }
  const best = ranked.find((n) => !isWeak(n.name));
  if (best && !isWeak(cluster)) return /^[A-Z]/.test(cluster) ? cluster : best.name;
  if (!isWeak(cluster)) return cluster;
  return best?.name || cluster;
}

export function rankScore(members: GraphNode[], symbolOf: (id: string) => HaileSymbol | undefined): number {
  let pulse = false;
  let hub = false;
  let entry = false;
  let imp = 0;
  for (const n of members) {
    if (n.isHub) hub = true;
    if (n.importance > imp) imp = n.importance;
    const s = symbolOf(n.id);
    if (s?.findings?.some((f) => typeof f.line === 'number' && f.line > 0)) pulse = true;
    const role = resolveRole(s);
    if (role === 'entry_point' || role === 'controller' || role === 'user_interface') entry = true;
  }
  return (pulse ? 1_000_000 : 0) + (hub ? 100_000 : 0) + (entry ? 10_000 : 0) + imp * 100;
}

export function overflowPhrase(cards: Array<{ job: string; file: string; count: number }>): string {
  const n = cards.reduce((s, c) => s + Math.max(1, c.count), 0);
  const files = new Set(cards.map((c) => c.file)).size;
  const jobs = new Map<string, number>();
  for (const c of cards) jobs.set(c.job, (jobs.get(c.job) ?? 0) + 1);
  let top = 'items';
  let topN = 0;
  for (const [job, count] of jobs) {
    if (count > topN) {
      topN = count;
      top = job.toLowerCase() === 'service' ? 'orchestrators' : `${job.toLowerCase()}s`;
    }
  }
  if (files <= 1) return `${n} more ${top}`;
  return `${n} more ${top} in ${files} files`;
}

export function jobColor(role: string, bound: boolean): string {
  if (!bound || !role || role === 'unknown') return '#64748b';
  return ROLE_COLOR[role] ?? '#94a3b8';
}

export function jobLabel(role: string, bound: boolean, kind: string): string {
  if (!bound) return kindLabel(kind);
  if (!role || role === 'unknown') return 'Unclassified';
  return ROLE_LABEL[role] ?? roleLabel(role);
}

export function purposeChips(symbol: HaileSymbol | undefined): string[] {
  return strongPurposes(symbol)
    .filter((p) => p !== 'test' && p !== 'unknown')
    .slice(0, 2)
    .map((p) => PURPOSE_LABEL[p] ?? purposeLabel(p))
    .filter(Boolean);
}

export function intentLine(symbol: HaileSymbol | undefined): string | null {
  const text = symbol?.intent?.text?.trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function fileStem(file: string): string {
  const base = posixPath(file).split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '');
}

function owningType(node: GraphNode): string | null {
  const q = node.qualifiedName || node.name;
  const i = q.lastIndexOf('.');
  if (i <= 0) return null;
  const owner = q.slice(0, i).split('.').pop();
  if (!owner || isWeak(owner)) return null;
  return owner;
}

function qualifiedLeaf(node: GraphNode): string {
  const q = node.qualifiedName || node.name;
  return q.split('.').pop() ?? q;
}

function isWeak(name: string): boolean {
  return WEAK_TITLES.has(name.toLowerCase());
}

export function dominantRoleLabel(histogram: Record<string, number>): string {
  let best = '';
  let n = -1;
  for (const [role, count] of Object.entries(histogram)) {
    if (role === 'unknown' || role === 'test_support' || role === 'utility') continue;
    if (count > n) {
      n = count;
      best = role;
    }
  }
  if (!best) return 'package';
  if (LAYERED_ROLE[best] === 'ui' || HEX_ROLE[best] === 'adapters_in') return 'Interface';
  if (LAYERED_ROLE[best] === 'io' || HEX_ROLE[best] === 'adapters_out') return 'Data access';
  return ROLE_LABEL[best] ?? roleLabel(best);
}

export function mixPhrase(histogram: Record<string, number>, symbols: number, findings: number): string {
  let ui = 0;
  let service = 0;
  let io = 0;
  for (const [role, count] of Object.entries(histogram)) {
    const lane = LAYERED_ROLE[role] ?? HEX_ROLE[role];
    if (lane === 'ui' || lane === 'adapters_in') ui += count;
    else if (lane === 'io' || lane === 'adapters_out') io += count;
    else if (lane === 'app' || lane === 'domain' || lane === 'ports') service += count;
  }
  const bits = [`${symbols} symbols`];
  if (ui) bits.push(`${ui} UI`);
  if (service) bits.push(`${service} service${service === 1 ? '' : 's'}`);
  if (io) bits.push(`${io} data`);
  bits.push(`${findings} finding${findings === 1 ? '' : 's'}`);
  return bits.join(' · ');
}
