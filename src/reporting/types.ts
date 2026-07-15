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
  /** Individual project drift score (computed per-project, then aggregated into artifact.drift) */
  drift?: DriftScore;
  /** References to other projects in the same repository (internal dependencies) */
  projectReferences?: ProjectReference[];
  /** Number of source files in the project directory */
  fileCount?: number;
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
   * Aggregate drift score, 0–100. Lower is better: 0 = no drift, 100 = maximum drift.
   * Risk bands: 0–30 = low, 31–60 = moderate, 61–100 = high.
   */
  score: number;
  riskLevel: RiskLevel;
  /** Per-component drift scores (0 = no drift, 100 = maximum drift). */
  components: {
    runtimeScore: number;
    frameworkScore: number;
    dependencyScore: number;
    eolScore: number;
  };
  /** Which components had sufficient data to score. Missing = no data available. */
  measured?: ('runtime' | 'framework' | 'dependency' | 'eol')[];
  /**
   * Version of the drift-score methodology (weighting + formula) used to compute
   * this score, e.g. `driftscore-2.0`. Bumped only when the weighting or
   * calculation changes — independent of the CLI release version — so the
   * dashboard can compare scores only across matching methodologies. Optional:
   * artifacts from CLIs predating this field will not carry it.
   */
  methodologyVersion?: string;
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
  /** Path to package-version manifest JSON or ZIP used in offline/privacy workflows */
  packageManifest?: string;
  /** Fail the run if drift score is above this absolute budget */
  driftBudget?: number;
  /** Fail when drift worsens by more than this percentage vs baseline */
  driftWorseningPercent?: number;
  /** Per-project scan timeout override (seconds). Takes precedence over config file. */
  projectScanTimeout?: number;
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

/**
 * Per-field override of the default upload-compaction caps for the
 * `databaseSchema` scanner (see `compactDatabaseSchema` in
 * `utils/compact-artifact.ts` and DOCS.md § Database Schema). Any field left
 * unset keeps its built-in default. Raising these only affects how much of
 * the *local* scan result survives compaction before upload — the ingest API
 * enforces its own fixed hard ceiling on top, regardless of what's configured
 * here, so a payload can never grow unbounded even from a misconfigured or
 * non-CLI client.
 */
export interface DatabaseSchemaUploadCaps {
  maxModels?: number;
  maxFieldsPerModel?: number;
  maxFilesPerModel?: number;
  maxFilesScanned?: number;
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
  databaseSchema?: ScannerToggle & DatabaseSchemaUploadCaps;
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
  /** Drift score for dependencies used in this layer (0–100, 0 when no packages to track) */
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

/**
 * Which scanner produced a {@link DatabaseModel}. Models are never merged or
 * deduped by name *across* sources — a `users` table found in a raw SQL
 * migration and a `User` Prisma model are not assumed to be the same thing,
 * even when their names coincide. Each source keeps its own dedup pass.
 */
export type DatabaseModelSource = 'prisma' | 'sql-migration' | 'sqlproj' | 'drizzle' | 'typeorm';

/** A single field/column on a {@link DatabaseModel}. Never carries attribute
 * *values* (e.g. Prisma's `@default(...)`, a SQL `DEFAULT ...` value, or a
 * decorator's non-name arguments) — only structural facts. */
export interface DatabaseField {
  name: string;
  /** Base type name/keyword as detected by the source parser, e.g. `String`,
   *  `Post` (Prisma), `VARCHAR(255)` (SQL), `text` (Drizzle builder name), or
   *  the declared TS type (TypeORM). Best-effort, never evaluated. */
  type: string;
  /** True when the field type is a list/array (or a `*ToMany` relation). */
  isList: boolean;
  /** True when the field type is optional/nullable. */
  isOptional: boolean;
  /** True when the type is another model/table, or an explicit relation
   *  annotation/decorator/`REFERENCES` clause is present. */
  isRelation: boolean;
  /** True when the field is (part of) the primary key. */
  isId: boolean;
  /** True when the field carries a uniqueness constraint. */
  isUnique: boolean;
}

/** A database model — a Prisma `model` block, a SQL `CREATE TABLE`, a Drizzle
 * `pgTable`/`mysqlTable`/`sqliteTable` call, or a TypeORM `@Entity` class. */
export interface DatabaseModel {
  name: string;
  fields: DatabaseField[];
  /** Which scanner produced this model — see {@link DatabaseModelSource}. */
  source: DatabaseModelSource;
  /** File(s) (relative to rootDir) this model was extracted from. */
  files: string[];
}

/** A Prisma `enum` block. */
export interface DatabaseEnum {
  name: string;
  values: string[];
}

/** Per-project breakdown of database-schema files/models/enums, across all sources. */
export interface DatabaseSchemaProjectSummary {
  /** Project path (relative to rootDir), matching `ProjectScan.path`. */
  project: string;
  /** Schema/migration/entity files attributed to this project, relative to rootDir. */
  filesScanned: string[];
  /** Model names defined within this project's files (any source). */
  models: string[];
  /** Enum names defined within this project's files (Prisma only). */
  enums: string[];
}

/**
 * Structured, deterministic database-schema scan result, merged across all
 * supported sources (Prisma, raw SQL migrations, SQL Server database
 * projects, Drizzle, TypeORM). Only structural facts — model/table names,
 * field/column names/types, relation/list/optional/id/unique flags, and enum
 * names/values. Never a raw source line, connection string, or credential —
 * see the doc comment at the top of `advanced-analysis.ts` and
 * `scanners/database-schema.ts` for why.
 */
export interface DatabaseSchemaResult {
  /** Datasource providers detected (e.g. `postgresql`, `mysql`, `sqlite`). Never includes the `url` value. */
  providers: string[];
  models: DatabaseModel[];
  enums: DatabaseEnum[];
  /** All schema/migration/entity files scanned (any source), relative to rootDir. */
  filesScanned: string[];
  /** Per-project breakdown. */
  projects: DatabaseSchemaProjectSummary[];
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

export interface ProjectPurpose {
  project: string;
  category: string;
  confidence: number;
  signals: string[];
}

export interface RecommendedStandard {
  slug: string;
  name: string;
  category: string;
  reason: string;
  matchedProjectTypes: string[];
  frameworks: string[];
  complianceRelevant: boolean;
  officialUrl: string | null;
}

export interface FrameworkCoverage {
  id: string;
  name: string;
  recommendedMembers: number;
  totalMembers: number;
}

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
  databaseSchema?: DatabaseSchemaResult;
  uiPurpose?: UiPurposeResult;
  runtimeConfiguration?: RuntimeConfigurationResult;
  dataStores?: DataStoresResult;
  apiSurface?: ApiSurfaceResult;
  operationalResilience?: OperationalResilienceResult;
  assetBranding?: AssetBrandingResult;
  ossGovernance?: OssGovernanceResult;
  standards?: StandardsRecommendations;
}
