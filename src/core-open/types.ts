// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
// ── Core types for Vibgrate CLI ──

export type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

export type RiskLevel = 'low' | 'moderate' | 'high' | 'none';

export type ProjectType =
  | 'node'
  | 'dotnet'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'php'
  | 'typescript'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'scala'
  | 'r'
  | 'objective-c'
  | 'elixir'
  | 'haskell'
  | 'lua'
  | 'perl'
  | 'julia'
  | 'shell'
  | 'clojure'
  | 'groovy'
  | 'c'
  | 'cpp'
  | 'cobol'
  | 'fortran'
  | 'visual-basic'
  | 'pascal'
  | 'ada'
  | 'assembly'
  | 'rpg';

/**
 * Billing classification for a scanned project ("micro-project pricing").
 *
 * Every package is placed in one of four tiers by source-file count, source
 * byte size and dependency count, satisfying any two of the three limits for
 * the tier:
 *
 * - `'nano'`     — a minimal single-file or single-purpose package (e.g. a
 *   tiny serverless function). Billed at 1/25 of a standard project.
 * - `'micro'`    — a very small package (e.g. a serverless function or
 *   micro-service). Billed at 1/10 of a standard project.
 * - `'small'`    — a modest component. Billed at 1/3 of a standard project.
 * - `'standard'` — a normal product component / solution sub-package. Billed
 *   as one full project.
 *
 * Billing weight is never risk weight: nano, micro and small projects still
 * roll up fully into drift scores and the portfolio view.
 */
export type ProjectClassification = 'nano' | 'micro' | 'small' | 'standard';

export type OutputFormat = 'text' | 'json' | 'sarif' | 'md';

export type ReportFormat = 'md' | 'text' | 'json';

// ── Package.json shape ──

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  /** Corepack field, e.g. "pnpm@9.15.4" or "yarn@4.5.3" */
  packageManager?: string;
  workspaces?: string[] | { packages: string[] };
  engines?: { node?: string; npm?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

// ── npm registry metadata ──

export interface NpmMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
  /** Declared license of the latest version, as reported by the registry. */
  license: string | null;
  /**
   * Optional map of version → ISO-8601 publish date (npm registry `time` field).
   * Present when fetched online or supplied via an offline package-version
   * manifest. Used to compute libyear-based dependency freshness. Absent =>
   * freshness is simply not scored (graceful degradation, offline-safe).
   */
  releaseDates?: Record<string, string>;
}

// ── Per-dependency license evidence ──

/**
 * Authoritative license signal captured for a dependency at scan time.
 * Downstream enrichment (registry/deps.dev/AI) and the canonical license
 * library refine this into a fully classified verdict.
 */
export interface DependencyLicense {
  /** Exact declared license string / SPDX expression (or null when absent). */
  raw: string | null;
  /** Best-effort canonical SPDX id resolved at scan time (or null). */
  spdxId: string | null;
  /** Where the signal came from. */
  source: 'manifest' | 'registry' | 'license-file' | 'none';
  /** 0–1 confidence in the captured signal. */
  confidence: number;
}

// ── Per-dependency analysis row ──

export interface DependencyRow {
  package: string;
  section: DepSection;
  currentSpec: string;
  resolvedVersion: string | null;
  latestStable: string | null;
  majorsBehind: number | null;
  drift: 'current' | 'minor-behind' | 'major-behind' | 'unknown';
  /** Declared license evidence (populated by ecosystem scanners). */
  license?: DependencyLicense;
  /**
   * Calendar age of the resolved version relative to the latest stable, in days.
   * Null when release-date data is unavailable (e.g. offline without a manifest
   * carrying dates). Derived purely from registry/manifest publish dates — no
   * Vibgrate server-side processing required.
   */
  ageDays?: number | null;
  /** ageDays expressed in libyears (ageDays / 365.25). Null when unavailable. */
  libyears?: number | null;
}

// ── Detected framework ──

export interface DetectedFramework {
  name: string;
  currentVersion: string | null;
  latestVersion: string | null;
  majorsBehind: number | null;
}

// ── Project reference (internal project dependency) ──

export interface ProjectReference {
  /** Relative path to the referenced project from the root */
  path: string;
  /** Project name (derived from path or manifest) */
  name: string;
  /** Type of reference: 'project' for .NET ProjectReference, 'workspace' for npm workspace dep */
  refType: 'project' | 'workspace';
}

// ── Per-project scan result ──

export interface ProjectScan {
  type: ProjectType;
  path: string;
  name: string;
  /** Deterministic project ID: SHA-256 hash of `${path}:${name}:${workspaceId}` */
  projectId?: string;
  /** Optional solution identifier when project belongs to a solution/workspace file */
  solutionId?: string;
  /** Optional solution name resolved from solution/workspace metadata */
  solutionName?: string;
  runtime?: string;
  runtimeLatest?: string;
  runtimeMajorsBehind?: number;
  /**
   * Real end-of-life status of this project's runtime cycle, from the Runtime
   * Catalog (endoflife.date): true = past EOL, false = supported, null/undefined
   * = unknown (scoring falls back to the major-version-lag proxy).
   */
  runtimeEol?: boolean | null;
  /** ISO end-of-life date for this project's runtime cycle, when known. */
  runtimeEolDate?: string;
  targetFramework?: string;
  /** Package manager used for this project (e.g. 'pnpm', 'yarn', 'npm', 'bun') */
  packageManager?: string;
  frameworks: DetectedFramework[];
  dependencies: DependencyRow[];
  dependencyAgeBuckets: {
    current: number;
    oneBehind: number;
    twoPlusBehind: number;
    unknown: number;
  };
  /**
   * Aggregate libyear (calendar freshness) data for this project's dependencies.
   * `total` is the sum of per-dependency libyears, `max` the worst single
   * dependency, `measured` the count of dependencies that had release-date data.
   * Absent when no release-date data was available (offline without a
   * date-bearing manifest) — DriftScore then omits the freshness component.
   */
  libyears?: { total: number; max: number; measured: number };
  /** Individual project drift score (computed per-project, then aggregated into artifact.drift) */
  drift?: DriftScore;
  /** References to other projects in the same repository (internal dependencies) */
  projectReferences?: ProjectReference[];
  /** Number of source files in the project directory */
  fileCount?: number;
  /** Total byte size of the source files under the project directory */
  sizeBytes?: number;
  /**
   * Number of dependencies located in the package manager for this project.
   * Mirrors `dependencies.length` but is persisted on the artifact so the
   * billing pipeline does not need to re-derive it.
   */
  dependencyCount?: number;
  /**
   * Billing classification of the project: `'micro'`, `'small'` or
   * `'standard'` (see {@link ProjectClassification}). Used by billing to count
   * smaller projects as a fraction of a standard project.
   */
  classification?: ProjectClassification;
  /** Project-level architecture layer diagram (Mermaid flowchart) */
  architectureMermaid?: string;
  /** Project-level architecture detection result (layers, archetype, file counts) */
  architecture?: ArchitectureResult;
  /** Project-level relationship diagram (first-level parents + children) */
  relationshipDiagram?: MermaidDiagram;
  /** Compacted UI purpose evidence for this project */
  uiPurpose?: CompactUiPurpose;
  /** Base64-encoded favicon for this project, detected from its public/ directory */
  faviconBase64?: string;
}

export interface SolutionScan {
  /** Deterministic solution ID: SHA-256 hash of `${path}:${name}:${workspaceId}` */
  solutionId: string;
  /** Relative path to solution file */
  path: string;
  /** Solution display name */
  name: string;
  /** Solution file type */
  type: 'dotnet-sln';
  /** Projects resolved as belonging to this solution (by relative project path) */
  projectPaths: string[];
  /** Aggregate drift score for all resolved projects in this solution */
  drift?: DriftScore;
  /** Aggregate architecture result for all projects in this solution */
  architecture?: ArchitectureResult;
  /** Solution relationship diagram with top-level solution node and project links */
  relationshipDiagram?: MermaidDiagram;
}

export interface MermaidDiagram {
  mermaid: string;
  svg?: string;
}

// ── Drift score breakdown ──

export interface DriftScore {
  /**
   * DriftScore (`driftscore-2.0`): 0–100 where **0 = no drift (best)** and
   * **100 = maximum drift (worst)**. Higher is worse — consistent with
   * RiskScore and the "drift budget" model. Components below are also drift
   * (0 = fully current).
   */
  score: number;
  riskLevel: RiskLevel;
  components: {
    runtimeScore: number;
    frameworkScore: number;
    dependencyScore: number;
    eolScore: number;
    /**
     * Libyear-based dependency-freshness sub-score as drift (0–100, 0 = fresh).
     * Optional/additive: only present when release-date data was available, so
     * scans without date data are unaffected and remain fully offline-capable.
     */
    freshnessScore?: number;
  };
  /** Which components had sufficient data to score. Missing = no data available. */
  measured?: ('runtime' | 'framework' | 'dependency' | 'eol' | 'freshness')[];
  /**
   * Fraction (0–1) of dependencies whose drift could actually be resolved
   * (known vs. unknown buckets). A low value means the score is based on partial
   * data — surfaced so a low-coverage scan cannot masquerade as a clean result.
   */
  confidence?: number;
  /**
   * Version of the drift-score methodology (weighting + formula) used to compute
   * this score, e.g. `driftscore-2.0`. Bumped only when the weighting or
   * calculation changes — independent of the CLI release version — so the
   * dashboard can compare scores only across matching methodologies. Optional:
   * artifacts from CLIs predating this field will not carry it.
   */
  methodologyVersion?: string;
}

// ── Risk score (security & business risk — distinct from maintainability drift) ──

/** A single vulnerability finding fed into the RiskScore engine. */
export interface RiskVulnerabilityInput {
  /** Advisory / CVE identifier (e.g. "CVE-2024-1234" or "GHSA-xxxx"). */
  id: string;
  /** CVSS base score (0–10). */
  cvss: number;
  /** EPSS probability of exploitation in the wild within 30 days (0–1). */
  epss?: number | null;
  /** Whether the vulnerability is in the CISA Known Exploited Vulnerabilities catalogue. */
  kev?: boolean;
  /** Optional package the finding applies to (for explainability). */
  package?: string;
}

/** SSVC-style business-criticality weighting for the scope being scored. */
export type BusinessCriticality = 'low' | 'normal' | 'high' | 'critical';

/** Inputs to the RiskScore engine. All security/exploitation data is sourced
 *  server-side (premium); the engine itself is a pure, deterministic function. */
export interface RiskScoreInput {
  vulnerabilities: RiskVulnerabilityInput[];
  /** Count of runtimes that are end-of-life / out of vendor support. */
  eolRuntimes?: number;
  /** Count of deprecated / abandoned packages in use. */
  deprecatedPackages?: number;
  /** Business-criticality weight for the scope (defaults to 'normal'). */
  businessCriticality?: BusinessCriticality;
  /** Structural security-hygiene penalty contribution (0–1; e.g. tracked .env). */
  hygienePenalty?: number;
}

export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';

/** A ranked contributor to the RiskScore, for explainability. */
export interface RiskContribution {
  id: string;
  /** Points (0–100 scale) this factor contributed to the final score. */
  contribution: number;
  reason: string;
}

export interface RiskScore {
  /** 0–100, higher = MORE risk (deliberately inverted vs. DriftScore). */
  score: number;
  riskLevel: RiskBand;
  /** Top contributors, ranked — KEV/actively-exploited findings first. */
  topContributors: RiskContribution[];
  /** False when there were no security signals at all (score is 0 by absence). */
  measured: boolean;
  /** Methodology version of the RiskScore engine that produced this result. */
  methodologyVersion: string;
}

// ── Vulnerability detection (open: OSV / air-gap manifest) ──

/** Package ecosystems for which vulnerability advisories can be resolved. */
export type VulnEcosystem =
  | 'npm'
  | 'pypi'
  | 'maven'
  | 'nuget'
  | 'go'
  | 'cargo'
  | 'composer'
  | 'rubygems'
  | 'pub'
  | 'hex';

/** Qualitative severity band. `unknown` distinguishes "no severity data" from a real low. */
export type VulnSeverity = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

/** Commit attribution: who introduced something, and when (from git history). */
export interface CommitAttribution {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** Author date, ISO-8601 (from the commit, never wall-clock). */
  date: string;
  subject: string;
}

/** An affected version range, `[introduced, fixed)` (either bound optional). */
export interface AffectedRange {
  introduced?: string;
  fixed?: string;
}

/** A single advisory affecting an installed package version. */
export interface VulnerabilityAdvisory {
  /** Primary advisory id (e.g. an OSV/GHSA id). */
  id: string;
  /** Alias identifiers, including CVE ids when present. */
  aliases: string[];
  /** Short human-readable summary, when provided. */
  summary: string | null;
  /** Qualitative severity. */
  severity: VulnSeverity;
  /** CVSS v3 base score (0–10), or null when not derivable from the advisory. */
  cvss: number | null;
  /** Raw CVSS vector string, when the advisory carried one. */
  cvssVector: string | null;
  /** First fixed version per affected range (empty when no fix is published). */
  fixedVersions: string[];
  /** ISO-8601 publish date, when known. */
  published: string | null;
  /** ISO-8601 withdrawal date; non-null means the advisory was withdrawn. */
  withdrawn: string | null;
  /** Advisory reference URLs. */
  references: string[];
  /** Affected version ranges for this package (used to attribute exposure over git history). */
  affectedRanges?: AffectedRange[];
  /** Explicit affected versions for this package, complementing ranges. */
  affectedVersions?: string[];
  /**
   * Commit that started the current exposure to this advisory — i.e. when the
   * installed package most recently entered (and stayed in) the affected range.
   * Populated only when `--vulns` runs with git history available; null when
   * unattributable (no git, non-npm ecosystem, or exposure predates the window).
   */
  introduced?: CommitAttribution | null;
  /** Days from {@link introduced} to the scan time (open exposure). Null when not attributable. */
  exposureDays?: number | null;
}

/** All advisories affecting one installed package@version. */
export interface PackageVulnerabilities {
  ecosystem: VulnEcosystem;
  package: string;
  version: string;
  advisories: VulnerabilityAdvisory[];
}

/**
 * CRA-style remediation metrics over currently-open vulnerabilities.
 *
 * Computed from exposure attribution (when did each advisory start applying to
 * the installed code). All time-relative figures use the scan timestamp, not the
 * wall clock, so a scan's metrics are reproducible. Counts distinguish "no data"
 * (null) from zero.
 */
export interface CraRemediationMetrics {
  /** Number of open (currently-affecting) advisories. */
  openCount: number;
  /** Open advisories by severity. */
  openBySeverity: Record<VulnSeverity, number>;
  /** SLA target days per severity used to flag breaches. */
  slaDays: Record<VulnSeverity, number | null>;
  /** Open advisories whose exposure age exceeds their severity SLA. */
  slaBreaches: number;
  /** Longest open exposure in days across attributed advisories, or null if none attributed. */
  maxOpenExposureDays: number | null;
  /** Mean open exposure in days across attributed advisories, or null if none attributed. */
  meanOpenExposureDays: number | null;
  /** How many open advisories had a usable introduction commit (attribution coverage). */
  attributedCount: number;
  /**
   * Closed exposure windows found in git history: a vulnerable version that was
   * later bumped out of the affected range or removed entirely. The real
   * remediation signal, distinct from the still-open exposure above.
   */
  remediatedCount: number;
  /** Mean real remediation time (introduced→remediated) across closed windows — actual MTTR — or null if none. */
  meanRemediationDays: number | null;
  /** Longest real remediation time across closed windows, or null if none. */
  maxRemediationDays: number | null;
}

/** Result of the (opt-in) vulnerability scan. */
export interface VulnerabilityScanResult {
  /**
   * How advisory data was sourced:
   * - `osv` — OSV was reached and answered (empty `packages` means "checked, clean").
   * - `manifest` — advisories matched from an offline package-version manifest.
   * - `unreachable` — OSV could not be reached (all batches failed after retries) and
   *   no manifest data was available. Empty `packages` here means "not checked", NOT
   *   "clean" — callers must distinguish absent from zero (GUARDRAILS §1.4).
   * - `none` — no targets to scan / nothing to report.
   */
  source: 'osv' | 'manifest' | 'unreachable' | 'none';
  /** Packages with at least one advisory affecting the installed version, sorted deterministically. */
  packages: PackageVulnerabilities[];
  /** Total distinct (package, advisory) pairs. */
  totalAdvisories: number;
  /** Count of affected packages by their worst advisory severity. */
  severityCounts: Record<VulnSeverity, number>;
  /** CRA remediation metrics (present when attribution ran). */
  cra?: CraRemediationMetrics;
}

// ── Upgrade impact (open: drift distance × source usage) ──

/** Where and how much an installed package is used in the source tree. */
export interface UpgradeUsage {
  /** Total import/require sites referencing the package. */
  importSites: number;
  /** Distinct source files that reference the package. */
  filesTouched: number;
  /** A few example files (repo-relative), for orientation. */
  sampleFiles: string[];
}

/** How disruptive upgrading a drifted package is likely to be. */
export type BlastRadius = 'none' | 'low' | 'moderate' | 'high';

/** Recommended upgrade posture for a package. */
export type UpgradePosture = 'current' | 'patch-minor' | 'single-major' | 'multi-major-plan';

/** Local "what breaks if I upgrade this" brief for one drifted package. */
export interface UpgradeImpactResult {
  package: string;
  ecosystem: VulnEcosystem | 'unknown';
  currentVersion: string | null;
  latestVersion: string | null;
  majorsBehind: number | null;
  /** Intermediate major lines to step through, e.g. ['6.x','7.x'] for 5 → 8. */
  interimMajors: string[];
  usage: UpgradeUsage;
  blastRadius: BlastRadius;
  recommendation: UpgradePosture;
  /** Open advisory ids fixed by upgrading (when known from the last vuln scan). */
  fixesVulnerabilities: string[];
  /** Human-readable, deterministic notes (interim steps, hotspots, caveats). */
  notes: string[];
}

// ── Finding (for SARIF and text output) ──

export interface Finding {
  ruleId: string;
  level: 'warning' | 'error' | 'note';
  message: string;
  location: string;
  details?: Record<string, unknown>;
}

// ── Version control info ──

export type VcsType = 'git' | 'unknown';

export interface VcsInfo {
  type: VcsType;
  sha?: string;
  shortSha?: string;
  branch?: string;
  remoteUrl?: string;
}

export interface RepositoryInfo {
  name: string;
  version?: string;
  pipeline?: string;
  remoteUrl?: string;
}

// ── Tree summary from pre-scan discovery ──

export interface TreeCount {
  /** Total files discovered (excluding skipped dirs like node_modules, .git, dist) */
  totalFiles: number;
  /** Total subdirectories discovered (excluding skipped dirs) */
  totalDirs: number;
}

// ── Billing roll-up derived from project classifications ──

export interface BillingSummary {
  /** Number of projects classified as `'nano'`. */
  nanoCount: number;
  /** Number of projects classified as `'micro'`. */
  microCount: number;
  /** Number of projects classified as `'small'`. */
  smallCount: number;
  /** Number of projects classified as `'standard'`. */
  standardCount: number;
  /** Total scanned packages (`nanoCount` + `microCount` + `smallCount` + `standardCount`). */
  totalScanned: number;
  /** How many nano projects are billed as one standard project (see {@link NANO_BILLING_RATIO}). */
  nanoBillingRatio: number;
  /** How many micro projects are billed as one standard project (see {@link MICRO_BILLING_RATIO}). */
  microBillingRatio: number;
  /** How many small projects are billed as one standard project (see {@link SMALL_BILLING_RATIO}). */
  smallBillingRatio: number;
  /**
   * Exact fractional project-equivalents: each standard project counts as 1,
   * each small project as 1/`smallBillingRatio`, each micro project as
   * 1/`microBillingRatio` and each nano project as 1/`nanoBillingRatio`.
   * Rounded to 2 decimal places. Used for the estimator and transparency, not
   * as the headline billable figure.
   */
  billableProjectsRaw: number;
  /**
   * Headline billable project count: {@link billableProjectsRaw} **rounded
   * down to the nearest integer**. This is the figure a customer is billed for.
   */
  billableProjects: number;
}

// ── Full scan artifact (stable schema) ──

export interface ScanArtifact {
  schemaVersion: '1.0';
  timestamp: string;
  vibgrateVersion: string;
  rootPath: string;
  vcs?: VcsInfo;
  repository?: RepositoryInfo;
  projects: ProjectScan[];
  solutions?: SolutionScan[];
  drift: DriftScore;
  findings: Finding[];
  baseline?: string;
  delta?: number;
  extended?: ExtendedScanResults;
  /** Scan wall-clock duration in milliseconds */
  durationMs?: number;
  /** Number of manifest/config files scanned */
  filesScanned?: number;
  /** Workspace tree summary (file & directory counts from discovery) */
  treeSummary?: TreeCount;
  /** Workspace-level relationship diagram */
  relationshipDiagram?: MermaidDiagram;
  /** Billing roll-up derived from per-project function/project classifications */
  billing?: BillingSummary;
}

// ── CLI option types ──

export interface ScanOptions {
  out?: string;
  format: OutputFormat;
  failOn?: 'warn' | 'error';
  baseline?: string;
  changedOnly?: boolean;
  concurrency: number;
  /** Auto-push after scan. If set, artifact is uploaded using this DSN (or VIBGRATE_DSN env). */
  push?: boolean;
  dsn?: string;
  /** Override data residency region for push */
  region?: string;
  /** Fail on push errors (like --strict on push command) */
  strict?: boolean;
  /** Enable optional UI-purpose evidence extraction (slower, richer context for dashboard) */
  uiPurpose?: boolean;
  /** Prevent writing .vibgrate JSON artifacts to disk */
  noLocalArtifacts?: boolean;
  /** Enable strongest privacy profile: minimize scanners and suppress local artifacts */
  maxPrivacy?: boolean;
  /** Run without any network calls; drift may be partial without a package manifest */
  offline?: boolean;
  /**
   * Opt in to known-vulnerability scanning. Online, queries the public OSV
   * database; offline, matches advisories carried in a `--package-manifest`.
   * Off by default — vulnerability scanning is a deliberate, separate pass.
   */
  vulns?: boolean;
  /** Path to package-version manifest JSON or ZIP used in offline/privacy workflows */
  packageManifest?: string;
  /** Fail the run if drift score is above this absolute budget */
  driftBudget?: number;
  /** Fail when drift worsens by more than this percentage vs baseline */
  driftWorseningPercent?: number;
  /** Per-project scan timeout override (seconds). Takes precedence over config file. */
  projectScanTimeout?: number;
  /** Additional exclude glob patterns (e.g. from the CLI `--exclude` flag).
   *  Merged with `exclude` from the config file. */
  exclude?: string[];
  /** Version string to embed in scan artifacts (e.g. the CLI or extension version). */
  vibgrateVersion?: string;
  /** Authoritative repository name override. When set, takes precedence over the
   *  directory basename / package.json name (used by scheduled scans that clone
   *  into a generic working directory). */
  repositoryName?: string;
  /** Force a fresh ingest even when the repository is unchanged since the last
   *  scan. Skips the "unchanged → reuse previous ingest" optimization on both
   *  the preflight short-circuit and the ingest upload. Used by scheduled and
   *  dashboard-triggered scans, which should always produce a new report. */
  force?: boolean;
  /**
   * Optional post-scoring step run inside the scan's progress bar, after findings
   * (e.g. building the local code map). Receives a progress reporter
   * `(done, total, phase)` and returns a short detail string for the step.
   * Fail-soft: a thrown error never fails the scan.
   */
  postScan?: (report: (done: number, total: number, phase: string) => void) => Promise<string | void>;
}

export interface InitOptions {
  baseline?: boolean;
  yes?: boolean;
}

export interface ReportOptions {
  in?: string;
  format: ReportFormat;
}

export interface PushOptions {
  dsn?: string;
  file: string;
  strict?: boolean;
}

export interface DsnCreateOptions {
  ingest: string;
  workspace: string;
  write?: string;
}

// ── Config file shape ──

export interface ScannerToggle {
  enabled: boolean;
}

export interface ScannersConfig {
  platformMatrix?: ScannerToggle;
  dependencyRisk?: ScannerToggle;
  dependencyGraph?: ScannerToggle;
  toolingInventory?: ScannerToggle;
  buildDeploy?: ScannerToggle;
  tsModernity?: ScannerToggle;
  breakingChangeExposure?: ScannerToggle;
  fileHotspots?: ScannerToggle;
  securityPosture?: ScannerToggle;
  serviceDependencies?: ScannerToggle;
  architecture?: ScannerToggle;
  codeQuality?: ScannerToggle;
  uiPurpose?: ScannerToggle;
  runtimeConfiguration?: ScannerToggle;
  dataStores?: ScannerToggle;
  apiSurface?: ScannerToggle;
  operationalResilience?: ScannerToggle;
  assetBranding?: ScannerToggle;
  ossGovernance?: ScannerToggle;
}

export interface VibgrateConfig {
  include?: string[];
  exclude?: string[];
  /** Maximum file size (bytes) the CLI will read during a scan. Files larger
   *  than this are silently skipped.  Default: 5 242 880 (5 MB). */
  maxFileSizeToScan?: number;
  /** Per-project scan timeout in seconds.  If a single project takes
   *  longer than this the project is skipped and the path auto-excluded on
   *  the next run.  Increase for very large mono-repos.  Default: 180 (3 min). */
  projectScanTimeout?: number;
  scanners?: ScannersConfig | false;
  thresholds?: {
    failOnError?: {
      eolDays?: number;
      frameworkMajorLag?: number;
      dependencyTwoPlusPercent?: number;
    };
    warn?: {
      frameworkMajorLag?: number;
      dependencyTwoPlusPercent?: number;
    };
  };
}

// ── Extended scanner result types ──

export interface PlatformMatrixResult {
  nodeEngines?: string;
  npmEngines?: string;
  pnpmEngines?: string;
  dotnetTargetFrameworks: string[];
  nativeModules: string[];
  osAssumptions: string[];
  dockerBaseImages: string[];
  nodeVersionFiles: string[];
}

export interface DependencyRiskResult {
  deprecatedPackages: string[];
  nativeModulePackages: string[];
  totalDependencies: number;
}

export interface DuplicatedPackage {
  name: string;
  versions: string[];
  consumers: number;
}

export interface PhantomDependency {
  package: string;
  spec: string;
  sourcePath: string;
}

export interface DependencyGraphResult {
  lockfileType: string | null;
  totalUnique: number;
  totalInstalled: number;
  duplicatedPackages: DuplicatedPackage[];
  phantomDependencies: string[];
  phantomDependencyDetails?: PhantomDependency[];
}

export interface InventoryItem {
  name: string;
  package: string;
  version: string | null;
}

export interface ToolingInventoryResult {
  frontend: InventoryItem[];
  metaFrameworks: InventoryItem[];
  bundlers: InventoryItem[];
  css: InventoryItem[];
  backend: InventoryItem[];
  orm: InventoryItem[];
  testing: InventoryItem[];
  lintFormat: InventoryItem[];
  apiMessaging: InventoryItem[];
  observability: InventoryItem[];
}

export interface BuildDeployResult {
  ci: string[];
  ciWorkflowCount: number;
  docker: { dockerfileCount: number; baseImages: string[] };
  iac: string[];
  releaseTooling: string[];
  packageManagers: string[];
  monorepoTools: string[];
}

export interface TsModernityResult {
  typescriptVersion: string | null;
  strict: boolean | null;
  noImplicitAny: boolean | null;
  strictNullChecks: boolean | null;
  module: string | null;
  moduleResolution: string | null;
  target: string | null;
  moduleType: 'esm' | 'cjs' | 'mixed' | null;
  exportsField: boolean;
}

export type UpgradeRecommendation = 'do-nothing' | 'upgrade-safely-now' | 'plan-major-upgrade' | 'codemod-available' | 'manual-hotspots';

export interface BreakingChangePackageIntelligence {
  package: string;
  currentVersion: string | null;
  targetVersion: string | null;
  majorJumpCount: number;
  interimMajors: string[];
  releaseNoteSources: string[];
  parsedSignals: string[];
  impactedFeatures: string[];
  usage: {
    importSites: number;
    filesTouchedEstimate: number;
    functionsTouchedEstimate: number;
    touchedPercent: number;
  };
  automatable: 'codemod-available' | 'deterministic-recipe' | 'manual';
  codemod?: string;
}

export interface BreakingChangeProjectIntelligence {
  project: string;
  projectPath: string;
  packages: BreakingChangePackageIntelligence[];
  recommendation: UpgradeRecommendation;
}

export interface BreakingChangeSolutionIntelligence {
  solutionId: string;
  solutionName: string;
  projectCount: number;
  majorPackages: number;
  recommendation: UpgradeRecommendation;
}

export interface BreakingChangeExposureResult {
  deprecatedPackages: string[];
  legacyPolyfills: string[];
  peerConflictsDetected: boolean;
  exposureScore: number;
  projectIntelligence: BreakingChangeProjectIntelligence[];
  solutionIntelligence: BreakingChangeSolutionIntelligence[];
  overallRecommendation: UpgradeRecommendation;
}

export interface FileHotspot {
  path: string;
  bytes: number;
}

export interface PackageCentrality {
  name: string;
  referencedInProjects: number;
}

export interface FileHotspotsResult {
  fileCountByExtension: Record<string, number>;
  largestFiles: FileHotspot[];
  totalFiles: number;
  maxDirectoryDepth: number;
  mostUsedPackages: PackageCentrality[];
}

export interface SecurityPostureResult {
  lockfilePresent: boolean;
  multipleLockfileTypes: boolean;
  gitignoreCoversEnv: boolean;
  gitignoreCoversNodeModules: boolean;
  envFilesTracked: boolean;
  lockfileTypes: string[];
}

export interface ServiceDependencyItem {
  name: string;
  package: string;
  version: string | null;
}

export interface ServiceDependenciesResult {
  payment: ServiceDependencyItem[];
  auth: ServiceDependencyItem[];
  email: ServiceDependencyItem[];
  cloud: ServiceDependencyItem[];
  databases: ServiceDependencyItem[];
  messaging: ServiceDependencyItem[];
  observability: ServiceDependencyItem[];
  crm: ServiceDependencyItem[];
  storage: ServiceDependencyItem[];
  search: ServiceDependencyItem[];
}

// ── Architecture layer detection types ──

/** Detected project archetype (fingerprint) */
export type ProjectArchetype =
  | 'nextjs'
  | 'remix'
  | 'sveltekit'
  | 'nuxt'
  | 'nestjs'
  | 'express'
  | 'fastify'
  | 'hono'
  | 'koa'
  | 'serverless'
  | 'library'
  | 'cli'
  | 'monorepo'
  | 'unknown';

/** Architectural layer classification */
export type ArchitectureLayer =
  | 'routing'
  | 'middleware'
  | 'services'
  | 'domain'
  | 'data-access'
  | 'infrastructure'
  | 'presentation'
  | 'config'
  | 'testing'
  | 'shared';

/** A single file classified into a layer */
export interface LayerClassification {
  /** Relative path from project root */
  filePath: string;
  /** Assigned architectural layer */
  layer: ArchitectureLayer;
  /** Confidence of classification (0–1) */
  confidence: number;
  /** Top signals that contributed to classification */
  signals: string[];
}

/** Per-layer aggregated data */
export interface LayerSummary {
  /** The layer name */
  layer: ArchitectureLayer;
  /** Number of files in this layer */
  fileCount: number;
  /** Drift score for dependencies used in this layer (0 = no drift / best, 100 = worst; also 0 when no packages to track) */
  driftScore: number;
  /** Risk level derived from drift score ('none' when no packages to track) */
  riskLevel: RiskLevel;
  /** Tech stack components detected in this layer */
  techStack: InventoryItem[];
  /** Services/integrations used in this layer */
  services: ServiceDependencyItem[];
  /** Packages referenced in this layer with their drift status */
  packages: LayerPackageRef[];
}

/** Package reference within a layer */
export interface LayerPackageRef {
  name: string;
  version: string | null;
  latestStable: string | null;
  majorsBehind: number | null;
  drift: 'current' | 'minor-behind' | 'major-behind' | 'unknown';
}

/** Full architecture detection result */
export interface ArchitectureResult {
  /** Detected project archetype */
  archetype: ProjectArchetype;
  /** Confidence of archetype detection (0–1) */
  archetypeConfidence: number;
  /** Per-layer summaries with drift + tech data */
  layers: LayerSummary[];
  /** Total files classified */
  totalClassified: number;
  /** Files that could not be classified */
  unclassified: number;
}

export interface GodFile {
  path: string;
  lines: number;
  functionCount: number;
  averageComplexity: number;
}

export interface CodeQualityResult {
  filesAnalyzed: number;
  functionsAnalyzed: number;
  avgCyclomaticComplexity: number;
  avgFunctionLength: number;
  maxNestingDepth: number;
  godFiles: GodFile[];
  circularDependencies: number;
  deadCodePercent: number;
}

export interface UiPurposeEvidenceItem {
  kind: 'route' | 'nav' | 'title' | 'heading' | 'cta' | 'copy' | 'dependency' | 'feature_flag';
  value: string;
  file: string;
  weight: number;
}

/** Compacted UI evidence for LLM inference - reduces token usage by ~80-90% */
export interface CompactUiPurpose {
  /** Top unique samples per category (typically ~40-60 items) */
  samples: Array<{ kind: string; value: string; category: string }>;
  /** Count of evidence items per semantic category */
  categoryCounts: Record<string, number>;
  /** Total evidence count before compaction */
  originalCount: number;
  /** High-signal dependencies (stripe, auth0, etc.) */
  dependencies: string[];
  /** Deduplicated route patterns */
  routes: string[];
  /** Detected UI frameworks (nextjs, react, vue, etc.) */
  detectedFrameworks: string[];
}

export interface UiPurposeResult {
  enabled: boolean;
  detectedFrameworks: string[];
  evidenceCount: number;
  capped: boolean;
  topEvidence: UiPurposeEvidenceItem[];
  unknownSignals: string[];
}

export interface RuntimeConfigurationResult {
  environmentVariables: string[];
  featureFlags: string[];
  hiddenConfigFiles: string[];
  dotEnvFiles: string[];
  secretsInjectionPaths: string[];
  containerEntrypoints: string[];
  startupArguments: string[];
  jvmFlags: string[];
  threadPoolSettings: string[];
}

export interface DatabaseTechnology {
  kind: 'sql' | 'nosql';
  brand: string;
  version: string | null;
  evidence: string;
}

export interface DataStoresResult {
  databaseTechnologies: DatabaseTechnology[];
  connectionStrings: string[];
  connectionPoolSettings: string[];
  replicationSettings: string[];
  readReplicaSettings: string[];
  failoverSettings: string[];
  collationAndEncoding: string[];
  queryTimeoutDefaults: string[];
  manualIndexes: string[];
  tables: string[];
  views: string[];
  storedProcedures: string[];
  triggers: string[];
  rowLevelSecurityPolicies: string[];
  otherServices: string[];
}

export interface OpenApiSpecification {
  path: string;
  format: 'json' | 'yaml' | 'yml';
  version: string | null;
  title: string | null;
  endpointCount: number | null;
}

export interface ApiIntegration {
  provider: string;
  endpoint: string;
  version: string | null;
  parameters: string[];
  configOptions: string[];
  authHints: string[];
  files: string[];
}

export interface ApiSurfaceResult {
  integrations: ApiIntegration[];
  openApiSpecifications: OpenApiSpecification[];
  webhookUrls: string[];
  callbackEndpoints: string[];
  apiVersionPins: string[];
  tokenExpirationPolicies: string[];
  rateLimitOverrides: string[];
  customHeaders: string[];
  corsPolicies: string[];
  oauthScopes: string[];
  apiTokens: string[];
}

export interface OperationalResilienceResult {
  implicitTimeouts: string[];
  defaultPaginationSize: string[];
  implicitRetryLogic: string[];
  defaultLocale: string[];
  defaultCurrency: string[];
  implicitTimezone: string[];
  defaultCharacterEncoding: string[];
  sessionStores: string[];
  distributedLocks: string[];
  jobSchedulers: string[];
  idempotencyKeys: string[];
  rateLimitingCounters: string[];
  circuitBreakerState: string[];
  abTestToggles: string[];
  regionalEnablementRules: string[];
  betaAccessGroups: string[];
  licensingEnforcementLogic: string[];
  killSwitches: string[];
  connectorRetryLogic: string[];
  apiPollingIntervals: string[];
  fieldMappings: string[];
  schemaRegistryRules: string[];
  deadLetterQueueBehavior: string[];
  dataMaskingRules: string[];
  transformationLogic: string[];
  timezoneHandling: string[];
  encryptionSettings: string[];
  hardcodedSecretSignals: string[];
}

export interface AssetBrandingResult {
  faviconFiles: Array<{ path: string; base64: string }>;
  productLogos: string[];
}

export interface OssGovernanceResult {
  directDependencies: number;
  transitiveDependencies: number;
  knownVulnerabilities: string[];
  licenseRisks: string[];
}

// ── Standards matching (purpose -> recommended standards) ──

/** Inferred high-level purpose of a project, used to match standards. */
export interface ProjectPurpose {
  project: string;
  /** Coarse purpose category, e.g. 'api', 'web-app', 'library', 'cli', 'data', 'ml', 'infra'. */
  category: string;
  /** 0–1 confidence in the inference. */
  confidence: number;
  /** Human-readable signals that drove the inference. */
  signals: string[];
}

/** A standard recommended for a scanned repository. */
export interface RecommendedStandard {
  slug: string;
  name: string;
  category: string;
  /** Why it was recommended (matched purpose/domain/framework). */
  reason: string;
  /** Project purpose categories this standard applies to. */
  matchedProjectTypes: string[];
  /** Compliance frameworks this standard supports. */
  frameworks: string[];
  complianceRelevant: boolean;
  officialUrl: string | null;
}

/** Coverage of a compliance framework by the recommended standard set. */
export interface FrameworkCoverage {
  id: string;
  name: string;
  recommendedMembers: number;
  totalMembers: number;
}

/** Output of the offline purpose->standards matcher (artifact.extended.standards). */
export interface StandardsRecommendations {
  projectPurposes: ProjectPurpose[];
  recommended: RecommendedStandard[];
  frameworks: FrameworkCoverage[];
}

export interface ExtendedScanResults {
  platformMatrix?: PlatformMatrixResult;
  dependencyRisk?: DependencyRiskResult;
  dependencyGraph?: DependencyGraphResult;
  toolingInventory?: ToolingInventoryResult;
  buildDeploy?: BuildDeployResult;
  tsModernity?: TsModernityResult;
  breakingChangeExposure?: BreakingChangeExposureResult;
  fileHotspots?: FileHotspotsResult;
  securityPosture?: SecurityPostureResult;
  serviceDependencies?: ServiceDependenciesResult;
  architecture?: ArchitectureResult;
  codeQuality?: CodeQualityResult;
  uiPurpose?: UiPurposeResult;
  runtimeConfiguration?: RuntimeConfigurationResult;
  dataStores?: DataStoresResult;
  apiSurface?: ApiSurfaceResult;
  operationalResilience?: OperationalResilienceResult;
  assetBranding?: AssetBrandingResult;
  ossGovernance?: OssGovernanceResult;
  /** Recommended standards/best-practices matched to the repo's detected purpose (offline). */
  standards?: StandardsRecommendations;
  /**
   * Known-vulnerability findings for installed package versions. Populated only
   * when vulnerability scanning is opted in (`--vulns`, online via OSV) or when
   * an offline package-version manifest carries advisory data. Absent otherwise —
   * never fabricated, so "no field" means "not scanned", not "no vulnerabilities".
   */
  vulnerabilities?: VulnerabilityScanResult;
  /**
   * Provenance of the Runtime Catalog used to compute runtime currency and EOL —
   * where it was resolved from (live API, local cache, offline manifest, or the
   * bundled snapshot) and when it was generated. Surfaced as a freshness/
   * confidence signal.
   */
  runtimeCatalogInfo?: RuntimeCatalogInfo;
}

/** Confidence/freshness disclosure for the Runtime Catalog used in a scan. */
export interface RuntimeCatalogInfo {
  /** ISO timestamp the catalog was generated by endoflife.date. */
  generatedAt: string;
  /** Where the catalog was resolved from. */
  source: 'cache' | 'api' | 'manifest' | 'bundled';
  /** True when the catalog is older than the freshness threshold (soft warning). */
  stale: boolean;
}
