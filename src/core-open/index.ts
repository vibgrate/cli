// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
// @vibgrate/core-open — the open base scanning engine (Apache-2.0).
// Fact collection, drift scoring, formatters, registry caches, runtimes, and the
// open base scan runner. Contains NO proprietary advanced analysis; that lives in
// @vibgrate/core (the private package that depends on this one).

// ── Types ──────────────────────────────────────────────────────────────────
export type * from './types.js';

// ── Config ─────────────────────────────────────────────────────────────────
export { loadConfig, appendExcludePatterns, writeDefaultConfig } from './config.js';

// ── Scoring (open) ───────────────────────────────────────────────────────────
export {
  computeDriftScore,
  generateFindings,
  computeProjectId,
  computeSolutionId,
  DRIFT_SCORE_METHODOLOGY_VERSION,
} from './scoring/drift-score.js';
export {
  ageDaysBetween,
  daysToLibyears,
  aggregateLibyears,
  freshnessScoreFromLibyears,
  type LibyearAggregate,
} from './scoring/libyear.js';
export {
  DRIFT_SCORE_AMBER_MAX,
  DRIFT_SCORE_GREEN_MAX,
  driftBadgeStatusFromScore,
  formatDriftBadgeScore,
  LABEL_BACKGROUND,
  STATUS_COLOURS,
  statusColour,
  type DriftBadgeStatus,
} from './scoring/drift-badge.js';

// ── Formatters ─────────────────────────────────────────────────────────────
export { formatText } from './formatters/text.js';
export { formatSarif } from './formatters/sarif.js';
export { formatMarkdown } from './formatters/markdown.js';

// ── Scanners (fact collection) ───────────────────────────────────────────────
export { scanNodeProjects } from './scanners/node-scanner.js';
export { scanDotnetProjects } from './scanners/dotnet-scanner.js';
export { scanPythonProjects } from './scanners/python-scanner.js';
export { scanJavaProjects } from './scanners/java-scanner.js';
export { scanRubyProjects } from './scanners/ruby-scanner.js';
export { scanSwiftProjects } from './scanners/swift-scanner.js';
export { scanGoProjects } from './scanners/go-scanner.js';
export { scanRustProjects } from './scanners/rust-scanner.js';
export { scanPhpProjects } from './scanners/php-scanner.js';
export { scanDartProjects } from './scanners/dart-scanner.js';
export { scanElixirProjects } from './scanners/elixir-scanner.js';
export { scanDockerProjects } from './scanners/docker-scanner.js';
export { scanHelmProjects } from './scanners/helm-scanner.js';
export { scanTerraformProjects } from './scanners/terraform-scanner.js';
export { scanPolyglotProjects } from './scanners/polyglot-scanner.js';

// ── Project size categorisation + billable rollup (open; rates are server-side) ──
export {
  classifyProject,
  summarizeBilling,
  normalizeClassification,
  classificationBillingWeight,
  MICRO_MAX_FILES,
  MICRO_MAX_SIZE_BYTES,
  MICRO_MAX_DEPENDENCIES,
  SMALL_MAX_FILES,
  SMALL_MAX_SIZE_BYTES,
  SMALL_MAX_DEPENDENCIES,
  MICRO_BILLING_RATIO,
  SMALL_BILLING_RATIO,
  STANDARD_BILLING_RATIO,
  type ProjectClassificationInput,
} from './scanners/project-classification.js';

// ── Registry caches ────────────────────────────────────────────────────────
export { NpmCache, checkRegistryAccess } from './scanners/npm-cache.js';
export { NuGetCache } from './scanners/nuget-cache.js';
export { PyPICache } from './scanners/pypi-cache.js';
export { MavenCache } from './scanners/maven-cache.js';
export { RubyGemsCache } from './scanners/rubygems-cache.js';
export { SwiftCache } from './scanners/swift-cache.js';
export { GoCache } from './scanners/go-cache.js';
export { CargoCache } from './scanners/cargo-cache.js';
export { ComposerCache } from './scanners/composer-cache.js';
export { PubCache } from './scanners/pub-cache.js';

// ── Utilities ──────────────────────────────────────────────────────────────
export {
  pathExists,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
  readTextFile,
  ensureDir,
  FileCache,
  quickTreeCount,
  findFiles,
  findPackageJsonFiles,
  type DirEntry,
} from './utils/fs.js';
export { Semaphore } from './utils/semaphore.js';
export { parseExcludePatterns, compileGlobs } from './utils/glob.js';
export { detectVcs } from './utils/vcs.js';
export {
  generateWorkspaceRelationshipMermaid,
  generateProjectRelationshipMermaid,
  generateSolutionRelationshipMermaid,
} from './utils/mermaid.js';
export { fetchLatestVersion } from './utils/update-check.js';
export { compactUiPurpose } from './utils/compact-evidence.js';
export { prepareCompressedUpload } from './utils/compact-artifact.js';
export { parseDsn } from './utils/dsn.js';
export { fetchScanPreflight } from './utils/scan-preflight.js';
export type { ScanPreflightResponse } from './utils/scan-preflight.js';
export { resolveRepositoryName } from './utils/repository-name.js';
export { computeRepoFingerprint, computeTreeMetadataHash } from './utils/repo-fingerprint.js';
export type { RepoFingerprint } from './utils/repo-fingerprint.js';

// ── Package-version manifest (offline/privacy mode) ───────────────────────
export { loadPackageVersionManifest } from './package-version-manifest.js';

// ── Open base scan runner ────────────────────────────────────────────────────
export { runCoreScan } from './run-core-scan.js';
export type { CoreScanContext, AdvancedScanHook } from './run-core-scan.js';
