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

export type ArchOverlayKind = 'vulns' | 'drift' | 'ownership' | 'churn';

/**
 * One map overlay. The engine decides whether source data exists and how many
 * nodes paint; the client only toggles and renders. `painted === 0` is not a
 * healthy score — it is an honest empty (see `empty`).
 */
export interface ArchOverlayState {
  kind: ArchOverlayKind;
  /** True when the backing artifact/file/git history was found. */
  source: boolean;
  /** Nodes that carry overlay marks. Absent data is omitted, never zeroed. */
  painted: number;
  /** Operator-facing reason when the overlay cannot paint. */
  empty: string;
}

export interface ArchOverlays {
  vulns: ArchOverlayState;
  drift: ArchOverlayState;
  ownership: ArchOverlayState;
  churn: ArchOverlayState;
}

/** Worst drifted band among joined dependencies. `current` / `unknown` never paint. */
export type ArchDriftBand = 'minor' | 'major';

export interface ArchDriftMark {
  band: ArchDriftBand;
  /** Distinct drifted dependency names, worst band first, capped. */
  packages: string[];
}

export interface ArchOwnershipMark {
  /** CODEOWNERS teams/users for this path, last-match-wins, sorted. */
  teams: string[];
  /** Stable 0–7 colour bucket from the first team. Not a score. */
  tone: number;
}

export interface ArchChurnMark {
  /** Relative heat 1–5 among paths that have git history. Never 0. */
  heat: 1 | 2 | 3 | 4 | 5;
  /** Commit touches in the bounded window. Present only when greater than 0. */
  commits: number;
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
  /** Workspace lane for the board layout: 'ui' | 'app' | 'io' | 'unclassified'. */
  lane: string;
  /** Reachable-vulnerability hits rolled up from files under this package. */
  vulnerabilities?: ArchCardVuln[];
  /** Joined scan drift — omitted when the package has no drifted dependencies. */
  drift?: ArchDriftMark;
  /** CODEOWNERS teams — omitted when no rule matches. */
  owners?: ArchOwnershipMark;
  /** Bounded git churn — omitted when history is unavailable for this path. */
  churn?: ArchChurnMark;
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
  /** Overlay availability + honest empty copy. Absent when the host did not pass a repo root. */
  overlays?: ArchOverlays;
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
  /** Two-letter monogram for an external-service card (no logo pixels ship in the artifact). */
  logoText?: string;
  /** The catalog's canonical provider id (e.g. `stripe`), for resolving a real brand mark. No pixels ship from here — the host UI owns the icon set. */
  providerId?: string;
  /**
   * The hyperscaler/parent brand a specific product belongs to, when the
   * product itself has no brand mark of its own to resolve by `providerId`
   * (a managed database, a serverless product, ...). The host UI falls back
   * to this parent's mark — e.g. `SQL Server` -> `microsoft`, `AWS S3` ->
   * `aws` — same idea as `providerId` but one level up the brand hierarchy.
   * `azure` is kept distinct from `microsoft` even though both currently
   * resolve to the same mark (no redistributable Azure-specific glyph was
   * available), so a real one can be dropped in later without touching this
   * classification.
   */
  vendorFamily?: 'aws' | 'azure' | 'gcp' | 'microsoft' | 'oracle' | 'salesforce' | 'slack' | 'twilio';
  /** Boundary-rule breaches from the module's policy pack (`hexagonal-v1/…`), rolled up from every member. */
  findings?: ArchCardFinding[];
  /** Reachable-vulnerability hits (from `vg scan`'s local reachability query) rolled up from every member. */
  vulnerabilities?: ArchCardVuln[];
  /** Joined scan drift — omitted when this card has no drifted dependencies. */
  drift?: ArchDriftMark;
  /** CODEOWNERS teams — omitted when no rule matches. */
  owners?: ArchOwnershipMark;
  /** Bounded git churn — omitted when history is unavailable for this card's files. */
  churn?: ArchChurnMark;
}

export interface ArchCardFinding {
  rule: string;
  /** `"hard"` (a real boundary violation) or `"warn"` (a smell). */
  severity: 'hard' | 'warn' | string;
  message: string;
  line: number | null;
}

export interface ArchCardVuln {
  advisoryId: string;
  package: string;
  /** `"reachable"` or `"potentially_reachable"` — `not_reached`/`unknown` findings never reach a card. */
  tier: 'reachable' | 'potentially_reachable';
  /** One-line human-readable evidence, e.g. "imported in src/api.ts, called at line 42". */
  evidence?: string;
}

export interface ArchSliceColumn {
  id: string;
  title: string;
  cards: ArchCard[];
  /** Tags this lane as part of the "core" reasoning chain (Application →
   * Domain → Ports) or the "outbound" boundary it hands off to (Adapters /
   * Infrastructure), for the client's CORE/OUTBOUND group banner. Absent on
   * lanes that aren't part of that one directional claim. */
  group?: 'core' | 'outbound';
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
  /** Overlay availability + honest empty copy. Absent when the host did not pass a repo root. */
  overlays?: ArchOverlays;
}

export interface ArchSliceSpec {
  packageId: string;
  view?: ArchSliceView;
  focus?: string;
  cap?: number;
  /** When false, columns follow graph kind rather than sidecar roles. */
  architecture?: boolean;
  tests?: boolean;
  /** Raise the per-lane card cap (clicking “+ N more”). */
  expand?: boolean;
}
