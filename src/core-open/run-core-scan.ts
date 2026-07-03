// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import chalk from 'chalk';
import { scanNodeProjects } from './scanners/node-scanner.js';
import { scanDotnetProjects } from './scanners/dotnet-scanner.js';
import { scanPythonProjects } from './scanners/python-scanner.js';
import { scanJavaProjects } from './scanners/java-scanner.js';
import { scanRubyProjects } from './scanners/ruby-scanner.js';
import { scanSwiftProjects } from './scanners/swift-scanner.js';
import { scanGoProjects } from './scanners/go-scanner.js';
import { scanRustProjects } from './scanners/rust-scanner.js';
import { scanPhpProjects } from './scanners/php-scanner.js';
import { scanDartProjects } from './scanners/dart-scanner.js';
import { scanElixirProjects } from './scanners/elixir-scanner.js';
import { scanDockerProjects } from './scanners/docker-scanner.js';
import { scanHelmProjects } from './scanners/helm-scanner.js';
import { scanTerraformProjects } from './scanners/terraform-scanner.js';
import { scanPolyglotProjects } from './scanners/polyglot-scanner.js';
import { NpmCache, checkRegistryAccess } from './scanners/npm-cache.js';
import { RuntimeCatalogClient } from './runtimes/client.js';
import { NuGetCache } from './scanners/nuget-cache.js';
import { PyPICache } from './scanners/pypi-cache.js';
import { MavenCache } from './scanners/maven-cache.js';
import { RubyGemsCache } from './scanners/rubygems-cache.js';
import { SwiftCache } from './scanners/swift-cache.js';
import { GoCache } from './scanners/go-cache.js';
import { CargoCache } from './scanners/cargo-cache.js';
import { ComposerCache } from './scanners/composer-cache.js';
import { PubCache } from './scanners/pub-cache.js';
import { Semaphore } from './utils/semaphore.js';
import { computeDriftScore, generateFindings, computeProjectId, computeSolutionId } from './scoring/drift-score.js';
import { formatText } from './formatters/text.js';
import { formatSarif } from './formatters/sarif.js';
import { formatMarkdown } from './formatters/markdown.js';
import { loadConfig, appendExcludePatterns } from './config.js';
import { pathExists, readJsonFile, writeJsonFile, writeTextFile, ensureDir, FileCache, quickTreeCount } from './utils/fs.js';
import { detectVcs } from './utils/vcs.js';
import { resolveRepositoryName } from './utils/repository-name.js';
import { ScanProgress } from './ui/progress.js';
import { loadScanHistory, saveScanHistory, estimateTotalDuration, estimateStepDurations } from './ui/scan-history.js';
import { parseDsn } from './utils/dsn.js';
import { loadPackageVersionManifest } from './package-version-manifest.js';
import { generateWorkspaceRelationshipMermaid, generateProjectRelationshipMermaid, generateSolutionRelationshipMermaid } from './utils/mermaid.js';
import { classifyProject, summarizeBilling } from './scanners/project-classification.js';
import { collectVulnTargets, scanVulnerabilities, generateVulnerabilityFindings } from './scanners/vulnerability-scanner.js';
import { attributeVulnerabilities } from './scoring/vuln-attribution.js';
import { gitHistoryAvailable, workingTreeDirty } from './utils/git-history.js';
import { buildVersionTimelines } from './utils/version-timeline.js';
import type {
  ScanArtifact, ScanOptions, ProjectScan, ExtendedScanResults, RepositoryInfo, SolutionScan,
  VibgrateConfig, Finding,
} from './types.js';
import type { RuntimeCatalog } from './runtimes/types.js';

/**
 * Shared context handed to the advanced-analysis hook (see {@link AdvancedScanHook}).
 *
 * This is the seam between the open core scan and the proprietary advanced
 * analysis. `runCoreScan` builds the base artifact from the fields below; the
 * hook (supplied only by the commercial `runScan`) reads them, runs the private
 * scanners, and writes its results back via `extended` and `addFilesScanned` —
 * which `runCoreScan` folds into the final artifact.
 *
 * When no hook is supplied (the open path), none of the private scanners run and
 * the artifact carries only base drift facts.
 */
export interface CoreScanContext {
  rootDir: string;
  opts: ScanOptions;
  config: VibgrateConfig;
  /** `false` when scanners are disabled in config; otherwise the per-scanner config. */
  scanners: VibgrateConfig['scanners'];
  maxPrivacyMode: boolean;
  allProjects: ProjectScan[];
  solutions: SolutionScan[];
  projectsByPath: Map<string, ProjectScan>;
  fileCache: FileCache;
  progress: ScanProgress;
  runtimeCatalog: RuntimeCatalog;
  /** Accumulator the hook populates with advanced scanner results. */
  extended: ExtendedScanResults;
  /** Add to the artifact's `filesScanned` total (e.g. files touched by advanced scanners). */
  addFilesScanned: (count: number) => void;
}

/**
 * Optional advanced-analysis pass. Runs after the base projects/solutions are
 * resolved but before the drift score is computed, so it sees the full project
 * set and can attach `extended`/billing results that land in the artifact.
 */
export type AdvancedScanHook = (ctx: CoreScanContext) => Promise<void>;

interface ParsedSolutionFile {
  path: string;
  name: string;
  type: 'dotnet-sln';
  projectPaths: string[];
}

async function discoverSolutions(rootDir: string, fileCache: FileCache): Promise<ParsedSolutionFile[]> {
  const solutionFiles = await fileCache.findSolutionFiles(rootDir);
  const parsed: ParsedSolutionFile[] = [];

  for (const solutionFile of solutionFiles) {
    try {
      const content = await fileCache.readTextFile(solutionFile);
      const dir = path.dirname(solutionFile);
      const rootBasename = path.basename(rootDir);
      const relSolutionPath = [rootBasename, path.relative(rootDir, solutionFile).replace(/\\/g, '/')].join('/');
      const projectPaths = new Set<string>();
      const projectRegex = /Project\("[^"]*"\)\s*=\s*"([^"]*)",\s*"([^"]+\.(?:cs|vb)proj)"/g;
      let match: RegExpExecArray | null;
      while ((match = projectRegex.exec(content)) !== null) {
        const projectRelative = match[2];
        const absProjectPath = path.resolve(dir, projectRelative.replace(/\\/g, '/'));
        projectPaths.add(path.relative(rootDir, absProjectPath).replace(/\\/g, '/'));
      }

      const solutionName = path.basename(solutionFile, path.extname(solutionFile));

      parsed.push({
        path: relSolutionPath,
        name: solutionName,
        type: 'dotnet-sln',
        projectPaths: [...projectPaths],
      });
    } catch {
      // ignore unreadable solution files
    }
  }

  return parsed;
}

/**
 * Open base scan: discovery → per-ecosystem fact collection → drift score →
 * findings → artifact assembly + output. Contains **no** references to the
 * proprietary advanced scanners; those are layered in only when `advanced` is
 * supplied (by the commercial {@link import('./run-scan.js').runScan}).
 */
export async function runCoreScan(
  rootDir: string,
  opts: ScanOptions,
  advanced?: AdvancedScanHook,
): Promise<ScanArtifact> {
  const vibgrateVersion = opts.vibgrateVersion ?? 'unknown';
  const scanStart = Date.now();
  const config = await loadConfig(rootDir);
  const sem = new Semaphore(opts.concurrency);
  const packageManifest = opts.packageManifest ? await loadPackageVersionManifest(opts.packageManifest) : undefined;
  const offlineMode = opts.offline === true;
  const maxPrivacyMode = opts.maxPrivacy === true;
  const npmCache = new NpmCache(rootDir, sem, packageManifest, offlineMode);
  const nugetCache = new NuGetCache(sem, packageManifest, offlineMode);
  const pypiCache = new PyPICache(sem, packageManifest, offlineMode);
  const mavenCache = new MavenCache(sem, packageManifest, offlineMode);
  const rubygemsCache = new RubyGemsCache(sem, packageManifest, offlineMode);
  const swiftCache = new SwiftCache(sem, packageManifest, offlineMode);
  const goCache = new GoCache(sem, packageManifest, offlineMode);
  const cargoCache = new CargoCache(sem, packageManifest, offlineMode);
  const composerCache = new ComposerCache(sem, packageManifest, offlineMode);
  const pubCache = new PubCache(sem, packageManifest, offlineMode);
  const fileCache = new FileCache();
  // Merge config-file excludes with any patterns passed on the command line
  // (--exclude). CLI patterns are additive and de-duplicated.
  const excludePatterns = [...new Set([...(config.exclude ?? []), ...(opts.exclude ?? [])])];
  fileCache.setExcludePatterns(excludePatterns);
  const projectScanTimeoutMs = ((opts.projectScanTimeout ?? config.projectScanTimeout ?? 180) * 1000);
  fileCache.setMaxFileSize(config.maxFileSizeToScan ?? 5_242_880);
  fileCache.setProjectScanTimeout(projectScanTimeoutMs);
  const scanners = config.scanners;
  let filesScanned = 0;
  const addFilesScanned = (count: number): void => { filesScanned += count; };

  // ── Progress UI ──
  // Base steps only; the advanced hook inserts its own steps before `drift`
  // (the same dynamic-insertion pattern used for per-ecosystem project steps).
  const progress = new ScanProgress(rootDir, vibgrateVersion);
  const steps = [
    { id: 'config', label: 'Loading configuration' },
    { id: 'discovery', label: 'Discovering workspace', weight: 3 },
    { id: 'vcs', label: 'Detecting version control' },
    { id: 'walk', label: 'Indexing files', weight: 8 },
    { id: 'drift', label: 'Computing drift score' },
    { id: 'findings', label: 'Generating findings' },
  ];
  if (opts.postScan) steps.push({ id: 'map', label: 'Building code map' });
  progress.setSteps(steps);

  // ── Step: Config ──
  progress.completeStep('config', 'loaded');

  // ── Preflight: verify npm registry connectivity ──
  const registryOk = offlineMode ? true : await checkRegistryAccess(rootDir);
  if (!registryOk) {
    progress.finish();
    const msg = [
      '',
      chalk.red.bold('  ✖ Vibgrate cannot connect to the npm registry to check package versions.'),
      '',
      chalk.dim('    Possible causes:'),
      chalk.dim('    • No internet connection'),
      chalk.dim('    • Corporate proxy/firewall blocking registry.npmjs.org'),
      chalk.dim('    • npm is not installed or not in PATH'),
      '',
      chalk.dim('    Try running: ') + chalk.cyan('npm view npm dist-tags.latest'),
      '',
    ].join('\n');
    throw new Error(msg);
  }

  // Resolve the Runtime Catalog (latest / latest-LTS / real EOL dates for
  // Node/Python/Java/.NET/Go/Ruby) before scanning. Mirrors dependency
  // resolution: live via the Vibgrate API (`/v1/reference/runtimes`) with local
  // cache, offline `--package-manifest` `runtimes`, and the bundled snapshot as
  // fallbacks. Best-effort; never throws.
  const runtimeClient = new RuntimeCatalogClient({ offline: offlineMode, manifest: packageManifest });
  const resolvedRuntimeCatalog = await runtimeClient.resolve();
  const runtimeCatalog = resolvedRuntimeCatalog.catalog;

  // Kick off fast tree counting early so ETA can be initialized before indexing.
  const treeCountPromise = quickTreeCount(rootDir, excludePatterns);

  // ── Step: Discovery — fast file & folder count ──
  progress.startStep('discovery');
  const treeCount = await treeCountPromise;
  progress.updateStats({ treeSummary: treeCount });
  progress.completeStep(
    'discovery',
    `${treeCount.totalFiles.toLocaleString()} files · ${treeCount.totalDirs.toLocaleString()} dirs`,
  );

  // ── Load scan history for ETA estimation ──
  const scanHistory = await loadScanHistory(rootDir);
  const estimatedTotal = estimateTotalDuration(scanHistory, treeCount.totalFiles);
  progress.setEstimatedTotal(estimatedTotal);
  progress.setStepEstimates(estimateStepDurations(scanHistory, treeCount.totalFiles));

  // ── Step: VCS ──
  progress.startStep('vcs');
  const vcs = await detectVcs(rootDir);
  // Record whether the working tree matches HEAD, so downstream commit-signature
  // verification can only report "verified" when the scanned code IS the signed
  // commit (a signature attests to the committed tree, not local edits).
  if (vcs.type === 'git' && vcs.sha) {
    vcs.dirty = await workingTreeDirty(rootDir);
  }
  const vcsDetail = vcs.type !== 'unknown'
    ? `${vcs.type}${vcs.branch ? ` ${vcs.branch}` : ''}${vcs.shortSha ? ` @ ${vcs.shortSha}` : ''}${vcs.dirty ? ' (dirty)' : ''}`
    : 'none detected';
  progress.completeStep('vcs', vcsDetail);

  // ── Step: Index files (shared walk with progress) ──
  progress.startStep('walk', treeCount.totalFiles);
  await fileCache.walkDir(rootDir, (found, currentPath) => {
    progress.updateStepProgress('walk', found, treeCount.totalFiles, currentPath);
  });
  const indexedTreeCount = fileCache.getWalkSummary(rootDir);
  if (indexedTreeCount && (indexedTreeCount.totalFiles !== treeCount.totalFiles || indexedTreeCount.totalDirs !== treeCount.totalDirs)) {
    progress.updateStats({ treeSummary: indexedTreeCount });
  }
  progress.completeStep('walk', `${treeCount.totalFiles.toLocaleString()} files indexed`);

  // ── Step: Node projects ──
  const nodeProjects = await scanNodeProjects(rootDir, npmCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (nodeProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'node', label: 'Found Node projects', weight: 4 });
    progress.startStep('node');
    for (const p of nodeProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += nodeProjects.length;
    progress.addProjects(nodeProjects.length);
    progress.completeStep('node', `${nodeProjects.length} project${nodeProjects.length !== 1 ? 's' : ''}`, nodeProjects.length);
  }

  // ── Step: .NET projects ──
  const dotnetProjects = await scanDotnetProjects(rootDir, nugetCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (dotnetProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'dotnet', label: 'Found .NET projects', weight: 2 });
    progress.startStep('dotnet');
    for (const p of dotnetProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += dotnetProjects.length;
    progress.addProjects(dotnetProjects.length);
    progress.completeStep('dotnet', `${dotnetProjects.length} project${dotnetProjects.length !== 1 ? 's' : ''}`, dotnetProjects.length);
  }

  // ── Step: Python projects ──
  const pythonProjects = await scanPythonProjects(rootDir, pypiCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (pythonProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'python', label: 'Found Python projects', weight: 3 });
    progress.startStep('python');
    for (const p of pythonProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += pythonProjects.length;
    progress.addProjects(pythonProjects.length);
    progress.completeStep('python', `${pythonProjects.length} project${pythonProjects.length !== 1 ? 's' : ''}`, pythonProjects.length);
  }

  // ── Step: Java projects ──
  const javaProjects = await scanJavaProjects(rootDir, mavenCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (javaProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'java', label: 'Found Java projects', weight: 3 });
    progress.startStep('java');
    for (const p of javaProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += javaProjects.length;
    progress.addProjects(javaProjects.length);
    progress.completeStep('java', `${javaProjects.length} project${javaProjects.length !== 1 ? 's' : ''}`, javaProjects.length);
  }

  // ── Step: Ruby projects ──
  const rubyProjects = await scanRubyProjects(rootDir, rubygemsCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (rubyProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'ruby', label: 'Found Ruby projects', weight: 2 });
    progress.startStep('ruby');
    for (const p of rubyProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += rubyProjects.length;
    progress.addProjects(rubyProjects.length);
    progress.completeStep('ruby', `${rubyProjects.length} project${rubyProjects.length !== 1 ? 's' : ''}`, rubyProjects.length);
  }

  // ── Step: Swift projects ──
  const swiftProjects = await scanSwiftProjects(rootDir, swiftCache, fileCache, projectScanTimeoutMs);
  if (swiftProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'swift', label: 'Found Swift projects', weight: 2 });
    progress.startStep('swift');
    for (const p of swiftProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += swiftProjects.length;
    progress.addProjects(swiftProjects.length);
    progress.completeStep('swift', `${swiftProjects.length} project${swiftProjects.length !== 1 ? 's' : ''}`, swiftProjects.length);
  }

  // ── Step: Go projects ──
  const goProjects = await scanGoProjects(rootDir, goCache, fileCache, projectScanTimeoutMs, runtimeCatalog);
  if (goProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'go', label: 'Found Go projects', weight: 2 });
    progress.startStep('go');
    for (const p of goProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += goProjects.length;
    progress.addProjects(goProjects.length);
    progress.completeStep('go', `${goProjects.length} project${goProjects.length !== 1 ? 's' : ''}`, goProjects.length);
  }

  // ── Step: Rust projects ──
  const rustProjects = await scanRustProjects(rootDir, cargoCache, fileCache, projectScanTimeoutMs);
  if (rustProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'rust', label: 'Found Rust projects', weight: 2 });
    progress.startStep('rust');
    for (const p of rustProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += rustProjects.length;
    progress.addProjects(rustProjects.length);
    progress.completeStep('rust', `${rustProjects.length} project${rustProjects.length !== 1 ? 's' : ''}`, rustProjects.length);
  }

  // ── Step: PHP projects ──
  const phpProjects = await scanPhpProjects(rootDir, composerCache, fileCache, projectScanTimeoutMs);
  if (phpProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'php', label: 'Found PHP projects', weight: 2 });
    progress.startStep('php');
    for (const p of phpProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += phpProjects.length;
    progress.addProjects(phpProjects.length);
    progress.completeStep('php', `${phpProjects.length} project${phpProjects.length !== 1 ? 's' : ''}`, phpProjects.length);
  }

  // ── Step: Dart projects ──
  const dartProjects = await scanDartProjects(rootDir, pubCache, fileCache, projectScanTimeoutMs);
  if (dartProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'dart', label: 'Found Dart projects', weight: 2 });
    progress.startStep('dart');
    for (const p of dartProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += dartProjects.length;
    progress.addProjects(dartProjects.length);
    progress.completeStep('dart', `${dartProjects.length} project${dartProjects.length !== 1 ? 's' : ''}`, dartProjects.length);
  }

  // ── Step: Elixir projects ──
  const elixirProjects = await scanElixirProjects(rootDir, packageManifest, fileCache, projectScanTimeoutMs, offlineMode);
  if (elixirProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'elixir', label: 'Found Elixir projects', weight: 2 });
    progress.startStep('elixir');
    for (const p of elixirProjects) {
      progress.addDependencies(p.dependencies.length);
      if (p.frameworks) progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += elixirProjects.length;
    progress.addProjects(elixirProjects.length);
    progress.completeStep('elixir', `${elixirProjects.length} project${elixirProjects.length !== 1 ? 's' : ''}`, elixirProjects.length);
  }

  // ── Step: Docker images ──
  const dockerProjects = await scanDockerProjects(rootDir, packageManifest, fileCache, projectScanTimeoutMs, offlineMode);
  if (dockerProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'docker', label: 'Found Docker images', weight: 2 });
    progress.startStep('docker');
    for (const p of dockerProjects) {
      progress.addDependencies(p.dependencies.length);
    }
    filesScanned += dockerProjects.length;
    progress.addProjects(dockerProjects.length);
    progress.completeStep('docker', `${dockerProjects.length} project${dockerProjects.length !== 1 ? 's' : ''}`, dockerProjects.length);
  }

  // ── Step: Helm charts ──
  const helmProjects = await scanHelmProjects(rootDir, packageManifest, fileCache, projectScanTimeoutMs, offlineMode);
  if (helmProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'helm', label: 'Found Helm charts', weight: 2 });
    progress.startStep('helm');
    for (const p of helmProjects) {
      progress.addDependencies(p.dependencies.length);
      if (p.frameworks) progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += helmProjects.length;
    progress.addProjects(helmProjects.length);
    progress.completeStep('helm', `${helmProjects.length} project${helmProjects.length !== 1 ? 's' : ''}`, helmProjects.length);
  }

  // ── Step: Terraform configs ──
  const terraformProjects = await scanTerraformProjects(rootDir, packageManifest, fileCache, projectScanTimeoutMs, offlineMode);
  if (terraformProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'terraform', label: 'Found Terraform configs', weight: 2 });
    progress.startStep('terraform');
    for (const p of terraformProjects) {
      progress.addDependencies(p.dependencies.length);
    }
    filesScanned += terraformProjects.length;
    progress.addProjects(terraformProjects.length);
    progress.completeStep('terraform', `${terraformProjects.length} project${terraformProjects.length !== 1 ? 's' : ''}`, terraformProjects.length);
  }

  // ── Step: Additional language projects ──
  const polyglotProjects = await scanPolyglotProjects(rootDir, fileCache);
  if (polyglotProjects.length > 0) {
    progress.insertStepBefore('drift', { id: 'polyglot', label: 'Found additional language projects', weight: 2 });
    progress.startStep('polyglot');
    for (const p of polyglotProjects) {
      progress.addDependencies(p.dependencies.length);
      progress.addFrameworks(p.frameworks.length);
    }
    filesScanned += polyglotProjects.length;
    progress.addProjects(polyglotProjects.length);
    progress.completeStep('polyglot', `${polyglotProjects.length} project${polyglotProjects.length !== 1 ? 's' : ''}`, polyglotProjects.length);
  }

  // Deduplicate projects by path. Infrastructure overlays (a Dockerfile,
  // Helm chart, or Terraform config living inside a code project's
  // directory) are distinct projects, so their keys are type-qualified —
  // otherwise services/etl [docker] would swallow services/etl [python].
  const OVERLAY_PROJECT_TYPES = new Set<string>(['docker', 'helm', 'terraform']);
  const dedupeKey = (p: ProjectScan): string =>
    OVERLAY_PROJECT_TYPES.has(p.type as string) ? `${p.type}:${p.path}` : p.path;
  const rawProjects: ProjectScan[] = [...nodeProjects, ...dotnetProjects, ...pythonProjects, ...javaProjects, ...rubyProjects, ...swiftProjects, ...goProjects, ...rustProjects, ...phpProjects, ...dartProjects, ...elixirProjects, ...dockerProjects, ...helmProjects, ...terraformProjects, ...polyglotProjects];
  const deduplicatedMap = new Map<string, ProjectScan>();
  for (const project of rawProjects) {
    const existing = deduplicatedMap.get(dedupeKey(project));
    if (!existing) {
      deduplicatedMap.set(dedupeKey(project), project);
    } else {
      // Prefer the scan with resolved version data (a dedicated scanner
      // reading lockfiles) over a raw manifest parse with more rows but no
      // resolution (the polyglot fallback); tie-break on row count.
      const resolvedCount = (p: ProjectScan): number =>
        p.dependencies.filter((d) => d.resolvedVersion || d.latestStable).length;
      const keepNew =
        resolvedCount(project) > resolvedCount(existing) ||
        (resolvedCount(project) === resolvedCount(existing) &&
          project.dependencies.length > existing.dependencies.length);
      const winner = keepNew ? project : existing;
      const loser = keepNew ? existing : project;

      if (loser.projectReferences?.length) {
        if (!winner.projectReferences) {
          winner.projectReferences = loser.projectReferences;
        } else {
          const existingPaths = new Set(winner.projectReferences.map((r) => r.path));
          for (const ref of loser.projectReferences) {
            if (!existingPaths.has(ref.path)) winner.projectReferences.push(ref);
          }
        }
      }

      deduplicatedMap.set(dedupeKey(project), winner);
    }
  }
  const allProjects: ProjectScan[] = [...deduplicatedMap.values()];

  // ── Compute per-project drift scores & project IDs ──
  const dsn = opts.dsn || process.env.VIBGRATE_DSN;
  const parsedDsn = dsn ? parseDsn(dsn) : null;
  const workspaceId = parsedDsn?.workspaceId;

  for (const project of allProjects) {
    project.drift = computeDriftScore([project]);
    project.projectId = computeProjectId(project.path, project.name, workspaceId);

    // ── Source-only size metrics (inputs to the billing classification, which
    // runs in the advanced pass). Lockfiles, generated manifests and vendored/
    // build directories are excluded so a single large lockfile can't push a
    // tiny project past the size thresholds.
    const absProjectDir = path.resolve(rootDir, project.path);
    try {
      const source = await fileCache.sourceMetricsUnder(rootDir, absProjectDir);
      if (project.fileCount === undefined) project.fileCount = source.fileCount;
      project.sizeBytes = source.sizeBytes;
    } catch {
      // leave metrics undefined if they cannot be computed
    }
    project.dependencyCount = project.dependencies.length;
    // Project size categorisation (micro/small/standard). This is commodity
    // categorisation — open — and feeds the billing rollup below; the commercial
    // billing *rates* live server-side, not here.
    project.classification = classifyProject({
      fileCount: project.fileCount,
      sizeBytes: project.sizeBytes,
      dependencyCount: project.dependencyCount,
    });
  }

  const solutionsManifestPath = path.join(rootDir, '.vibgrate', 'solutions.json');
  const persistedSolutionIds = new Map<string, string>();
  if (await pathExists(solutionsManifestPath)) {
    try {
      const persisted = await readJsonFile<{ solutions?: Array<{ path: string; solutionId: string }> }>(solutionsManifestPath);
      for (const solution of persisted.solutions ?? []) {
        if (solution.path && solution.solutionId) persistedSolutionIds.set(solution.path, solution.solutionId);
      }
    } catch {
      // ignore malformed persisted solution manifest
    }
  }

  const discoveredSolutions = await discoverSolutions(rootDir, fileCache);
  const solutions: SolutionScan[] = discoveredSolutions.map((solution) => ({
    solutionId: persistedSolutionIds.get(solution.path) ?? computeSolutionId(solution.path, solution.name, workspaceId),
    path: solution.path,
    name: solution.name,
    type: solution.type,
    projectPaths: solution.projectPaths,
  }));

  const projectsByPath = new Map(allProjects.map((project) => [project.path, project]));
  for (const solution of solutions) {
    const includedProjects = solution.projectPaths
      .map((projectPath) => {
        return projectsByPath.get(projectPath)
          ?? projectsByPath.get(path.dirname(projectPath).replace(/\\/g, '/'));
      })
      .filter((project): project is ProjectScan => Boolean(project));

    solution.drift = includedProjects.length > 0
      ? computeDriftScore(includedProjects)
      : undefined;

    for (const project of includedProjects) {
      project.solutionId = solution.solutionId;
      project.solutionName = solution.name;
    }
  }

  for (const project of allProjects) {
    project.relationshipDiagram = generateProjectRelationshipMermaid(project, allProjects);
  }

  for (const solution of solutions) {
    solution.relationshipDiagram = generateSolutionRelationshipMermaid(solution, allProjects);
  }

  const relationshipDiagram = generateWorkspaceRelationshipMermaid(allProjects);

  // ── Advanced analysis (proprietary; supplied only by the commercial runScan) ──
  // Runs before drift/findings so its results land in the artifact. The open
  // path passes no hook, so no private scanner runs.
  const extended: ExtendedScanResults = {};
  if (advanced) {
    await advanced({
      rootDir,
      opts,
      config,
      scanners,
      maxPrivacyMode,
      allProjects,
      solutions,
      projectsByPath,
      fileCache,
      progress,
      runtimeCatalog,
      extended,
      addFilesScanned,
    });
  }

  // Surface Runtime Catalog freshness/provenance as a confidence signal.
  const catalogAgeDays = (Date.now() - Date.parse(runtimeCatalog.generatedAt)) / (1000 * 60 * 60 * 24);
  const runtimeCatalogStale = Number.isFinite(catalogAgeDays) && catalogAgeDays > 30;
  extended.runtimeCatalogInfo = {
    generatedAt: runtimeCatalog.generatedAt,
    source: resolvedRuntimeCatalog.source,
    stale: runtimeCatalogStale,
  };

  // ── Step: Vulnerability scan (opt-in) ──
  // Open detection via OSV (online) or advisories carried in an offline
  // package-version manifest (air-gapped). Off unless `--vulns` is set, so the
  // default scan keeps its behaviour, latency, and network surface.
  let vulnFindings: Finding[] = [];
  if (opts.vulns) {
    progress.insertStepBefore('drift', { id: 'vulns', label: 'Scanning for vulnerabilities', weight: 3 });
    progress.startStep('vulns');
    const targets = collectVulnTargets(allProjects);
    const vulnerabilities = await scanVulnerabilities(targets, { sem, offline: offlineMode, manifest: packageManifest });
    // Attribute exposure to introducing commits via git history. Best-effort:
    // skipped silently when git history is unavailable. We also run it when a
    // package manifest is present but nothing is open, so remediation analysis can
    // surface advisories for packages that are clean today but were vulnerable in
    // history (real MTTR), not just the currently-open ones.
    const wantRemediation = packageManifest != null;
    if ((vulnerabilities.packages.length > 0 || wantRemediation) && (await gitHistoryAvailable(rootDir))) {
      const cacheDir = !opts.noLocalArtifacts && !maxPrivacyMode ? path.join(rootDir, '.vibgrate') : undefined;
      const timelines = await buildVersionTimelines(rootDir, { cacheDir });
      attributeVulnerabilities(vulnerabilities, timelines, new Date().toISOString(), { manifest: packageManifest });
    }
    if (
      vulnerabilities.source !== 'none' ||
      vulnerabilities.packages.length > 0 ||
      (vulnerabilities.cra != null && vulnerabilities.cra.remediatedCount > 0)
    ) {
      extended.vulnerabilities = vulnerabilities;
    }
    vulnFindings = generateVulnerabilityFindings(vulnerabilities);
    const affected = vulnerabilities.packages.length;
    progress.completeStep(
      'vulns',
      affected > 0
        ? `${vulnerabilities.totalAdvisories} advisor${vulnerabilities.totalAdvisories === 1 ? 'y' : 'ies'} across ${affected} package${affected === 1 ? '' : 's'}`
        // Distinguish "OSV unreachable" from a clean result so an empty answer is
        // never read as "no vulnerabilities" (GUARDRAILS §1.4 — absent ≠ zero).
        : vulnerabilities.source === 'unreachable'
          ? 'OSV unreachable — not checked'
          : 'none found',
    );
  }

  // ── Step: Drift score ──
  progress.startStep('drift');
  const drift = computeDriftScore(allProjects);
  progress.completeStep('drift', `${drift.score}/100 — ${drift.riskLevel} risk`);

  // ── Step: Findings ──
  progress.startStep('findings');
  const findings = [...generateFindings(allProjects, config), ...vulnFindings];
  const warnCount = findings.filter((f) => f.level === 'warning').length;
  const errCount = findings.filter((f) => f.level === 'error').length;
  const noteCount = findings.filter((f) => f.level === 'note').length;
  progress.addFindings(warnCount, errCount, noteCount);
  const findingParts: string[] = [];
  if (errCount > 0) findingParts.push(`${errCount} error${errCount !== 1 ? 's' : ''}`);
  if (warnCount > 0) findingParts.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
  if (noteCount > 0) findingParts.push(`${noteCount} note${noteCount !== 1 ? 's' : ''}`);
  progress.completeStep('findings', findingParts.join(', ') || 'none');

  // ── Step: Code map (optional post-scan hook) ──
  // Runs inside the same progress bar so one command yields the Drift Score plus
  // a ready code map. Fail-soft: a map error never fails the scan.
  if (opts.postScan) {
    progress.startStep('map');
    try {
      const detail = await opts.postScan((done, total, phase) => progress.updateStepProgress('map', done, total, phase));
      progress.completeStep('map', detail || 'done');
    } catch {
      progress.completeStep('map', 'skipped (map build failed)');
    }
  }

  progress.finish();

  const stuckPaths = fileCache.stuckPaths;
  const skippedLarge = fileCache.skippedLargeFiles;

  if (stuckPaths.length > 0) {
    console.log(
      chalk.yellow(`\n⚠ ${stuckPaths.length} path${stuckPaths.length === 1 ? '' : 's'} timed out (>${Math.round(projectScanTimeoutMs / 1000)}s) and ${stuckPaths.length === 1 ? 'was' : 'were'} skipped:`),
    );
    for (const d of stuckPaths) {
      console.log(chalk.dim(`  → ${d}`));
    }
    const newExcludes = stuckPaths.map((d) => `${d}/**`);
    const updated = await appendExcludePatterns(rootDir, newExcludes);
    if (updated) {
      console.log(chalk.green('✔') + ` Added ${newExcludes.length} pattern${newExcludes.length !== 1 ? 's' : ''} to exclude list in config`);
    }
  }

  if (skippedLarge.length > 0) {
    const sizeLimit = config.maxFileSizeToScan ?? 5_242_880;
    const sizeMB = (sizeLimit / 1_048_576).toFixed(0);
    console.log(
      chalk.yellow(`\n⚠ ${skippedLarge.length} file${skippedLarge.length === 1 ? '' : 's'} skipped (>${sizeMB} MB):`),
    );
    for (const f of skippedLarge.slice(0, 10)) {
      console.log(chalk.dim(`  → ${f}`));
    }
    if (skippedLarge.length > 10) {
      console.log(chalk.dim(`  … and ${skippedLarge.length - 10} more`));
    }
  }

  fileCache.clear();

  if (allProjects.length === 0) {
    console.log(chalk.yellow('No projects found.'));
  }

  const durationMs = Date.now() - scanStart;
  const repository = await buildRepositoryInfo(rootDir, vcs.remoteUrl, extended.buildDeploy?.ci, opts.repositoryName);
  // Project size rollup (micro/small/standard → billable count). Open: it is
  // categorisation, not pricing — the commercial rates live server-side.
  const billing = summarizeBilling(allProjects);

  const artifact: ScanArtifact = {
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    vibgrateVersion,
    rootPath: path.basename(rootDir),
    ...(vcs.type !== 'unknown' ? { vcs } : {}),
    repository,
    projects: allProjects,
    ...(solutions.length > 0 ? { solutions } : {}),
    drift,
    findings,
    ...(Object.keys(extended).length > 0 ? { extended } : {}),
    durationMs,
    filesScanned,
    treeSummary: treeCount,
    relationshipDiagram,
    billing,
  };

  if (opts.baseline) {
    const baselinePath = path.resolve(opts.baseline);
    if (await pathExists(baselinePath)) {
      try {
        const baseline = await readJsonFile<ScanArtifact>(baselinePath);
        // Only a repo-relative reference may enter the artifact: the absolute
        // path leaks the local username/home layout to the ingest server. A
        // baseline outside the repo degrades to its basename for the same reason.
        const relBaseline = path.relative(rootDir, baselinePath);
        artifact.baseline = !relBaseline || relBaseline.startsWith('..') ? path.basename(baselinePath) : relBaseline;
        artifact.delta = artifact.drift.score - baseline.drift.score;
      } catch {
        console.error(chalk.yellow(`Warning: Could not read baseline file: ${baselinePath}`));
      }
    }
  }

  if (!opts.noLocalArtifacts && !maxPrivacyMode) {
    const vibgrateDir = path.join(rootDir, '.vibgrate');
    await ensureDir(vibgrateDir);
    await writeJsonFile(path.join(vibgrateDir, 'scan_result.json'), artifact);
    await writeJsonFile(path.join(vibgrateDir, 'solutions.json'), {
      scannedAt: artifact.timestamp,
      solutions: solutions.map((solution) => ({
        solutionId: solution.solutionId,
        name: solution.name,
        path: solution.path,
        type: solution.type,
        projectPaths: solution.projectPaths,
      })),
    });
  }

  // scan_history.json is local ETA telemetry, not a result — honour the same
  // "no local artifacts" contract as the result/solutions writes above so that
  // privacy modes (and `scan --emit-facts`) leave the scanned tree untouched.
  if (!opts.noLocalArtifacts && !maxPrivacyMode) {
    await saveScanHistory(rootDir, {
      timestamp: artifact.timestamp,
      totalDurationMs: durationMs,
      totalFiles: treeCount.totalFiles,
      totalDirs: treeCount.totalDirs,
      steps: progress.getStepTimings(),
    });
  }

  if (!opts.noLocalArtifacts && !maxPrivacyMode) {
    const projectScores: Record<string, object> = {};
    for (const project of allProjects) {
      if (project.drift && project.path) {
        projectScores[project.path] = {
          projectId: project.projectId,
          name: project.name,
          type: project.type,
          path: project.path,
          score: project.drift.score,
          riskLevel: project.drift.riskLevel,
          components: project.drift.components,
          measured: project.drift.measured,
          scannedAt: artifact.timestamp,
          vibgrateVersion,
          solutionId: project.solutionId,
          solutionName: project.solutionName,
        };
      }
    }
    if (Object.keys(projectScores).length > 0) {
      const vibgrateDir = path.join(rootDir, '.vibgrate');
      await ensureDir(vibgrateDir);
      await writeJsonFile(path.join(vibgrateDir, 'project_scores.json'), projectScores);
    }
  }

  if (opts.format === 'json') {
    const jsonStr = JSON.stringify(artifact, null, 2);
    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), jsonStr);
      console.log(chalk.green('✔') + ` JSON written to ${opts.out}`);
    } else {
      console.log(jsonStr);
    }
  } else if (opts.format === 'sarif') {
    const sarif = formatSarif(artifact);
    const sarifStr = JSON.stringify(sarif, null, 2);
    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), sarifStr);
      console.log(chalk.green('✔') + ` SARIF written to ${opts.out}`);
    } else {
      console.log(sarifStr);
    }
  } else if (opts.format === 'md') {
    const markdown = formatMarkdown(artifact);
    console.log(markdown);
    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), markdown);
    }
  } else {
    const text = formatText(artifact, { free: !parsedDsn });
    console.log(text);
    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), text);
    }
  }

  return artifact;
}

async function buildRepositoryInfo(rootDir: string, remoteUrl: string | undefined, ciSystems: string[] | undefined, nameOverride?: string): Promise<RepositoryInfo> {
  const name = nameOverride?.trim() ? nameOverride.trim() : await resolveRepositoryName(rootDir);
  let version: string | undefined;

  const packageJsonPath = path.join(rootDir, 'package.json');
  if (await pathExists(packageJsonPath)) {
    try {
      const packageJson = await readJsonFile<{ version?: string }>(packageJsonPath);
      if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
        version = packageJson.version.trim();
      }
    } catch {
      // ignore
    }
  }

  return {
    name,
    ...(version ? { version } : {}),
    ...(ciSystems && ciSystems.length > 0 ? { pipeline: ciSystems.join(',') } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}
