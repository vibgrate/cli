// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { gt, SemVer } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

const DOCKER_HUB_API = 'https://hub.docker.com/v2';
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_REQUESTS = 10;

export interface DockerImageRef {
  registry?: string;
  namespace?: string;
  image: string;
  tag?: string;
  /** Content digest (`algo:hex`) when the reference includes `@digest`. */
  digest?: string;
}

/**
 * Docker Hub hosts. A reference with no registry is Hub too. Compared
 * case-insensitively so `Docker.IO` is not recorded as a third-party registry.
 */
const DOCKER_HUB_REGISTRIES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
]);

/** True for an implicit Hub image and for the Hub host aliases. */
export function isDockerHubRegistry(registry: string | undefined): boolean {
  if (!registry) return true;
  return DOCKER_HUB_REGISTRIES.has(registry.toLowerCase());
}

/**
 * Name recorded for a parsed image.
 *
 * Docker Hub stays `library/<image>` or `<namespace>/<image>`. Any other
 * registry keeps its host, so the same path on two registries cannot collapse
 * into one row and get compared with Docker Hub.
 */
export function recordedDockerImageName(parsed: DockerImageRef): string {
  if (parsed.registry && !isDockerHubRegistry(parsed.registry)) {
    return parsed.namespace
      ? `${parsed.registry}/${parsed.namespace}/${parsed.image}`
      : `${parsed.registry}/${parsed.image}`;
  }
  return parsed.namespace ? `${parsed.namespace}/${parsed.image}` : `library/${parsed.image}`;
}

/**
 * A registry host is the first path segment when it contains `.` or `:`
 * (a domain or a port) or is exactly `localhost`.
 */
function isRegistryHost(segment: string): boolean {
  return segment.includes('.') || segment.includes(':') || segment === 'localhost';
}

/**
 * Parse a Docker image reference into components.
 *
 * The digest (`@sha256:…`) is split off first. The tag is the substring after
 * the last `:` that follows the last `/`, so a registry port is not the tag.
 *
 * Examples:
 *   - "nginx:1.21" -> {image: "nginx", tag: "1.21"}
 *   - "node:18-alpine" -> {image: "node", tag: "18-alpine"}
 *   - "ghcr.io/owner/repo:latest" -> {registry: "ghcr.io", namespace: "owner", image: "repo", tag: "latest"}
 *   - "localhost:5000/team/app:1.2.3" -> {registry: "localhost:5000", namespace: "team", image: "app", tag: "1.2.3"}
 *   - "node:20@sha256:…" -> {image: "node", tag: "20", digest: "sha256:…"}
 */
export function parseDockerImage(imageRef: string): DockerImageRef {
  let registry: string | undefined;
  let namespace: string | undefined;
  let image: string;
  let tag: string | undefined;
  let digest: string | undefined;

  const at = imageRef.lastIndexOf('@');
  let nameAndTag = imageRef;
  if (at !== -1) {
    const rawDigest = imageRef.slice(at + 1);
    if (rawDigest.length > 0) digest = rawDigest;
    nameAndTag = imageRef.slice(0, at);
  }

  const lastSlash = nameAndTag.lastIndexOf('/');
  const lastColon = nameAndTag.lastIndexOf(':');
  let imagePart = nameAndTag;
  if (lastColon > lastSlash) {
    tag = nameAndTag.slice(lastColon + 1);
    imagePart = nameAndTag.slice(0, lastColon);
  }

  const parts = imagePart.split('/');
  if (parts.length > 1 && isRegistryHost(parts[0])) {
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

  return { registry, namespace, image, tag, digest };
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
  const key = recordedDockerImageName(parsed);

  // Check manifest first. The key is the recorded name, so a Hub entry for
  // `acme/api` is not applied to `ghcr.io/acme/api`.
  const manifestEntry = getManifestEntry(manifest, 'docker', key);
  if (manifestEntry?.latest) {
    return manifestEntry.latest;
  }

  if (offline) {
    return null;
  }

  // Docker Hub is the only registry this client queries. Other registries
  // stay unknown unless the manifest above already had an entry.
  if (!isDockerHubRegistry(parsed.registry)) {
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
