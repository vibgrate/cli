// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface GoModuleMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): GoModuleMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Fetch Go module metadata from proxy.golang.org.
 * https://go.dev/ref/mod#goproxy-protocol
 */
export class GoCache {
  private meta = new Map<string, Promise<GoModuleMeta>>();
  private readonly disk: RegistryDiskCache<GoModuleMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<GoModuleMeta>('go', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(modulePath: string): Promise<GoModuleMeta> {
    const existing = this.meta.get(modulePath);
    if (existing) return existing;

    const p = this.resolve(modulePath);
    this.meta.set(modulePath, p);
    return p;
  }

  private async resolve(modulePath: string): Promise<GoModuleMeta> {
    const manifestEntry = getManifestEntry(this.manifest, 'go', modulePath);
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

    const fromDisk = await this.disk.read(modulePath);
    if (fromDisk) return fromDisk;
    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(modulePath));
    if (fetched.persist) await this.disk.write(modulePath, fetched.meta);
    return fetched.meta;
  }

  private async fetchRemote(modulePath: string): Promise<{ meta: GoModuleMeta; persist: boolean }> {
    try {
      const escapedPath = encodeURIComponent(modulePath);
      const url = `https://proxy.golang.org/${escapedPath}/@v/list`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'text/plain', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const text = await response.text();
      const versions = text.split('\n').filter(Boolean);
      const stableVersions: string[] = [];
      for (const ver of versions) {
        if (/[+-](?:alpha|beta|rc|pre|dev)/i.test(ver)) continue;
        if (/v\d+\.\d+\.\d+-\d{14}-[a-f0-9]+/.test(ver)) continue;
        const sv = semver.valid(semver.clean(ver));
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
