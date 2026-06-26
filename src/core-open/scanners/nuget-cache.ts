// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface NuGetMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch package metadata from NuGet V3 API with caching and concurrency control.
 *
 * Uses the NuGet RegistrationBaseUrl to fetch version data for each package.
 * Falls back gracefully when the registry is unreachable.
 */
export class NuGetCache {
  private meta = new Map<string, Promise<NuGetMeta>>();
  private baseUrl = 'https://api.nuget.org/v3-flatcontainer';

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(pkg: string): Promise<NuGetMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      const manifestEntry = getManifestEntry(this.manifest, 'nuget', pkg);
      if (manifestEntry) {
        const stableVersions = (manifestEntry.versions ?? []).filter((v) => {
          const parsed = semver.valid(v);
          return parsed && semver.prerelease(v) === null;
        });
        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? null;
        return {
          latest: manifestEntry.latest ?? latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      }

      if (this.offline) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      try {
        // NuGet flat container API: package IDs are lowercase
        const url = `${this.baseUrl}/${pkg.toLowerCase()}/index.json`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as { versions?: string[] };
        const allVersions = data.versions ?? [];

        // Filter to stable versions (no pre-release tags)
        const stableVersions = allVersions.filter((v) => {
          const parsed = semver.valid(v);
          return parsed && semver.prerelease(v) === null;
        });

        // Find the latest stable version
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

    this.meta.set(pkg, p);
    return p;
  }
}

/**
 * Quick connectivity check for NuGet API.
 * Returns true if the registry is reachable.
 */
export async function checkNuGetAccess(): Promise<boolean> {
  try {
    const response = await fetch('https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json', {
      signal: AbortSignal.timeout(5_000),
      headers: { 'Accept': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
