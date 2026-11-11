// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchHelmVersionsBulk } from './helm-cache.js';
import { coerce, gt, minVersion, satisfies, valid, validRange } from 'semver';
import type { ProjectScan, DependencyRow } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface HelmDependency {
  name: string;
  version: string;
  repository?: string;
  condition?: string;
  /** Chart.yaml `alias:` — absent on Chart.lock entries, which do not record it. */
  alias?: string;
  /** True when `version` was read from this entry's own indented `version:` line. */
  versionFromEntry: boolean;
}

interface HelmLockEntry {
  name: string;
  version: string;
  repository?: string;
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
 * Dependency entries inside one YAML section. `version`, `repository`,
 * `condition`, and `alias` are taken only from lines indented under that
 * entry, so a later sibling list (`maintainers:`) or the chart's own
 * `version:` cannot leak in.
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

    const field = /^([ \t]+)(version|repository|condition|alias):\s*(.*)$/.exec(line);
    if (!field) continue;
    const fieldIndent = field[1]?.length ?? 0;
    if (fieldIndent <= entryIndent) continue;

    const value = unquoteYamlScalar(field[3] ?? '');
    if (field[2] === 'version') {
      current.version = value;
      current.versionFromEntry = true;
    } else if (field[2] === 'repository') {
      current.repository = value;
    } else if (field[2] === 'alias') {
      if (value) current.alias = value;
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
 * Parse Chart.lock to get exact resolved versions, in file order.
 * The same chart name can appear more than once (aliased dependencies);
 * callers pair entries to Chart.yaml rows instead of keying by name alone.
 */
async function parseChartLock(filePath: string, cache?: FileCache): Promise<HelmLockEntry[]> {
  const entries: HelmLockEntry[] = [];

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
          entries.push({
            name: dep.name,
            version: dep.version,
            ...(dep.repository ? { repository: dep.repository } : {}),
          });
        }
      }
    }
  } catch {
    // Lock file doesn't exist or is invalid
  }

  return entries;
}

function normalizeRepo(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  const trimmed = repo.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

/** Helm constraints use commas (`>=1.2.3, <2.0.0`); semver ranges use spaces. */
function requestedRange(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === '*') return '*';
  return validRange(trimmed.replace(/,/g, ' '));
}

function canonicalLockedVersion(version: string): string | null {
  if (valid(version)) return version;
  return coerce(version)?.version ?? null;
}

/**
 * A lock entry belongs to a dependency when the chart name matches and the
 * locked version satisfies the requested constraint. Lock entries have no
 * alias. Repository is a tie-break when both sides name one.
 */
function lockEntryMatches(dep: HelmDependency, entry: HelmLockEntry): boolean {
  if (dep.name !== entry.name) return false;
  const depRepo = normalizeRepo(dep.repository);
  const lockRepo = normalizeRepo(entry.repository);
  if (depRepo && lockRepo && depRepo !== lockRepo) return false;
  if (dep.version === entry.version) return true;
  const range = requestedRange(dep.version);
  if (range === '*') return true;
  const locked = canonicalLockedVersion(entry.version);
  if (!range || !locked) return false;
  try {
    return satisfies(locked, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

const MAX_LOCK_ASSIGNMENT = 8;

/**
 * Pair each dependency with a distinct lock entry.
 * Score prefers more matches, then exact version strings, then lock order
 * aligned with Chart.yaml order. The search is bounded and deterministic.
 */
function assignLockEntries(deps: HelmDependency[], locks: HelmLockEntry[]): number[] {
  const n = deps.length;
  const m = locks.length;
  if (n === 0) return [];
  if (n > MAX_LOCK_ASSIGNMENT || m > MAX_LOCK_ASSIGNMENT) {
    return assignLockEntriesGreedy(deps, locks);
  }

  let bestScore = Number.NEGATIVE_INFINITY;
  let best = new Array<number>(n).fill(-1);
  const current = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(m).fill(false);

  const consider = () => {
    let matched = 0;
    let exact = 0;
    let order = 0;
    for (let i = 0; i < n; i++) {
      const li = current[i] ?? -1;
      if (li < 0) continue;
      matched++;
      if (deps[i]?.version === locks[li]?.version) exact++;
      order += Math.abs(i - li);
    }
    const score = matched * 1_000_000 + exact * 1_000 - order;
    if (score > bestScore) {
      bestScore = score;
      best = current.slice();
    }
  };

  const dfs = (di: number): void => {
    if (di === n) {
      consider();
      return;
    }
    current[di] = -1;
    dfs(di + 1);
    for (let li = 0; li < m; li++) {
      if (used[li]) continue;
      const lock = locks[li];
      const dep = deps[di];
      if (!lock || !dep || !lockEntryMatches(dep, lock)) continue;
      used[li] = true;
      current[di] = li;
      dfs(di + 1);
      used[li] = false;
    }
  };

  dfs(0);
  return best;
}

function constraintSpecificity(spec: string): number {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === '*') return 0;
  if (valid(trimmed)) return 2;
  return 1;
}

function assignLockEntriesGreedy(deps: HelmDependency[], locks: HelmLockEntry[]): number[] {
  const order = deps.map((_, i) => i).sort((a, b) => {
    const bySpec = constraintSpecificity(deps[b]?.version ?? '') - constraintSpecificity(deps[a]?.version ?? '');
    return bySpec || a - b;
  });
  const used = new Set<number>();
  const assigned = new Array<number>(deps.length).fill(-1);
  for (const di of order) {
    const dep = deps[di];
    if (!dep) continue;
    let chosen = -1;
    for (let li = 0; li < locks.length; li++) {
      if (used.has(li)) continue;
      const lock = locks[li];
      if (!lock || !lockEntryMatches(dep, lock)) continue;
      if (dep.version === lock.version) {
        chosen = li;
        break;
      }
      if (chosen < 0) chosen = li;
    }
    if (chosen >= 0) {
      used.add(chosen);
      assigned[di] = chosen;
    }
  }
  return assigned;
}

/**
 * Resolved version for each Chart.yaml dependency, aligned by index.
 * A chart name that appears once keeps the previous behavior: the last
 * Chart.lock entry for that name. Repeated names (aliased subcharts) are
 * matched by name and version so each row keeps its own lock entry.
 */
function resolveLockedVersions(
  dependencies: HelmDependency[],
  lockEntries: HelmLockEntry[],
): Array<string | undefined> {
  const resolved: Array<string | undefined> = new Array(dependencies.length);
  const lockIndexesByName = new Map<string, number[]>();
  for (let i = 0; i < lockEntries.length; i++) {
    const name = lockEntries[i]?.name;
    if (!name) continue;
    const list = lockIndexesByName.get(name);
    if (list) list.push(i);
    else lockIndexesByName.set(name, [i]);
  }

  const depIndexesByName = new Map<string, number[]>();
  for (let i = 0; i < dependencies.length; i++) {
    const name = dependencies[i]?.name;
    if (!name) continue;
    const list = depIndexesByName.get(name);
    if (list) list.push(i);
    else depIndexesByName.set(name, [i]);
  }

  for (const [name, depIndexes] of depIndexesByName) {
    const lockIndexes = lockIndexesByName.get(name) ?? [];
    if (depIndexes.length === 1) {
      const only = depIndexes[0];
      if (only === undefined || lockIndexes.length === 0) continue;
      const last = lockIndexes[lockIndexes.length - 1];
      if (last === undefined) continue;
      resolved[only] = lockEntries[last]?.version;
      continue;
    }

    const available = lockIndexes.filter((idx) => lockEntries[idx]);
    const assignment = assignLockEntries(
      depIndexes.map((i) => dependencies[i]!),
      available.map((i) => lockEntries[i]!),
    );
    depIndexes.forEach((depIndex, i) => {
      const offset = assignment[i] ?? -1;
      if (offset < 0) return;
      const lockIndex = available[offset];
      if (lockIndex === undefined) return;
      resolved[depIndex] = lockEntries[lockIndex]?.version;
    });
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

  // Read Chart.lock for exact versions. Pair by name and version when the
  // same chart is declared more than once under different aliases.
  const chartLockPath = `${projectPath}/Chart.lock`;
  const lockEntries = await parseChartLock(chartLockPath, cache);
  const resolvedVersions = resolveLockedVersions(dependencies, lockEntries);

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

  for (let i = 0; i < dependencies.length; i++) {
    const dep = dependencies[i]!;
    const resolvedVersion = resolvedVersions[i];
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
      ...(dep.alias ? { alias: dep.alias } : {}),
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
