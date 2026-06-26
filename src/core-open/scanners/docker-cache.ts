// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { gt, SemVer } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

const DOCKER_HUB_API = 'https://hub.docker.com/v2';
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_REQUESTS = 10;

interface DockerImageRef {
  registry?: string;
  namespace?: string;
  image: string;
  tag?: string;
}

/**
 * Parse a Docker image reference into components.
 * Examples:
 *   - "nginx:1.21" -> {image: "nginx", tag: "1.21"}
 *   - "node:18-alpine" -> {image: "node", tag: "18-alpine"}
 *   - "ghcr.io/owner/repo:latest" -> {registry: "ghcr.io", namespace: "owner", image: "repo", tag: "latest"}
 */
export function parseDockerImage(imageRef: string): DockerImageRef {
  let registry: string | undefined;
  let namespace: string | undefined;
  let image: string;
  let tag: string | undefined;

  // Split by tag separator
  const [imagePart, tagPart] = imageRef.split(':');
  tag = tagPart;

  // Check for registry (contains dot or localhost)
  const parts = imagePart.split('/');
  if (parts.length > 1 && (parts[0].includes('.') || parts[0] === 'localhost')) {
    registry = parts[0];
    if (parts.length === 3) {
      namespace = parts[1];
      image = parts[2];
    } else {
      image = parts[1];
    }
  } else if (parts.length === 2) {
    // Docker Hub with namespace (e.g., "library/nginx")
    namespace = parts[0];
    image = parts[1];
  } else {
    image = imagePart;
  }

  return { registry, namespace, image, tag };
}

/**
 * Fetch available tags for a Docker Hub image.
 */
async function fetchDockerHubTags(
  namespace: string,
  image: string,
  semaphore?: Semaphore,
): Promise<string[]> {
  const task = async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const url = `${DOCKER_HUB_API}/repositories/${namespace}/${image}/tags?page_size=100`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'vibgrate-cli' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as any;
      const tags = (data.results || []) as Array<{ name: string }>;

      return tags.map(t => t.name);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return [];
      }
      return [];
    }
  };

  if (semaphore) {
    return semaphore.run(task);
  }

  return task();
}

/**
 * Find the latest semver-compatible tag from a list of tags.
 */
function findLatestSemverTag(tags: string[]): string | null {
  const semverTags: SemVer[] = [];

  for (const tag of tags) {
    // Skip common non-version tags
    if (['latest', 'master', 'main', 'stable', 'edge', 'dev'].includes(tag)) {
      continue;
    }

    // Try to parse as semver (may have prefixes like "v" or suffixes like "-alpine")
    let cleaned = tag.replace(/^v/, ''); // Remove leading v
    const dashIndex = cleaned.indexOf('-');
    if (dashIndex > 0) {
      cleaned = cleaned.substring(0, dashIndex); // Remove suffixes like -alpine
    }

    try {
      const semver = new SemVer(cleaned);
      if (semver.prerelease.length === 0) { // Exclude pre-releases
        semverTags.push(semver);
      }
    } catch {
      // Not a valid semver
    }
  }

  if (semverTags.length === 0) {
    return null;
  }

  // Sort descending
  semverTags.sort((a, b) => (gt(a.version, b.version) ? -1 : 1));

  return semverTags[0].version;
}

/**
 * Fetch the latest stable version of a Docker image.
 */
export async function fetchDockerLatestVersion(
  imageRef: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  const parsed = parseDockerImage(imageRef);
  const key = `${parsed.namespace || 'library'}/${parsed.image}`;

  // Check manifest first
  const manifestEntry = getManifestEntry(manifest, 'docker', key);
  if (manifestEntry?.latest) {
    return manifestEntry.latest;
  }

  if (offline) {
    return null;
  }

  // Only support Docker Hub for now (GHCR and ECR require auth)
  if (parsed.registry && parsed.registry !== 'docker.io') {
    return null;
  }

  const namespace = parsed.namespace || 'library';
  const tags = await fetchDockerHubTags(namespace, parsed.image, semaphore);

  return findLatestSemverTag(tags);
}

/**
 * Bulk fetch latest versions for multiple Docker images.
 */
export async function fetchDockerVersionsBulk(
  imageRefs: string[],
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const semaphore = new Semaphore(CONCURRENT_REQUESTS);

  const promises = imageRefs.map(async (ref) => {
    const version = await fetchDockerLatestVersion(ref, manifest, semaphore, offline);
    if (version) {
      results.set(ref, version);
    }
  });

  await Promise.all(promises);
  return results;
}
