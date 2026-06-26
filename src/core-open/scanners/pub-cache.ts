// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface PubDevMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch package metadata from pub.dev.
 * https://pub.dev/api/packages/{package}
 */
export class PubCache {
  private meta = new Map<string, Promise<PubDevMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(packageName: string): Promise<PubDevMeta> {
    const existing = this.meta.get(packageName);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'pub', packageName);
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
        const url = `https://pub.dev/api/packages/${encodeURIComponent(packageName)}`;
        
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as {
          latest?: {
            version?: string;
          };
          versions?: Array<{
            version?: string;
          }>;
        };

        if (!data.versions) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const stableVersions: string[] = [];
        for (const ver of data.versions) {
          if (!ver.version) continue;
          
          // Skip pre-release versions
          if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver.version)) continue;
          
          const sv = semver.valid(semver.clean(ver.version));
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
