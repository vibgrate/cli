import type { BlastRadius, VulnSeverity } from '../../core-open/index.js';

/**
 * Wire types for `vg fix`.
 *
 * The public CLI is a **thin client**: it gathers upgrade candidates (versions
 * across every ecosystem) plus the usage/contract signals it can only measure
 * from the user's own source, and POSTs them to the hosted planner
 * (`POST /v1/fix/plan`). All planning — cross-package compatibility,
 * breaking-change analysis, risk tiering, and the recommendation — happens
 * server-side (it is the product's moat and requires a login/DSN). These types
 * are the request/response contract; no planning logic lives here.
 */

// ── Request (CLI → server) ────────────────────────────────────────────────────

/** Where and how much an installed package is used, measured from the user's source. */
export interface UsageSignal {
  importSites: number;
  filesTouched: number;
}

/** One drifted dependency the client asks the server to plan an upgrade for. */
export interface FixCandidateInput {
  package: string;
  /** Ecosystem id from the scan inventory (npm, pypi, go, rust, ruby, php, dotnet, swift, dart, java, …). */
  ecosystem: string;
  currentVersion: string | null;
  latestVersion: string | null;
  majorsBehind: number | null;
  section?: string;
  /** Present only for ecosystems whose source we can parse cheaply (npm/pypi). */
  usage?: UsageSignal;
  /** Imported API surface the upgrade must preserve — the "contracts". Present when resolvable. */
  contracts?: string[];
}

export interface FixPlanRequest {
  /** CLI version, for server-side compatibility/telemetry. */
  cliVersion: string;
  /** Non-sensitive repository identity, used to associate the breaking-change dataset and cache plans. */
  repository?: { name?: string; vcsSha?: string };
  candidates: FixCandidateInput[];
}

// ── Response (server → CLI) ───────────────────────────────────────────────────

export type UpgradeKind = 'patch' | 'minor' | 'major' | 'unknown';
export type PlanTier = 'safe' | 'balanced' | 'aggressive';
export type PlanConfidence = 'high' | 'moderate' | 'low';

/**
 * A net change in known advisories, by severity. Counts (not ids) because the
 * planner sources them from OSV severity summaries. `total` is the sum.
 */
export interface VulnDelta {
  total: number;
  bySeverity: Record<VulnSeverity, number>;
}

/** A known upgrade playbook attached to a major upgrade (codemod / impacted features). */
export interface UpgradePlaybookRef {
  impactedFeatures: string[];
  automation: string;
  codemod?: string;
}

export interface PlannedUpgrade {
  package: string;
  ecosystem: string;
  from: string | null;
  to: string | null;
  kind: UpgradeKind;
  blastRadius: BlastRadius;
  /** Advisories this upgrade remediates (net, by severity). */
  fixes: VulnDelta;
  reason: string;
  playbook?: UpgradePlaybookRef;
}

export interface ExcludedUpgrade {
  package: string;
  to: string | null;
  reason: string;
}

export interface UpgradePlan {
  tier: PlanTier;
  label: string;
  description: string;
  upgrades: PlannedUpgrade[];
  excluded: ExcludedUpgrade[];
  riskScore: number;
  confidence: PlanConfidence;
  /** Advisories this plan remediates across its upgrades. */
  fixes: VulnDelta;
  /** Advisories this plan would carry into target versions. */
  introduces: VulnDelta;
  /** Estimated DriftScore after applying this plan (0–100, lower = better). Computed client-side. */
  expectedDriftScore?: number;
  /** Estimated DriftScore change vs the current scan (negative = drift reduced). Computed client-side. */
  driftDelta?: number;
}

/** How advisory data was sourced, so the client never reports "0" as "clean" when it is really "unchecked". */
export type VulnDataSource = 'osv' | 'partial' | 'unavailable';

/** The planner's response — rendered by the CLI, emitted verbatim under `--json`. */
export interface FixPlanResponse {
  status: 'ok' | 'error';
  /** Correlation id for support/debugging (GUARDRAILS §1.3). */
  requestId?: string;
  totalCandidates: number;
  plans: UpgradePlan[];
  recommended: PlanTier;
  rationale: string;
  /** Advisories open today that no plan remediates (net, by severity). */
  unresolved: VulnDelta;
  vulnerabilityData: VulnDataSource;
  /** Exploitability rollup: packages with a known-exploited (KEV) advisory, and peak EPSS. */
  exploitability?: { kevPackages: number; maxEpss: number | null };
  deepAnalysis: boolean;
  /** The current DriftScore from the scan, for delta display. Filled in client-side. */
  currentDriftScore?: number;
  error?: string;
}
