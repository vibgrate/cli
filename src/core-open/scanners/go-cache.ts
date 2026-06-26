// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface GoModuleMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch Go module metadata from proxy.golang.org.
 * https://go.dev/ref/mod#goproxy-protocol
 */
export class GoCache {
  private meta = new Map<string, Promise<GoModuleMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(modulePath: string): Promise<GoModuleMeta> {
    const existing = this.meta.get(modulePath);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'go', modulePath);
      if (manifestEntry) {
        const stableVersions: string[] = [];
        for (const ver of manifestEntry.versions ?? []) {
          // Go versions start with 'v' (e.g., v1.2.3)
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
        // Use Go proxy to get available versions
        // https://proxy.golang.org/<module>/@v/list
        const escapedPath = encodeURIComponent(modulePath);
        const url = `https://proxy.golang.org/${escapedPath}/@v/list`;
        
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'text/plain' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const text = await response.text();
        const versions = text.split('\n').filter(Boolean);

        const stableVersions: string[] = [];
        for (const ver of versions) {
          // Skip pre-release versions (e.g., v1.0.0-beta, v1.0.0-rc1)
          if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver)) continue;
          // Skip pseudo-versions (e.g., v0.0.0-20230101000000-abcdef123456)
          if (/v\d+\.\d+\.\d+-\d{14}-[a-f0-9]+/.test(ver)) continue;
          
          const sv = semver.valid(semver.clean(ver));
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

    this.meta.set(modulePath, p);
    return p;
  }
}
