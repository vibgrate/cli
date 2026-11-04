// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchHelmVersionsBulk } from './helm-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface HelmDependency {
  name: string;
  version: string;
  repository?: string;
  condition?: string;
  /** True when `version` was read from this entry's own indented `version:` line. */
  versionFromEntry: boolean;
}

function unquoteYamlScalar(value: string): string {
  return value.trim().replace(/["']/g, '');
}

/** Column-0 YAML key (`maintainers:`, `version:`). List items and comments are not keys. */
function isTopLevelYamlKey(line: string): boolean {
  if (line.length === 0) return false;
  const c = line[0];
  if (c === ' ' || c === '\t' || c === '#' || c === '-' || c === '\r') return false;
  return /^[A-Za-z0-9_"'][\w."'-]*\s*:/.test(line);
}

/**
 * Content from `start` until the next top-level (unindented) key, exclusive.
 * The opening key's own line is already behind `start`.
 */
function sliceYamlSection(content: string, start: number): string {
  const lines = content.slice(start).split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i > 0 && isTopLevelYamlKey(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Dependency entries inside one YAML section. `version`, `repository`, and
 * `condition` are taken only from lines indented under that entry, so a later
 * sibling list (`maintainers:`) or the chart's own `version:` cannot leak in.
 */
function parseHelmDependencyList(section: string): HelmDependency[] {
  const dependencies: HelmDependency[] = [];
  let current: HelmDependency | null = null;
  let entryIndent = 0;

  const pushCurrent = () => {
    if (current) dependencies.push(current);
    current = null;
  };

  for (const rawLine of section.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const item = /^([ \t]*)-\s+name:\s*(.*)$/.exec(line);
    if (item) {
      pushCurrent();
      entryIndent = item[1]?.length ?? 0;
      current = {
        name: unquoteYamlScalar(item[2] ?? ''),
        version: '*',
        versionFromEntry: false,
      };
      continue;
    }

    if (!current) continue;

    const field = /^([ \t]+)(version|repository|condition):\s*(.*)$/.exec(line);
    if (!field) continue;
    const fieldIndent = field[1]?.length ?? 0;
    if (fieldIndent <= entryIndent) continue;

    const value = unquoteYamlScalar(field[3] ?? '');
    if (field[2] === 'version') {
      current.version = value;
      current.versionFromEntry = true;
    } else if (field[2] === 'repository') {
      current.repository = value;
    } else {
      current.condition = value;
    }
  }

  pushCurrent();
  return dependencies;
}

const HELM_MANIFEST_FILES = new Set(['Chart.yaml', 'Chart.yml']);

/**
 * Parse Chart.yaml to extract chart metadata and dependencies.
 */
async function parseChartYaml(filePath: string, cache?: FileCache): Promise<{
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  dependencies: HelmDependency[];
}> {
  const content = cache 
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);
  
  const dependencies: HelmDependency[] = [];
  let chartName: string | undefined;
  let chartVersion: string | undefined;
  let appVersion: string | undefined;

  // Extract chart name
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    chartName = nameMatch[1].trim().replace(/["']/g, '');
  }

  // Extract chart version
  const versionMatch = content.match(/^version:\s*(.+)$/m);
  if (versionMatch) {
    chartVersion = versionMatch[1].trim().replace(/["']/g, '');
  }

  // Extract app version
  const appVersionMatch = content.match(/^appVersion:\s*(.+)$/m);
  if (appVersionMatch) {
    appVersion = appVersionMatch[1].trim().replace(/["']/g, '');
  }

  // Parse dependencies section, and stop at the next top-level key.
  // dependencies:
  //   - name: chart-name
  //     version: "~1.0.0"
  //     repository: "https://..."
  // maintainers:        <-- not part of the dependency list
  //   - name: Jane Doe
  const depsMatch = content.match(/^dependencies:\s*$/m);
  if (depsMatch && depsMatch.index !== undefined) {
    const depsStart = depsMatch.index + depsMatch[0].length;
    dependencies.push(...parseHelmDependencyList(sliceYamlSection(content, depsStart)));
  }

  return { chartName, chartVersion, appVersion, dependencies };
}

/**
 * Parse Chart.lock to get exact resolved versions.
 */
async function parseChartLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  try {
    const content = cache 
      ? await cache.readTextFile(filePath)
      : await readTextFile(filePath);
    
    // Same bound as Chart.yaml: only the dependencies section, and only an
    // indented version that belongs to that entry. A later top-level `version:`
    // (or a `- name:` under maintainers) must not become a resolved row.
    const depsMatch = content.match(/^dependencies:\s*$/m);
    if (depsMatch && depsMatch.index !== undefined) {
      const depsStart = depsMatch.index + depsMatch[0].length;
      const section = sliceYamlSection(content, depsStart);
      for (const dep of parseHelmDependencyList(section)) {
        if (dep.versionFromEntry) {
          resolved.set(dep.name, dep.version);
        }
      }
    }
  } catch {
    // Lock file doesn't exist or is invalid
  }
  
  return resolved;
}

/**
 * Calculate version drift for a chart dependency.
 */
function calculateDrift(
  currentVersion: string,
  latestVersion: string,
): 'current' | 'minor-behind' | 'major-behind' | 'unknown' {
  try {
    // Remove version prefixes like ~, ^, >=, etc.
    const cleaned = currentVersion.replace(/^[~^><=\s]+/, '');
    
    const current = minVersion(validRange(cleaned) || cleaned);
    if (!current) {
      return 'unknown';
    }

    if (!gt(latestVersion, current.version)) {
      return 'current';
    }

    const latestParsed = minVersion(latestVersion);
    if (!latestParsed) {
      return 'unknown';
    }

    // Check if major version differs
    if (latestParsed.major > current.major) {
      return 'major-behind';
    }

    // Check if minor version differs (includes patch)
    return 'minor-behind';
  } catch {
    return 'unknown';
  }
}

/**
 * Scan a directory for Helm charts.
 */
export async function scanHelm(
  projectPath: string,
  cache?: FileCache,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<ProjectScan | null> {
  // Check for Chart.yaml or Chart.yml
  let chartPath: string | null = null;
  for (const file of ['Chart.yaml', 'Chart.yml']) {
    const p = `${projectPath}/${file}`;
    const exists = cache 
      ? await cache.pathExists(p)
      : await pathExists(p);
    
    if (exists) {
      chartPath = p;
      break;
    }
  }

  if (!chartPath) {
    return null;
  }

  const { chartName, appVersion, dependencies } = await parseChartYaml(chartPath, cache);

  // Read Chart.lock for exact versions
  const chartLockPath = `${projectPath}/Chart.lock`;
  const resolvedVersions = await parseChartLock(chartLockPath, cache);

  // Prepare charts to fetch
  const chartsToCheck = dependencies.map(d => ({
    name: d.name,
    repo: d.repository,
  }));

  // Fetch latest versions
  const latestVersions = await fetchHelmVersionsBulk(chartsToCheck, manifest, offline);

  // Build dependency list with drift analysis
  const deps: DependencyRow[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const dep of dependencies) {
    const resolvedVersion = resolvedVersions.get(dep.name);
    const currentVersion = resolvedVersion || dep.version;
    const key = dep.repository ? `${dep.repository}/${dep.name}` : dep.name;
    const latestVersion = latestVersions.get(key);
    const drift = latestVersion ? calculateDrift(currentVersion, latestVersion) : 'unknown';
    
    let majorsBehind: number | null = null;
    
    if (latestVersion) {
      try {
        const currentParsed = minVersion(validRange(currentVersion) || currentVersion);
        const latestParsed = minVersion(validRange(latestVersion) || latestVersion);
        if (currentParsed && latestParsed) {
          majorsBehind = latestParsed.major - currentParsed.major;
        }
      } catch { /* ignore parse errors */ }
    }

    deps.push({
      package: dep.name,
      section: 'dependencies',
      currentSpec: dep.version,
      resolvedVersion: resolvedVersion || null,
      latestStable: latestVersion || null,
      majorsBehind,
      drift,
    });

    // Update buckets
    if (drift === 'current') buckets.current++;
    else if (majorsBehind === 1) buckets.oneBehind++;
    else if (majorsBehind && majorsBehind > 1) buckets.twoPlusBehind++;
    else buckets.unknown++;
  }

  return {
    type: 'helm' as any, // helm not in ProjectType yet
    path: path.relative(projectPath.includes('/') ? projectPath.split('/').slice(0, -1).join('/') : '.', projectPath) || '.',
    name: chartName || path.basename(projectPath),
    runtime: appVersion,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: buckets,
  };
}

/**
 * Check if a file is a Helm manifest file.
 */
export function isHelmManifest(fileName: string): boolean {
  return HELM_MANIFEST_FILES.has(fileName);
}

/**
 * Scan for Helm charts in a directory tree.
 */
export async function scanHelmProjects(
  rootDir: string,
  manifest?: PackageVersionManifest,
  cache?: FileCache,
  projectScanTimeout?: number,
  offline = false,
): Promise<ProjectScan[]> {
  // Find Helm manifest files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => HELM_MANIFEST_FILES.has(name))
    : [];

  // Group manifests by directory to form "projects"
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];

  for (const [dir] of projectDirs) {
    try {
      const scan = await scanHelm(dir, cache, manifest, offline);
      if (scan) {
        // Report the repo-relative directory, not the basename: the project
        // dedupe in run-scan keys on path, so basenames silently swallow
        // distinct projects whose directories share a name (e.g. a Helm
        // chart deploy/helm/gateway vs a service services/gateway).
        scan.path = path.relative(rootDir, dir) || '.';
        results.push(scan);
      }
    } catch (error) {
      // Skip projects that fail to scan
      console.error(`Error scanning Helm chart at ${dir}:`, error);
    }
  }

  return results;
}
