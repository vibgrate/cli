// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchDockerVersionsBulk, parseDockerImage } from './docker-cache.js';
import { gt, SemVer } from 'semver';
import type { ProjectScan, DependencyRow } from '../types.js';
import { readTextFile, findFiles, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';

interface DockerImage {
  name: string;
  currentTag: string;
}

/**
 * `Dockerfile`, `Containerfile`, `Dockerfile.<suffix>` (suffix non-empty),
 * or `<name>.Dockerfile` (name non-empty). Matched with this capitalisation.
 */
function isDockerfileName(fileName: string): boolean {
  if (fileName === 'Dockerfile' || fileName === 'Containerfile') return true;
  if (fileName.startsWith('Dockerfile.') && fileName.length > 'Dockerfile.'.length) return true;
  if (
    fileName.endsWith('.Dockerfile')
    && fileName.length > '.Dockerfile'.length
    && !fileName.startsWith('.')
  ) {
    return true;
  }
  return false;
}

/**
 * `compose.yml` / `compose.yaml`, `docker-compose.yml` / `docker-compose.yaml`,
 * and overrides `compose.<name>.yml` / `.yaml` and `docker-compose.<name>.yml` / `.yaml`.
 * `<name>` may contain dots (`compose.prod.override.yaml`).
 */
const COMPOSE_MANIFEST = /^(?:docker-)?compose(?:\..+)?\.ya?ml$/;

function isComposeManifest(fileName: string): boolean {
  return COMPOSE_MANIFEST.test(fileName);
}

/** Code-point order. Not locale order, so the walk is stable across machines. */
function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Parse Dockerfile to extract base images from FROM statements.
 */
async function parseDockerfile(filePath: string, cache?: FileCache): Promise<DockerImage[]> {
  const content = cache 
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);
  
  const images: DockerImage[] = [];
  
  // Match FROM statements (including multi-stage builds)
  // FROM [--platform=<platform>] <image>[:<tag>] [AS <name>]
  const fromRegex = /^FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)/gm;
  let match: RegExpExecArray | null;

  while ((match = fromRegex.exec(content)) !== null) {
    const imageRef = match[1];
    
    // Skip scratch
    if (imageRef === 'scratch') {
      continue;
    }

    const parsed = parseDockerImage(imageRef);
    images.push({
      name: `${parsed.namespace || 'library'}/${parsed.image}`,
      currentTag: parsed.tag || 'latest',
    });
  }

  return images;
}

/**
 * Parse docker-compose.yml to extract image references.
 */
async function parseDockerCompose(filePath: string, cache?: FileCache): Promise<DockerImage[]> {
  const content = cache 
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);
  
  const images: DockerImage[] = [];
  
  // Simple regex-based parsing (not full YAML parser)
  // Matches: image: <image-ref>
  const imageRegex = /^\s*image:\s*([^\s#]+)/gm;
  let match: RegExpExecArray | null;

  while ((match = imageRegex.exec(content)) !== null) {
    const imageRef = match[1].trim().replace(/["']/g, ''); // Remove quotes
    
    const parsed = parseDockerImage(imageRef);
    images.push({
      name: `${parsed.namespace || 'library'}/${parsed.image}`,
      currentTag: parsed.tag || 'latest',
    });
  }

  return images;
}

/**
 * Calculate version drift for a Docker image.
 */
function calculateDrift(
  currentTag: string,
  latestVersion: string,
): 'current' | 'minor-behind' | 'major-behind' | 'unknown' {
  try {
    // Handle special tags
    if (currentTag === 'latest' || currentTag === 'stable') {
      return 'current';
    }

    // Try to extract semver from tag (remove prefixes/suffixes like "18-alpine" -> "18")
    let currentCleaned = currentTag.replace(/^v/, '');
    const dashIndex = currentCleaned.indexOf('-');
    if (dashIndex > 0) {
      currentCleaned = currentCleaned.substring(0, dashIndex);
    }

    const current = new SemVer(currentCleaned);
    const latest = new SemVer(latestVersion);

    if (!gt(latest.version, current.version)) {
      return 'current';
    }

    // Check if major version differs
    if (latest.major > current.major) {
      return 'major-behind';
    }

    // Check if minor version differs (includes patch)
    return 'minor-behind';
  } catch {
    return 'unknown';
  }
}

/** Stable order: image name, then tag. Code-point compare, not locale. */
function compareDockerImage(a: DockerImage, b: DockerImage): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.currentTag !== b.currentTag) return a.currentTag < b.currentTag ? -1 : 1;
  return 0;
}

/**
 * Scan a directory for Docker manifests.
 */
export async function scanDocker(
  projectPath: string,
  cache?: FileCache,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<ProjectScan | null> {
  const allImages: DockerImage[] = [];

  // Every Dockerfile and every Compose file in this directory. Nested
  // directories are their own projects (scanDockerProjects groups by parent).
  const manifestPaths = await dockerManifestsInDir(projectPath, cache);
  for (const manifestPath of manifestPaths) {
    const name = path.basename(manifestPath);
    const images = isComposeManifest(name)
      ? await parseDockerCompose(manifestPath, cache)
      : await parseDockerfile(manifestPath, cache);
    allImages.push(...images);
  }

  if (allImages.length === 0) {
    return null;
  }

  // Deduplicate on name and tag. golang:1.21 and golang:1.23 are two rows;
  // the same name:tag twice is one. Order is name, then tag.
  const seen = new Set<string>();
  const uniqueImages: DockerImage[] = [];
  for (const img of allImages) {
    const key = `${img.name}\0${img.currentTag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueImages.push(img);
  }
  uniqueImages.sort(compareDockerImage);

  // One registry lookup per image name. Each tag computes its own drift.
  const imageRefs: string[] = [];
  for (const img of uniqueImages) {
    if (imageRefs[imageRefs.length - 1] !== img.name) imageRefs.push(img.name);
  }
  const latestVersions = await fetchDockerVersionsBulk(imageRefs, manifest, offline);

  // Build dependency list with drift analysis
  const dependencies: DependencyRow[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const img of uniqueImages) {
    const { name, currentTag } = img;
    const latestVersion = latestVersions.get(name);
    const drift = latestVersion ? calculateDrift(currentTag, latestVersion) : 'unknown';
    
    let majorsBehind: number | null = null;
    
    if (latestVersion) {
      try {
        const currentCleaned = currentTag.replace(/^v/, '').split('-')[0];
        const currentParsed = new SemVer(currentCleaned);
        const latestParsed = new SemVer(latestVersion);
        majorsBehind = latestParsed.major - currentParsed.major;
      } catch { /* ignore parse errors */ }
    }

    dependencies.push({
      package: name,
      section: 'dependencies',
      currentSpec: currentTag,
      resolvedVersion: currentTag,
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
    type: 'docker' as any, // Docker not in ProjectType yet
    path: path.relative(projectPath.includes('/') ? projectPath.split('/').slice(0, -1).join('/') : '.', projectPath) || '.',
    name: path.basename(projectPath),
    frameworks: [],
    dependencies,
    dependencyAgeBuckets: buckets,
  };
}

/**
 * Check if a file is a Docker manifest file.
 *
 * Dockerfiles: `Dockerfile`, `Containerfile`, `Dockerfile.<suffix>`,
 * `<name>.Dockerfile`. Compose: `docker-compose.yml` / `.yaml`, `compose.yml`
 * / `.yaml`, and `docker-compose.<name>.yml` / `.yaml` and `compose.<name>.yml`
 * / `.yaml` overrides. The match is case-sensitive.
 */
export function isDockerManifest(fileName: string): boolean {
  return isDockerfileName(fileName) || isComposeManifest(fileName);
}

/**
 * Manifest paths that sit directly in `projectPath`, in code-point order.
 * A file in a child directory belongs to that child project.
 */
async function dockerManifestsInDir(projectPath: string, cache?: FileCache): Promise<string[]> {
  if (cache) {
    const files = await cache.findFiles(projectPath, isDockerManifest);
    const direct = files.filter((file) => path.dirname(file) === projectPath);
    direct.sort(compareCodePoint);
    return direct;
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isDockerManifest(entry.name)) continue;
    names.push(entry.name);
  }
  names.sort(compareCodePoint);
  return names.map((name) => path.join(projectPath, name));
}

/**
 * Scan for Docker projects in a directory tree.
 */
export async function scanDockerProjects(
  rootDir: string,
  manifest?: PackageVersionManifest,
  cache?: FileCache,
  projectScanTimeout?: number,
  offline = false,
): Promise<ProjectScan[]> {
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, isDockerManifest)
    : await findFiles(rootDir, isDockerManifest);

  // Group manifests by directory to form "projects"
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];

  const dirs = [...projectDirs.keys()].sort(compareCodePoint);
  for (const dir of dirs) {
    try {
      const scan = await scanDocker(dir, cache, manifest, offline);
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
      console.error(`Error scanning Docker project at ${dir}:`, error);
    }
  }

  return results;
}
