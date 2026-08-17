// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface NuGetMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): NuGetMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch package metadata from NuGet V3 API with caching and concurrency control.
 *
 * Uses the NuGet RegistrationBaseUrl to fetch version data for each package.
 * Falls back gracefully when the registry is unreachable.
 */
export class NuGetCache {
  private meta = new Map<string, Promise<NuGetMeta>>();
  private readonly disk: RegistryDiskCache<NuGetMeta>;
  private readonly fetchImpl: typeof fetch;
  private baseUrl = 'https://api.nuget.org/v3-flatcontainer';

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<NuGetMeta>('nuget', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(pkg: string): Promise<NuGetMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.resolve(pkg);
    this.meta.set(pkg, p);
    return p;
  }

  private async resolve(pkg: string): Promise<NuGetMeta> {
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

    const fromDisk = await this.disk.read(pkg);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(pkg));
    if (fetched.persist) await this.disk.write(pkg, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(pkg: string): Promise<{ meta: NuGetMeta; persist: boolean }> {
    try {
      const url = `${this.baseUrl}/${pkg.toLowerCase()}/index.json`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as { versions?: string[] };
      const allVersions = data.versions ?? [];
      const stableVersions = allVersions.filter((v) => {
        const parsed = semver.valid(v);
        return parsed && semver.prerelease(v) === null;
      });
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

/**
 * Quick connectivity check for NuGet API.
 * Returns true if the registry is reachable.
 */
export async function checkNuGetAccess(): Promise<boolean> {
  try {
    const response = await fetch('https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json', {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
    });
    return response.ok;
  } catch {
    return false;
  }
}
