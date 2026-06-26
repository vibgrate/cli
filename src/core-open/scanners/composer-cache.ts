// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface PackagistMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch package metadata from Packagist (packagist.org).
 * https://packagist.org/apidoc
 */
export class ComposerCache {
  private meta = new Map<string, Promise<PackagistMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(packageName: string): Promise<PackagistMeta> {
    const existing = this.meta.get(packageName);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'composer', packageName);
      if (manifestEntry) {
        const stableVersions: string[] = [];
        for (const ver of manifestEntry.versions ?? []) {
          const sv = semver.valid(semver.clean(ver));
          if (sv) stableVersions.push(sv);
        }
        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? null;
        return {
          latest: manifestEntry.latest ? semver.valid(semver.clean(manifestEntry.latest)) ?? latestStableOverall : latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      }

      if (this.offline) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      try {
        // Packagist API: https://repo.packagist.org/p2/{vendor}/{package}.json
        const url = `https://repo.packagist.org/p2/${encodeURIComponent(packageName)}.json`;
        
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as {
          packages?: {
            [key: string]: Array<{
              version?: string;
              version_normalized?: string;
            }>;
          };
        };

        if (!data.packages) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        // Get the package versions
        const packageVersions = data.packages[packageName];
        if (!packageVersions || !Array.isArray(packageVersions)) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const stableVersions: string[] = [];
        for (const ver of packageVersions) {
          const version = ver.version ?? ver.version_normalized;
          if (!version) continue;
          
          // Skip dev versions
          if (version === 'dev-master' || version.startsWith('dev-')) continue;
          
          // Skip pre-release versions
          if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(version)) continue;
          
          const sv = semver.valid(semver.clean(version));
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

    this.meta.set(packageName, p);
    return p;
  }
}
