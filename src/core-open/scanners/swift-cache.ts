// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface SwiftPackageMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): SwiftPackageMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch Swift package metadata from GitHub releases (most SPM packages use Git tags).
 * For packages hosted on GitHub, we'll try to fetch releases.
 */
export class SwiftCache {
  private meta = new Map<string, Promise<SwiftPackageMeta>>();
  private readonly disk: RegistryDiskCache<SwiftPackageMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<SwiftPackageMeta>('swift', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(packageUrl: string): Promise<SwiftPackageMeta> {
    const existing = this.meta.get(packageUrl);
    if (existing) return existing;

    const p = this.resolve(packageUrl);
    this.meta.set(packageUrl, p);
    return p;
  }

  private async resolve(packageUrl: string): Promise<SwiftPackageMeta> {
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

    const fromDisk = await this.disk.read(packageUrl);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(packageUrl));
    if (fetched.persist) await this.disk.write(packageUrl, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(packageUrl: string): Promise<{ meta: SwiftPackageMeta; persist: boolean }> {
    try {
      const githubMatch = packageUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/i);
      if (!githubMatch) {
        return { meta: emptyMeta(), persist: true };
      }

      const repo = githubMatch[1]!;
      const url = `https://api.github.com/repos/${repo}/releases`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': REGISTRY_USER_AGENT,
        },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) {
        const tags = await this.fetchFromTags(repo);
        return { meta: tags, persist: true };
      }

      const data = await response.json() as Array<{
        tag_name?: string;
        prerelease?: boolean;
        draft?: boolean;
      }>;

      if (!Array.isArray(data)) return { meta: emptyMeta(), persist: true };

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
        meta: { latest: latestStableOverall, stableVersions, latestStableOverall },
        persist: true,
      };
    } catch {
      return { meta: emptyMeta(), persist: false };
    }
  }

  private async fetchFromTags(repo: string): Promise<SwiftPackageMeta> {
    try {
      const url = `https://api.github.com/repos/${repo}/tags`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': REGISTRY_USER_AGENT,
        },
      });

      if (!response.ok) return emptyMeta();

      const data = await response.json() as Array<{
        name?: string;
      }>;

      if (!Array.isArray(data)) return emptyMeta();

      const stableVersions: string[] = [];
      for (const tag of data) {
        const tagName = tag.name;
        if (!tagName) continue;
        if (/(?:alpha|beta|rc|pre|dev)/i.test(tagName)) continue;
        const sv = semver.valid(semver.clean(tagName));
        if (sv) stableVersions.push(sv);
      }
      const sorted = [...stableVersions].sort(semver.rcompare);
      const latestStableOverall = sorted[0] ?? null;

      return { latest: latestStableOverall, stableVersions, latestStableOverall };
    } catch {
      return emptyMeta();
    }
  }
}
