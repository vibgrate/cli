// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface CratesMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch crate metadata from crates.io API.
 * https://crates.io/api/v1/crates/{crate}
 */
export class CargoCache {
  private meta = new Map<string, Promise<CratesMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(crateName: string): Promise<CratesMeta> {
    const existing = this.meta.get(crateName);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'cargo', crateName);
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
        const url = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
        
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 
            'Accept': 'application/json',
            'User-Agent': 'vibgrate-cli (https://github.com/vibgrate/vibgrate-cli)',
          },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as {
          crate?: {
            max_version?: string;
          };
          versions?: Array<{
            num?: string;
            yanked?: boolean;
          }>;
        };

        if (!data.versions) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const stableVersions: string[] = [];
        for (const ver of data.versions) {
          if (ver.yanked) continue;
          if (!ver.num) continue;
          
          // Skip pre-release versions
          if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver.num)) continue;
          
          const sv = semver.valid(semver.clean(ver.num));
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

    this.meta.set(crateName, p);
    return p;
  }
}
