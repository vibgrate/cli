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
      // Local and git sources have no registry version to compare against.
      if (source.startsWith('./') || source.startsWith('../') || source.startsWith('git::')) {
        continue;
      }
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

  // Deduplicate providers and modules
  const uniqueProviders = new Map<string, string | undefined>();
  for (const p of allProviders) {
    if (!uniqueProviders.has(p.source)) {
      uniqueProviders.set(p.source, p.version);
    }
  }

  const uniqueModules = new Map<string, string | undefined>();
  for (const m of allModules) {
    if (!uniqueModules.has(m.source)) {
      uniqueModules.set(m.source, m.version);
    }
  }

  // Read lock file for exact versions
  const lockPath = `${projectPath}/.terraform.lock.hcl`;
  const resolvedVersions = await parseTerraformLock(lockPath, cache);

  // Prepare items to fetch
  const itemsToFetch: Array<{ type: 'provider' | 'module'; namespace: string; name: string; provider?: string }> = [];

  for (const [source] of uniqueProviders) {
    const [namespace, name] = source.split('/');
    itemsToFetch.push({ type: 'provider', namespace, name });
  }

  for (const [source] of uniqueModules) {
    const parts = source.split('/');
    if (parts.length === 3) {
      const [namespace, name, provider] = parts;
      itemsToFetch.push({ type: 'module', namespace, name, provider });
    }
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

  for (const [source, constraintVersion] of uniqueModules) {
    const currentVersion = constraintVersion || 'unknown';
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
