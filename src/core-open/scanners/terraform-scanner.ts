// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchTerraformVersionsBulk } from './terraform-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface TerraformProvider {
  source: string; // e.g., "hashicorp/aws"
  version?: string;
}

interface TerraformModule {
  source: string; // e.g., "terraform-aws-modules/vpc/aws"
  version?: string;
}

const TERRAFORM_MANIFEST_FILES = new Set(['.tf']); // Any .tf file

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
  
  const providers: TerraformProvider[] = [];
  const modules: TerraformModule[] = [];
  let terraformVersion: string | undefined;

  // Extract required_version from terraform block
  const tfVersionMatch = content.match(/terraform\s*\{[^}]*required_version\s*=\s*"([^"]+)"/s);
  if (tfVersionMatch) {
    terraformVersion = tfVersionMatch[1];
  }

  // Extract required_providers from terraform block
  // terraform {
  //   required_providers {
  //     aws = {
  //       source  = "hashicorp/aws"
  //       version = "~> 4.0"
  //     }
  //   }
  // }
  const requiredProvidersMatch = content.match(/required_providers\s*\{([^}]+)\}/s);
  if (requiredProvidersMatch) {
    const providersBlock = requiredProvidersMatch[1];
    
    // Match each provider block
    const providerRegex = /(\w+)\s*=\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;

    while ((match = providerRegex.exec(providersBlock)) !== null) {
      const providerBlock = match[2];
      
      // Extract source
      const sourceMatch = providerBlock.match(/source\s*=\s*"([^"]+)"/);
      if (!sourceMatch) continue;
      
      const source = sourceMatch[1];
      
      // Extract version
      const versionMatch = providerBlock.match(/version\s*=\s*"([^"]+)"/);
      const version = versionMatch ? versionMatch[1] : undefined;
      
      providers.push({ source, version });
    }
  }

  // Also look for provider blocks (older style)
  // provider "aws" {
  //   version = "~> 3.0"
  // }
  const providerBlockRegex = /provider\s+"(\w+)"\s*\{([^}]+)\}/g;
  let providerMatch: RegExpExecArray | null;

  while ((providerMatch = providerBlockRegex.exec(content)) !== null) {
    const providerName = providerMatch[1];
    const block = providerMatch[2];
    
    const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
    if (versionMatch) {
      // Assume hashicorp namespace if not already added
      const existingProvider = providers.find(p => p.source.endsWith(`/${providerName}`));
      if (!existingProvider) {
        providers.push({
          source: `hashicorp/${providerName}`,
          version: versionMatch[1],
        });
      }
    }
  }

  // Extract modules
  // module "vpc" {
  //   source  = "terraform-aws-modules/vpc/aws"
  //   version = "3.0.0"
  // }
  const moduleRegex = /module\s+"[^"]+"\s*\{([^}]+)\}/g;
  let moduleMatch: RegExpExecArray | null;

  while ((moduleMatch = moduleRegex.exec(content)) !== null) {
    const block = moduleMatch[1];
    
    // Extract source
    const sourceMatch = block.match(/source\s*=\s*"([^"]+)"/);
    if (!sourceMatch) continue;
    
    const source = sourceMatch[1];
    
    // Skip local modules and git sources
    if (source.startsWith('./') || source.startsWith('../') || source.startsWith('git::')) {
      continue;
    }
    
    // Extract version
    const versionMatch = block.match(/version\s*=\s*"([^"]+)"/);
    const version = versionMatch ? versionMatch[1] : undefined;
    
    modules.push({ source, version });
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
