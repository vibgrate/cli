// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchDockerVersionsBulk, parseDockerImage } from './docker-cache.js';
import { gt, SemVer } from 'semver';
import type { ProjectScan, DependencyRow } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface DockerImage {
  name: string;
  currentTag: string;
}

const DOCKER_MANIFEST_FILES = new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);

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

  // Check for Dockerfile
  const dockerfilePath = `${projectPath}/Dockerfile`;
  const hasDockerfile = cache 
    ? await cache.pathExists(dockerfilePath)
    : await pathExists(dockerfilePath);

  if (hasDockerfile) {
    const images = await parseDockerfile(dockerfilePath, cache);
    allImages.push(...images);
  }

  // Check for docker-compose files
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const file of composeFiles) {
    const composePath = `${projectPath}/${file}`;
    const hasCompose = cache 
      ? await cache.pathExists(composePath)
      : await pathExists(composePath);

    if (hasCompose) {
      const images = await parseDockerCompose(composePath, cache);
      allImages.push(...images);
      break; // Only parse one compose file
    }
  }

  if (allImages.length === 0) {
    return null;
  }

  // Deduplicate images by name
  const uniqueImages = new Map<string, string>();
  for (const img of allImages) {
    if (!uniqueImages.has(img.name)) {
      uniqueImages.set(img.name, img.currentTag);
    }
  }

  // Fetch latest versions
  const imageRefs = Array.from(uniqueImages.keys());
  const latestVersions = await fetchDockerVersionsBulk(imageRefs, manifest, offline);

  // Build dependency list with drift analysis
  const dependencies: DependencyRow[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const name of imageRefs) {
    const currentTag = uniqueImages.get(name)!;
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
 */
export function isDockerManifest(fileName: string): boolean {
  return DOCKER_MANIFEST_FILES.has(fileName);
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
  // Find Docker manifest files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => DOCKER_MANIFEST_FILES.has(name))
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
