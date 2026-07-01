// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface MavenMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
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

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  /**
   * Get metadata for a Maven artifact.
   * @param groupId Maven group ID (e.g. "org.springframework.boot")
   * @param artifactId Maven artifact ID (e.g. "spring-boot-starter-web")
   */
  get(groupId: string, artifactId: string): Promise<MavenMeta> {
    const key = `${groupId}:${artifactId}`;
    const existing = this.meta.get(key);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      const key = `${groupId}:${artifactId}`;
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

      if (this.offline) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      try {
        // Maven Central Search API
        const url = `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(groupId)}%22+AND+a:%22${encodeURIComponent(artifactId)}%22&core=gav&rows=100&wt=json`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as {
          response?: {
            docs?: Array<{ v?: string }>;
          };
        };

        const docs = data.response?.docs ?? [];
        const allVersions = docs.map((d) => d.v).filter((v): v is string => typeof v === 'string');

        // Convert to semver, filtering to stable
        const stableVersions: string[] = [];
        for (const ver of allVersions) {
          const sv = mavenToSemver(ver);
          if (sv) stableVersions.push(sv);
        }

        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? null;

        return {
          latest: latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      } catch {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }
    });

    this.meta.set(key, p);
    return p;
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
        headers: { 'Accept': 'application/json' },
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
