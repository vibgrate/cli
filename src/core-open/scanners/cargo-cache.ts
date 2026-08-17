// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface CratesMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): CratesMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch crate metadata from crates.io API.
 * https://crates.io/api/v1/crates/{crate}
 */
export class CargoCache {
  private meta = new Map<string, Promise<CratesMeta>>();
  private readonly disk: RegistryDiskCache<CratesMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<CratesMeta>('cargo', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(crateName: string): Promise<CratesMeta> {
    const existing = this.meta.get(crateName);
    if (existing) return existing;

    const p = this.resolve(crateName);
    this.meta.set(crateName, p);
    return p;
  }

  private async resolve(crateName: string): Promise<CratesMeta> {
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

    const fromDisk = await this.disk.read(crateName);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(crateName));
    if (fetched.persist) await this.disk.write(crateName, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(crateName: string): Promise<{ meta: CratesMeta; persist: boolean }> {
    try {
      const url = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'User-Agent': REGISTRY_USER_AGENT,
        },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as {
        crate?: {
          max_version?: string;
        };
        versions?: Array<{
          num?: string;
          yanked?: boolean;
        }>;
      };

      if (!data.versions) return { meta: emptyMeta(), persist: true };

      const stableVersions: string[] = [];
      for (const ver of data.versions) {
        if (ver.yanked) continue;
        if (!ver.num) continue;
        if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver.num)) continue;
        const sv = semver.valid(semver.clean(ver.num));
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
