// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface SwiftPackageMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Fetch Swift package metadata from GitHub releases (most SPM packages use Git tags).
 * For packages hosted on GitHub, we'll try to fetch releases.
 */
export class SwiftCache {
  private meta = new Map<string, Promise<SwiftPackageMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(packageUrl: string): Promise<SwiftPackageMeta> {
    const existing = this.meta.get(packageUrl);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'swift', packageUrl);
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
        // Extract GitHub repo from URL (e.g., https://github.com/owner/repo.git → owner/repo)
        const githubMatch = packageUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/i);
        if (!githubMatch) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const repo = githubMatch[1]!;
        const url = `https://api.github.com/repos/${repo}/releases`;
        
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'vibgrate-cli',
          },
        });

        if (!response.ok) {
          // Fallback: try tags API
          return this.fetchFromTags(repo);
        }

        const data = await response.json() as Array<{
          tag_name?: string;
          prerelease?: boolean;
          draft?: boolean;
        }>;

        if (!Array.isArray(data)) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const stableVersions: string[] = [];
        for (const release of data) {
          if (release.prerelease || release.draft) continue;
          const tag = release.tag_name;
          if (!tag) continue;
          const sv = semver.valid(semver.clean(tag));
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

    this.meta.set(packageUrl, p);
    return p;
  }

  private async fetchFromTags(repo: string): Promise<SwiftPackageMeta> {
    try {
      const url = `https://api.github.com/repos/${repo}/tags`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'vibgrate-cli',
        },
      });

      if (!response.ok) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      const data = await response.json() as Array<{
        name?: string;
      }>;

      if (!Array.isArray(data)) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      const stableVersions: string[] = [];
      for (const tag of data) {
        const tagName = tag.name;
        if (!tagName) continue;
        // Skip pre-release tags
        if (/(?:alpha|beta|rc|pre|dev)/i.test(tagName)) continue;
        const sv = semver.valid(semver.clean(tagName));
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
  }
}
