// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchTerraformVersionsBulk } from './terraform-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';
import { parseHclBlocks, parseHclAttributes, hclStringAttribute } from './hcl-blocks.js';

interface TerraformProvider {
  source: string; // e.g., "hashicorp/aws"
  version?: string;
}

interface TerraformModule {
  source: string; // e.g., "terraform-aws-modules/vpc/aws"
  version?: string;
}

/**
 * Where a Terraform module `source` is installed from.
 *
 * Only `registry` has a published version a drift scan can compare. The other
 * kinds are pinned by a path, a commit, or the bytes at a URL.
 */
export type TerraformModuleSourceKind =
  | 'registry'
  | 'local'
  | 'git'
  | 'mercurial'
  | 'http'
  | 's3'
  | 'gcs'
  | 'remote';

/** Namespace and module name: 1–64 ASCII letters, digits, dashes, or underscores; dashes and underscores are not the first or last character. */
const REGISTRY_MODULE_NAME = /^[0-9A-Za-z](?:[0-9A-Za-z-_]{0,62}[0-9A-Za-z])?$/;
/** Target system (the historical "provider" slot): 1–64 lowercase ASCII letters or digits. */
const REGISTRY_TARGET_SYSTEM = /^[0-9a-z]{1,64}$/;
/** Explicit registry hostname. A dot is required so a namespace is never read as a host. */
const REGISTRY_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * These hosts are Git shorthands (`github.com/org/repo`, `bitbucket.org/org/repo`),
 * not module registries, even when the path has three or four segments.
 */
const RESERVED_VCS_HOSTS = new Set(['github.com', 'bitbucket.org']);
/**
 * The public Terraform Registry. `registry.terraform.io/namespace/name/system`
 * is the same module as `namespace/name/system`. Any other hostname is a
 * private registry and is not queried here.
 */
const PUBLIC_REGISTRY_HOST = 'registry.terraform.io';

/**
 * Classify a Terraform module `source` string.
 *
 * Registry addresses are `namespace/name/system` or `hostname/namespace/name/system`
 * (a `//subdir` suffix is still the registry package). Everything else — local
 * paths, `git::` / `hg::` / `s3::` / `gcs::`, GitHub and Bitbucket shorthands,
 * `git@host:path`, and `http(s)` archives — has no registry version.
 */
export function classifyTerraformModuleSource(source: string): TerraformModuleSourceKind {
  if (isLocalModuleSource(source)) return 'local';

  const forced = /^([A-Za-z0-9]+)::/.exec(source);
  if (forced) return kindForGetter(forced[1]);

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(source);
  if (scheme) return kindForScheme(scheme[1]);

  if (isScpGitSource(source)) return 'git';
  if (isVcsHostShorthand(source)) return 'git';
  if (isRegistryModuleSource(source)) return 'registry';
  return 'remote';
}

function isLocalModuleSource(source: string): boolean {
  return source.startsWith('./')
    || source.startsWith('../')
    || source.startsWith('.\\')
    || source.startsWith('..\\');
}

function kindForGetter(protocol: string): TerraformModuleSourceKind {
  switch (protocol.toLowerCase()) {
    case 'git': return 'git';
    case 'hg': return 'mercurial';
    case 's3': return 's3';
    case 'gcs': return 'gcs';
    case 'http':
    case 'https':
      return 'http';
    default:
      return 'remote';
  }
}

function kindForScheme(scheme: string): TerraformModuleSourceKind {
  switch (scheme.toLowerCase()) {
    case 'http':
    case 'https':
      return 'http';
    case 'git':
    case 'ssh':
      return 'git';
    case 'hg':
      return 'mercurial';
    default:
      return 'remote';
  }
}

/** `git@host:path` — the username `git` is what makes this a Git URL. */
function isScpGitSource(source: string): boolean {
  const match = /^(?:([^@/]+)@)([^:/]+):([^/].*)$/.exec(source);
  return match !== null && match[1].toLowerCase() === 'git';
}

function isVcsHostShorthand(source: string): boolean {
  const slash = source.indexOf('/');
  if (slash <= 0) return false;
  return RESERVED_VCS_HOSTS.has(source.slice(0, slash).toLowerCase());
}

function isRegistryModuleSource(source: string): boolean {
  const { packageAddr, subDir } = splitModulePackageSubdir(source);
  if (subDirEscapesPackage(subDir)) return false;
  if (packageAddr.includes('?') || packageAddr.includes('#') || packageAddr.includes('::')) return false;

  const parts = packageAddr.split('/');
  if ((parts.length !== 3 && parts.length !== 4) || parts.some((part) => part.length === 0)) {
    return false;
  }

  let nameParts = parts;
  if (parts.length === 4) {
    const host = parts[0].toLowerCase();
    if (!REGISTRY_HOSTNAME.test(host) || RESERVED_VCS_HOSTS.has(host)) return false;
    nameParts = parts.slice(1);
  }

  const [namespace, name, system] = nameParts;
  return REGISTRY_MODULE_NAME.test(namespace)
    && REGISTRY_MODULE_NAME.test(name)
    && REGISTRY_TARGET_SYSTEM.test(system);
}

/**
 * Split a module source on the package/subdir marker `//`, ignoring the `//`
 * that belongs to a URL scheme. A query string stays on the package address.
 */
function splitModulePackageSubdir(source: string): { packageAddr: string; subDir: string } {
  let stop = source.length;
  const query = source.indexOf('?');
  if (query !== -1) stop = query;

  let offset = 0;
  const scheme = source.slice(0, stop).indexOf('://');
  if (scheme !== -1) offset = scheme + 3;

  const relative = source.slice(offset, stop).indexOf('//');
  if (relative === -1) return { packageAddr: source, subDir: '' };

  const index = relative + offset;
  let subDir = source.slice(index + 2);
  let packageAddr = source.slice(0, index);
  const queryInSubdir = subDir.indexOf('?');
  if (queryInSubdir !== -1) {
    packageAddr += subDir.slice(queryInSubdir);
    subDir = subDir.slice(0, queryInSubdir);
  }
  return { packageAddr, subDir };
}

/**
 * Public-registry address (`namespace/name/system`) for a module source.
 *
 * A `//subdir` is the same published module as the package address, and an
 * optional `registry.terraform.io/` prefix is the public registry. A private
 * hostname has no public version, so this returns null and the scan leaves
 * that row at drift `unknown`.
 */
function publicRegistryModuleAddress(source: string): string | null {
  if (classifyTerraformModuleSource(source) !== 'registry') return null;

  const { packageAddr } = splitModulePackageSubdir(source);
  const parts = packageAddr.split('/');
  if (parts.length === 3) return packageAddr;
  if (parts.length === 4 && parts[0].toLowerCase() === PUBLIC_REGISTRY_HOST) {
    return parts.slice(1).join('/');
  }
  return null;
}

function subDirEscapesPackage(subDir: string): boolean {
  if (!subDir) return false;
  let depth = 0;
  for (const part of subDir.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}

/**
 * Parse Terraform files to extract provider and module requirements.
 */
async function parseTerraformFile(filePath: string, cache?: FileCache): Promise<{
  terraformVersion?: string;
  providers: TerraformProvider[];
  modules: TerraformModule[];
}> {
  const content = cache
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);

  return extractTerraformRequirements(content);
}

/**
 * Extract Terraform version, provider and module requirements from HCL source.
 *
 * Structural, via {@link parseHclBlocks} — not regex. The previous
 * implementation matched blocks with `\{([^}]+)\}`, which stops at the first
 * closing brace and therefore saw only the first entry of a nested
 * `required_providers` block. Multi-provider repositories silently reported a
 * single provider, under-reporting drift on exactly the estates that need it.
 * Brace nesting is not a regular language; this walks it properly.
 *
 * Exported for tests — the nesting case is a regression fixture.
 */
export function extractTerraformRequirements(content: string): {
  terraformVersion?: string;
  providers: TerraformProvider[];
  modules: TerraformModule[];
} {
  const providers: TerraformProvider[] = [];
  const modules: TerraformModule[] = [];
  let terraformVersion: string | undefined;

  for (const block of parseHclBlocks(content)) {
    if (block.type === 'terraform') {
      terraformVersion ??= hclStringAttribute(block.body, 'required_version');

      // terraform { required_providers { aws = { source = "…" version = "…" } } }
      for (const inner of parseHclBlocks(block.body)) {
        if (inner.type !== 'required_providers') continue;
        for (const entry of parseHclAttributes(inner.body)) {
          const objectBody = /^\{([\s\S]*)\}$/.exec(entry.value);
          if (objectBody) {
            // Modern form: `<localName> = { source = "…", version = "…" }`.
            const source = hclStringAttribute(objectBody[1], 'source');
            if (!source) continue;
            providers.push({ source, version: hclStringAttribute(objectBody[1], 'version') });
            continue;
          }

          // Legacy version-only shorthand: `<localName> = "~> 2.0"`.
          //
          // Still valid, and common in pre-0.13 estates — which are exactly the
          // repositories a drift scanner exists to find. Both the old regex and
          // the first version of this rewrite required braces, so these
          // providers were dropped entirely and reported *no* drift rather than
          // stale drift. The source is implicit: an unqualified local name
          // resolves to the `hashicorp` namespace.
          const version = /^"((?:[^"\\]|\\.)*)"$/.exec(entry.value)?.[1];
          if (!version) continue;
          const source = `hashicorp/${entry.name}`;
          if (providers.some((p) => p.source === source)) continue;
          providers.push({ source, version });
        }
      }
      continue;
    }

    // Legacy standalone provider block: provider "aws" { version = "~> 3.0" }
    if (block.type === 'provider') {
      const name = block.labels[0];
      if (!name) continue;
      const version = hclStringAttribute(block.body, 'version');
      if (!version) continue;
      if (providers.some((p) => p.source.endsWith(`/${name}`))) continue;
      providers.push({ source: `hashicorp/${name}`, version });
      continue;
    }

    if (block.type === 'module') {
      const source = hclStringAttribute(block.body, 'source');
      if (!source) continue;
      // A module row is a registry address (namespace/name/system, with or
      // without a registry hostname). Local paths, Git, Mercurial, HTTP
      // archives, and object-storage URLs are not versioned there, so they
      // are not drift rows.
      if (classifyTerraformModuleSource(source) !== 'registry') continue;
      modules.push({ source, version: hclStringAttribute(block.body, 'version') });
    }
  }

  return { terraformVersion, providers, modules };
}

/**
 * Parse .terraform.lock.hcl to get exact versions.
 */
async function parseTerraformLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  try {
    const content = cache 
      ? await cache.readTextFile(filePath)
      : await readTextFile(filePath);
    
    // provider "registry.terraform.io/hashicorp/aws" {
    //   version = "4.0.0"
    // }
    const providerRegex = /provider\s+"[^"]*\/([^/"]+\/[^/"]+)"\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;

    while ((match = providerRegex.exec(content)) !== null) {
      const source = match[1]; // e.g., "hashicorp/aws"
      const block = match[2];
      
      const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
      if (versionMatch) {
        resolved.set(source, versionMatch[1]);
      }
    }
  } catch {
    // Lock file doesn't exist or is invalid
  }
  
  return resolved;
}

/**
 * Calculate version drift.
 */
function calculateDrift(
  currentVersion: string,
  latestVersion: string,
): 'current' | 'minor-behind' | 'major-behind' | 'unknown' {
  try {
    // Remove version prefixes like ~>, >=, etc.
    const cleaned = currentVersion.replace(/^[~><=\s]+/, '');
    
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
 * Scan a directory for Terraform configurations.
 */
export async function scanTerraform(
  projectPath: string,
  cache?: FileCache,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<ProjectScan | null> {
  // Find all .tf files
  const tfFiles: string[] = [];
  
  if (cache) {
    // Use cache to find .tf files
    const allFiles = await cache.findFiles(projectPath, (name) => name.endsWith('.tf'));
    tfFiles.push(...allFiles);
  } else {
    // Fallback: check for common files
    const commonFiles = ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf', 'providers.tf'];
    for (const file of commonFiles) {
      const p = `${projectPath}/${file}`;
      if (await pathExists(p)) {
        tfFiles.push(p);
      }
    }
  }

  if (tfFiles.length === 0) {
    return null;
  }

  // Parse all .tf files and aggregate
  let terraformVersion: string | undefined;
  const allProviders: TerraformProvider[] = [];
  const allModules: TerraformModule[] = [];

  for (const tfFile of tfFiles) {
    const { terraformVersion: tfVer, providers, modules } = await parseTerraformFile(tfFile, cache);
    
    if (tfVer && !terraformVersion) {
      terraformVersion = tfVer;
    }
    
    allProviders.push(...providers);
    allModules.push(...modules);
  }

  // A provider requirement is one constraint per source. Terraform rejects
  // two versions of the same provider in one configuration, and a later file
  // that repeats the source must not mint a second drift row.
  const uniqueProviders = new Map<string, string | undefined>();
  for (const p of allProviders) {
    if (!uniqueProviders.has(p.source)) {
      uniqueProviders.set(p.source, p.version);
    }
  }

  // A registry module is pinned per call site. Separate roots in one scan
  // (envs/staging on 4.0.2, envs/prod on 5.8.1) routinely require different
  // versions of the same source. Keying on source alone kept the first
  // version and dropped the other pin's drift. The same source at the same
  // version is still one row. Rows are emitted in source, then version,
  // order so the report does not follow filesystem walk order.
  const uniqueModules = new Map<string, TerraformModule>();
  for (const m of allModules) {
    const key = `${m.source}\0${m.version ?? ''}`;
    if (!uniqueModules.has(key)) {
      uniqueModules.set(key, { source: m.source, version: m.version });
    }
  }
  const modulePins = [...uniqueModules.values()].sort((a, b) => {
    if (a.source < b.source) return -1;
    if (a.source > b.source) return 1;
    const left = a.version ?? '';
    const right = b.version ?? '';
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  // Read lock file for exact versions
  const lockPath = `${projectPath}/.terraform.lock.hcl`;
  const resolvedVersions = await parseTerraformLock(lockPath, cache);

  // Prepare items to fetch
  const itemsToFetch: Array<{ type: 'provider' | 'module'; namespace: string; name: string; provider?: string }> = [];

  for (const [source] of uniqueProviders) {
    const [namespace, name] = source.split('/');
    itemsToFetch.push({ type: 'provider', namespace, name });
  }

  // Fetch by the public address, not the raw source. `ns/name/sys//subdir`
  // and `registry.terraform.io/ns/name/sys` are one module; a private host
  // is omitted so it never hits the public registry.
  const moduleSourcesSeen = new Set<string>();
  for (const pin of modulePins) {
    const address = publicRegistryModuleAddress(pin.source);
    if (!address || moduleSourcesSeen.has(address)) continue;
    moduleSourcesSeen.add(address);
    const [namespace, name, provider] = address.split('/');
    itemsToFetch.push({ type: 'module', namespace, name, provider });
  }

  // Fetch latest versions
  const latestVersions = await fetchTerraformVersionsBulk(itemsToFetch, manifest, offline);

  // Build dependency list
  const dependencies: DependencyRow[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const [source, constraintVersion] of uniqueProviders) {
    const resolvedVersion = resolvedVersions.get(source);
    const currentVersion = resolvedVersion || constraintVersion || 'unknown';
    const latestVersion = latestVersions.get(source);
    const drift = (latestVersion && currentVersion !== 'unknown') ? calculateDrift(currentVersion, latestVersion) : 'unknown';
    
    let majorsBehind: number | null = null;
    
    if (latestVersion && currentVersion !== 'unknown') {
      try {
        const currentParsed = minVersion(validRange(currentVersion) || currentVersion);
        const latestParsed = minVersion(validRange(latestVersion) || latestVersion);
        if (currentParsed && latestParsed) {
          majorsBehind = latestParsed.major - currentParsed.major;
        }
      } catch { /* ignore parse errors */ }
    }

    dependencies.push({
      package: `provider:${source}`,
      section: 'dependencies',
      currentSpec: constraintVersion || 'unknown',
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

  for (const { source, version: constraintVersion } of modulePins) {
    const currentVersion = constraintVersion || 'unknown';
    // The version map is keyed by `namespace/name/system`. The row name stays
    // the raw source, so a subdir and a public-registry prefix still show up
    // as distinct pins while sharing the fetched latest version.
    const address = publicRegistryModuleAddress(source);
    const latestVersion = address ? latestVersions.get(address) : undefined;
    const drift = (latestVersion && currentVersion !== 'unknown') ? calculateDrift(currentVersion, latestVersion) : 'unknown';
    
    let majorsBehind: number | null = null;
    
    if (latestVersion && currentVersion !== 'unknown') {
      try {
        const currentParsed = minVersion(validRange(currentVersion) || currentVersion);
        const latestParsed = minVersion(validRange(latestVersion) || latestVersion);
        if (currentParsed && latestParsed) {
          majorsBehind = latestParsed.major - currentParsed.major;
        }
      } catch { /* ignore parse errors */ }
    }

    dependencies.push({
      package: `module:${source}`,
      section: 'dependencies',
      currentSpec: constraintVersion || 'unknown',
      resolvedVersion: null,
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
    type: 'terraform' as any, // terraform not in ProjectType yet
    path: path.relative(projectPath.includes('/') ? projectPath.split('/').slice(0, -1).join('/') : '.', projectPath) || '.',
    name: path.basename(projectPath),
    runtime: terraformVersion,
    frameworks: [],
    dependencies,
    dependencyAgeBuckets: buckets,
  };
}

/**
 * Check if a file is a Terraform file.
 */
export function isTerraformManifest(fileName: string): boolean {
  return fileName.endsWith('.tf');
}

/**
 * Scan for Terraform configurations in a directory tree.
 */
export async function scanTerraformProjects(
  rootDir: string,
  manifest?: PackageVersionManifest,
  cache?: FileCache,
  projectScanTimeout?: number,
  offline = false,
): Promise<ProjectScan[]> {
  // Find Terraform manifest files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => name.endsWith('.tf'))
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
      const scan = await scanTerraform(dir, cache, manifest, offline);
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
      console.error(`Error scanning Terraform project at ${dir}:`, error);
    }
  }

  return results;
}
