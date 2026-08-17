// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface MavenMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): MavenMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Convert a Maven version string to a semver-compatible string.
 * E.g. "3.2.1" → "3.2.1", "2.0.0-SNAPSHOT" → null.
 * Returns null for non-semver or pre-release versions.
 */
function mavenToSemver(ver: string): string | null {
  let v = ver.trim();

  // Maven pre-release markers — both hyphen (-alpha, -rc) and dot (.Beta1, .RC1) forms
  if (/(?:[-.](?:SNAPSHOT|alpha|beta|rc|M\d+|CR\d+))/i.test(v)) return null;

  // Strip ".RELEASE", ".Final" suffixes (common in Spring)
  v = v.replace(/\.(?:RELEASE|Final|GA)$/i, '');

  // Some Maven versions are like "1.0" → pad to "1.0.0"
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  v = parts.slice(0, 3).join('.');

  return semver.valid(v);
}

/**
 * Fetch package metadata from Maven Central Search API with caching and concurrency control.
 *
 * Uses the Maven Central REST API to fetch version data for each package.
 */
export class MavenCache {
  private meta = new Map<string, Promise<MavenMeta>>();
  private readonly disk: RegistryDiskCache<MavenMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<MavenMeta>('maven', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Get metadata for a Maven artifact.
   * @param groupId Maven group ID (e.g. "org.springframework.boot")
   * @param artifactId Maven artifact ID (e.g. "spring-boot-starter-web")
   */
  get(groupId: string, artifactId: string): Promise<MavenMeta> {
    const key = `${groupId}:${artifactId}`;
    const existing = this.meta.get(key);
    if (existing) return existing;

    const p = this.resolve(groupId, artifactId, key);
    this.meta.set(key, p);
    return p;
  }

  private async resolve(groupId: string, artifactId: string, key: string): Promise<MavenMeta> {
    const manifestEntry = getManifestEntry(this.manifest, 'maven', key);
    if (manifestEntry) {
      const stableVersions: string[] = [];
      for (const ver of manifestEntry.versions ?? []) {
        const sv = mavenToSemver(ver);
        if (sv) stableVersions.push(sv);
      }
      const sorted = [...stableVersions].sort(semver.rcompare);
      const latestStableOverall = sorted[0] ?? null;
      return {
        latest: manifestEntry.latest ? mavenToSemver(manifestEntry.latest) ?? latestStableOverall : latestStableOverall,
        stableVersions,
        latestStableOverall,
      };
    }

    const fromDisk = await this.disk.read(key);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(groupId, artifactId));
    if (fetched.persist) await this.disk.write(key, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(groupId: string, artifactId: string): Promise<{ meta: MavenMeta; persist: boolean }> {
    try {
      const url = `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(groupId)}%22+AND+a:%22${encodeURIComponent(artifactId)}%22&core=gav&rows=100&wt=json`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as {
        response?: {
          docs?: Array<{ v?: string }>;
        };
      };

      const docs = data.response?.docs ?? [];
      const allVersions = docs.map((d) => d.v).filter((v): v is string => typeof v === 'string');
      const stableVersions: string[] = [];
      for (const ver of allVersions) {
        const sv = mavenToSemver(ver);
        if (sv) stableVersions.push(sv);
      }
      const sorted = [...stableVersions].sort(semver.rcompare);
      const latestStableOverall = sorted[0] ?? null;

      return {
        meta: { latest: latestStableOverall, stableVersions, latestStableOverall },
        persist: true,
      };
    } catch {
      return { meta: emptyMeta(), persist: false };
    }
  }
}

/**
 * Quick connectivity check for Maven Central.
 * Returns true if the registry is reachable.
 */
export async function checkMavenAccess(): Promise<boolean> {
  try {
    const response = await fetch(
      'https://search.maven.org/solrsearch/select?q=g:%22junit%22+AND+a:%22junit%22&rows=1&wt=json',
      {
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
