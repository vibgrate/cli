/**
 * Hierarchical architecture map payloads.
 *
 * L0 = workspace (packages). L1 = one project, collapsed into policy columns.
 * Never a 1:1 dump of the  graph. Painted node count is capped.
 */
export const ARCH_OVERVIEW_MAGIC = 'vg.arch.overview.v1' as const;
export const ARCH_SLICE_MAGIC = 'vg.arch.slice.v1' as const;
export const SLICE_CARD_CAP = 120;
export const LANE_CARD_CAP = 12;
export const OVERVIEW_PACKAGE_CAP = 200;
export const INSPECTOR_NEIGHBOUR_CAP = 40;

export type ArchZoom = 'workspace' | 'slice';
export type ArchSliceView = 'job' | 'calls' | 'missing' | 'problems';
export type ArchPolicyId = 'layered-v1' | 'hexagonal-v1' | 'kind';
export type ArchPageHost = 'browser' | 'vscode';

export function parseArchView(raw: string | null | undefined): ArchSliceView {
  if (raw === 'calls' || raw === 'missing' || raw === 'problems') return raw;
  return 'job';
}

export interface ArchPackageNode {
  id: string;
  name: string;
  path: string;
  kind: 'package' | 'area' | 'root';
  symbols: number;
  findings: number;
  missingSteps: number;
  job: string;
  policy: string | null;
  /** Dominant-role mix, e.g. "32 symbols · 3 UI · 1 service · 0 findings". */
  mix?: string;
  unclassified?: number;
}

export interface ArchPackageEdge {
  id: string;
  src: string;
  dst: string;
  kind: string;
  weight: number;
}

export interface ArchOverviewMeta {
  architectureLoaded: boolean;
  policy: string | null;
  policyLabel: string | null;
  symbols: number;
  packages: number;
  findings: number;
  missingSteps: number;
  title: string;
}

export interface ArchOverview {
  magic: typeof ARCH_OVERVIEW_MAGIC;
  packages: ArchPackageNode[];
  edges: ArchPackageEdge[];
  meta: ArchOverviewMeta;
}

export interface ArchCardLink {
  id: string;
  name: string;
}

export interface ArchCardMember {
  id: string;
  name: string;
  job: string;
  file: string;
  line: number | null;
}

export interface ArchCard {
  id: string;
  title: string;
  subtitle: string;
  lane: string;
  file: string;
  line: number | null;
  symbolId: string;
  count: number;
  job: string;
  color: string;
  classified: boolean;
  pulse: boolean;
  missingStep: boolean;
  ghost?: boolean;
  intent?: string | null;
  callsOut?: number;
  calls?: ArchCardLink[];
  calledBy?: ArchCardLink[];
  members?: ArchCardMember[];
  types?: string[];
  guard?: boolean;
}

export interface ArchSliceColumn {
  id: string;
  title: string;
  cards: ArchCard[];
}

export interface ArchSliceEdge {
  id: string;
  src: string;
  dst: string;
  kind: string;
}

export interface ArchSlice {
  magic: typeof ARCH_SLICE_MAGIC;
  packageId: string;
  packageName: string;
  policy: ArchPolicyId;
  columns: ArchSliceColumn[];
  guards: ArchCard[];
  edges: ArchSliceEdge[];
  overflow: Record<string, number>;
  overflowHint?: Record<string, string>;
  emptyHint?: string | null;
  focusCardId: string | null;
}

export interface ArchSliceSpec {
  packageId: string;
  view?: ArchSliceView;
  focus?: string;
  cap?: number;
  /** When false, columns follow graph kind rather than sidecar roles. */
  architecture?: boolean;
  tests?: boolean;
}
