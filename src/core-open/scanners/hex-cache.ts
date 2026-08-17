// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { SemVer, gt } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, REGISTRY_FETCH_TIMEOUT_MS, REGISTRY_USER_AGENT } from '../utils/registry-disk-cache.js';

const HEX_API_BASE = 'https://hex.pm/api';
const CONCURRENT_REQUESTS = 10;

interface HexMeta {
  latest: string | null;
}

const hexDisk = new RegistryDiskCache<HexMeta>('hex');

/**
 * Fetch the latest stable version of an Elixir package from hex.pm.
 */
export async function fetchHexLatestVersion(
  packageName: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  const manifestEntry = getManifestEntry(manifest, 'hex', packageName);
  if (manifestEntry?.latest) {
    return manifestEntry.latest;
  }

  const cached = await hexDisk.read(packageName);
  if (cached) return cached.latest;
  if (offline) return null;

  const task = async (): Promise<{ latest: string | null; persist: boolean }> => {
    try {
      const url = `${HEX_API_BASE}/packages/${encodeURIComponent(packageName)}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': REGISTRY_USER_AGENT },
      });

      if (response.status === 404) return { latest: null, persist: true };
      if (!response.ok) return { latest: null, persist: false };

      const data = await response.json() as { releases?: Array<{ version: string; retired?: unknown }> };
      const releases = data.releases;

      if (!releases || releases.length === 0) {
        return { latest: null, persist: true };
      }

      const stableVersions = releases
        .filter((r) => !r.retired)
        .map((r) => r.version)
        .filter((v) => {
          try {
            const semver = new SemVer(v);
            return semver.prerelease.length === 0;
          } catch {
            return false;
          }
        });

      if (stableVersions.length === 0) {
        return { latest: null, persist: true };
      }

      stableVersions.sort((a, b) => {
        try {
          return gt(a, b) ? -1 : 1;
        } catch {
          return 0;
        }
      });

      return { latest: stableVersions[0] ?? null, persist: true };
    } catch {
      return { latest: null, persist: false };
    }
  };

  const fetched = semaphore ? await semaphore.run(task) : await task();
  if (fetched.persist) await hexDisk.write(packageName, { latest: fetched.latest });
  return fetched.latest;
}

/**
 * Bulk fetch latest versions for multiple Elixir packages.
 */
export async function fetchHexVersionsBulk(
  packageNames: string[],
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const semaphore = new Semaphore(CONCURRENT_REQUESTS);

  const promises = packageNames.map(async (name) => {
    const version = await fetchHexLatestVersion(name, manifest, semaphore, offline);
    if (version) {
      results.set(name, version);
    }
  });

  await Promise.all(promises);
  return results;
}
