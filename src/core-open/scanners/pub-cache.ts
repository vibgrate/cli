// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface PubDevMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): PubDevMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch package metadata from pub.dev.
 * https://pub.dev/api/packages/{package}
 */
export class PubCache {
  private meta = new Map<string, Promise<PubDevMeta>>();
  private readonly disk: RegistryDiskCache<PubDevMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<PubDevMeta>('pub', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(packageName: string): Promise<PubDevMeta> {
    const existing = this.meta.get(packageName);
    if (existing) return existing;

    const p = this.resolve(packageName);
    this.meta.set(packageName, p);
    return p;
  }

  private async resolve(packageName: string): Promise<PubDevMeta> {
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

    const fromDisk = await this.disk.read(packageName);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(packageName));
    if (fetched.persist) await this.disk.write(packageName, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(packageName: string): Promise<{ meta: PubDevMeta; persist: boolean }> {
    try {
      const url = `https://pub.dev/api/packages/${encodeURIComponent(packageName)}`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as {
        latest?: {
          version?: string;
        };
        versions?: Array<{
          version?: string;
        }>;
      };

      if (!data.versions) return { meta: emptyMeta(), persist: true };

      const stableVersions: string[] = [];
      for (const ver of data.versions) {
        if (!ver.version) continue;
        if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver.version)) continue;
        const sv = semver.valid(semver.clean(ver.version));
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
