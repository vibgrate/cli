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

const DOCKER_ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A `$NAME` or `${...}` that substitution did not resolve. */
const UNRESOLVED_DOCKER_ARG = /\$\{[^}]*\}|\$[A-Za-z_]/;

/**
 * Drop an unquoted `#` comment. A `#` inside quotes stays part of the value.
 */
function stripDockerfileComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/** Split words on unquoted whitespace and drop the surrounding quotes. */
function splitDockerfileWords(input: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    let buf = '';
    let quote: '"' | "'" | null = null;
    while (i < input.length) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
          i += 1;
          continue;
        }
        buf += ch;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (/\s/.test(ch)) break;
      buf += ch;
      i += 1;
    }
    if (buf.length > 0) words.push(buf);
  }
  return words;
}

function parseArgAssignments(rest: string): Array<{ name: string; value?: string }> {
  const assignments: Array<{ name: string; value?: string }> = [];
  for (const token of splitDockerfileWords(rest)) {
    if (token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    if (!DOCKER_ARG_NAME.test(name)) continue;
    if (eq < 0) assignments.push({ name });
    else assignments.push({ name, value: token.slice(eq + 1) });
  }
  return assignments;
}

/**
 * Replace `$NAME` and `${NAME}` from ARG defaults already in scope.
 * `$$` is a literal dollar. Returns null when a name has no default, or when
 * `${...}` text would remain.
 */
function substituteDockerArgs(input: string, args: ReadonlyMap<string, string>): string | null {
  const pieces = input.split('$$');
  const resolved: string[] = [];
  for (const piece of pieces) {
    const expanded = expandDockerArgPiece(piece, args);
    if (expanded === null) return null;
    resolved.push(expanded);
  }
  const joined = resolved.join('$');
  if (UNRESOLVED_DOCKER_ARG.test(joined)) return null;
  return joined;
}

function expandDockerArgPiece(piece: string, args: ReadonlyMap<string, string>): string | null {
  let current = piece;
  for (let depth = 0; depth < 8; depth++) {
    let missing = false;
    const next = current.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare ?? '';
        if (!args.has(name)) {
          missing = true;
          return '';
        }
        return args.get(name) ?? '';
      },
    );
    if (missing) return null;
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** Record `ARG name=default` values. A bare `ARG name` keeps any earlier default. */
function recordDockerfileArgs(rest: string, args: Map<string, string>): void {
  for (const assignment of parseArgAssignments(rest)) {
    if (assignment.value === undefined) continue;
    const resolved = substituteDockerArgs(assignment.value, args);
    if (resolved === null) args.delete(assignment.name);
    else args.set(assignment.name, resolved);
  }
}

/** `FROM [--platform=…] <image>`, quotes around the image removed. */
function fromImageRef(line: string): string | null {
  const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
  if (!match?.[1]) return null;
  const ref = match[1];
  if (ref.length >= 2) {
    const quote = ref[0];
    if ((quote === '"' || quote === "'") && ref.endsWith(quote)) return ref.slice(1, -1);
  }
  return ref;
}

/**
 * Base images named by FROM. ARG defaults that appear before a FROM are
 * substituted into that reference, including defaults that themselves use
 * earlier ARGs (`ARG BASE=node:${NODE_VERSION}-alpine`). A reference that
 * still depends on a variable with no default is omitted.
 */
function imagesFromDockerfile(content: string): DockerImage[] {
  const images: DockerImage[] = [];
  const args = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripDockerfileComment(rawLine).trim();
    if (!line) continue;

    const arg = /^ARG\s+([\s\S]+)$/i.exec(line);
    if (arg?.[1]) {
      recordDockerfileArgs(arg[1], args);
      continue;
    }

    const imageRef = fromImageRef(line);
    if (imageRef === null) continue;

    const resolved = substituteDockerArgs(imageRef, args);
    if (resolved === null || resolved === '' || resolved === 'scratch') continue;
    if (/\s/.test(resolved) || resolved.includes('$')) continue;

    const parsed = parseDockerImage(resolved);
    images.push({
      name: `${parsed.namespace || 'library'}/${parsed.image}`,
      currentTag: parsed.tag || 'latest',
    });
  }

  return images;
}

/**
 * Parse Dockerfile to extract base images from FROM statements.
 */
async function parseDockerfile(filePath: string, cache?: FileCache): Promise<DockerImage[]> {
  const content = cache
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);

  return imagesFromDockerfile(content);
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
