// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export interface PyPIMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

function emptyMeta(): PyPIMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null };
}

/**
 * Normalise a PEP 440 version into something semver.valid can parse.
 * E.g. "3.12.1" → "3.12.1", "2.0.0rc1" → null (pre-release).
 * Returns null for versions that can't be converted to semver or are pre-release.
 */
function pep440ToSemver(ver: string): string | null {
  // Strip leading "v" or "V"
  let v = ver.replace(/^[vV]/, '').trim();

  // PEP 440 pre-release markers → treat as unstable
  if (/(?:a|b|rc|alpha|beta|dev|post)\d*/i.test(v)) return null;

  // Some Python versions are like "1.0" → pad to "1.0.0"
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  v = parts.slice(0, 3).join('.');

  return semver.valid(v);
}

/**
 * Fetch package metadata from PyPI JSON API with caching and concurrency control.
 */
export class PyPICache {
  private meta = new Map<string, Promise<PyPIMeta>>();
  private readonly disk: RegistryDiskCache<PyPIMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<PyPIMeta>('pypi', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get(pkg: string): Promise<PyPIMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.resolve(pkg);
    this.meta.set(pkg, p);
    return p;
  }

  private async resolve(pkg: string): Promise<PyPIMeta> {
    const manifestEntry = getManifestEntry(this.manifest, 'pypi', pkg);
    if (manifestEntry) {
      const stableVersions: string[] = [];
      for (const ver of manifestEntry.versions ?? []) {
        const sv = pep440ToSemver(ver);
        if (sv) stableVersions.push(sv);
      }
      const sorted = [...stableVersions].sort(semver.rcompare);
      const latestStableOverall = sorted[0] ?? null;
      return {
        latest: manifestEntry.latest ? pep440ToSemver(manifestEntry.latest) ?? latestStableOverall : latestStableOverall,
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

  private async fetchRemote(pkg: string): Promise<{ meta: PyPIMeta; persist: boolean }> {
    try {
      const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { meta: emptyMeta(), persist: true };
      if (!response.ok) return { meta: emptyMeta(), persist: false };

      const data = await response.json() as {
        info?: { version?: string };
        releases?: Record<string, unknown[]>;
      };

      const allVersionKeys = Object.keys(data.releases ?? {});
      const stableVersions: string[] = [];
      for (const ver of allVersionKeys) {
        const sv = pep440ToSemver(ver);
        if (sv) stableVersions.push(sv);
      }

      const pypiLatest = data.info?.version ?? null;
      const pypiLatestSemver = pypiLatest ? pep440ToSemver(pypiLatest) : null;
      const sorted = [...stableVersions].sort(semver.rcompare);
      const latestStableOverall = sorted[0] ?? pypiLatestSemver ?? null;

      return {
        meta: {
          latest: pypiLatestSemver ?? latestStableOverall,
          stableVersions,
          latestStableOverall,
        },
        persist: true,
      };
    } catch {
      return { meta: emptyMeta(), persist: false };
    }
  }
}

/**
 * Quick connectivity check for PyPI API.
 * Returns true if the registry is reachable.
 */
export async function checkPyPIAccess(): Promise<boolean> {
  try {
    const response = await fetch('https://pypi.org/pypi/pip/json', {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json', 'User-Agent': REGISTRY_USER_AGENT },
    });
    return response.ok;
  } catch {
    return false;
  }
}
