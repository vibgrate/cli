// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface PackagistMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): PackagistMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch package metadata from Packagist (packagist.org).
 * https://packagist.org/apidoc
 */
export class ComposerCache {
  private meta = new Map<string, Promise<PackagistMeta>>();
  private readonly disk: RegistryDiskCache<PackagistMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<PackagistMeta>('composer', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(packageName: string): Promise<PackagistMeta> {
    const existing = this.meta.get(packageName);
    if (existing) return existing;

    const p = this.resolve(packageName);
    this.meta.set(packageName, p);
    return p;
  }

  private async resolve(packageName: string): Promise<PackagistMeta> {
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

    const fromDisk = await this.disk.read(packageName);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(packageName));
    if (fetched.persist) await this.disk.write(packageName, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(packageName: string): Promise<{ meta: PackagistMeta; persist: boolean }> {
    try {
      const url = `https://repo.packagist.org/p2/${encodeURIComponent(packageName)}.json`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as {
        packages?: {
          [key: string]: Array<{
            version?: string;
            version_normalized?: string;
          }>;
        };
      };

      if (!data.packages) return { meta: emptyMeta(), persist: true };

      const packageVersions = data.packages[packageName];
      if (!packageVersions || !Array.isArray(packageVersions)) {
        return { meta: emptyMeta(), persist: true };
      }

      const stableVersions: string[] = [];
      for (const ver of packageVersions) {
        const version = ver.version ?? ver.version_normalized;
        if (!version) continue;
        if (version === 'dev-master' || version.startsWith('dev-')) continue;
        if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(version)) continue;
        const sv = semver.valid(semver.clean(version));
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
