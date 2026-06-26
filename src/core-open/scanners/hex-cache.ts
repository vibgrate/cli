// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { SemVer, gt } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

const HEX_API_BASE = 'https://hex.pm/api';
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_REQUESTS = 10;

/**
 * Fetch the latest stable version of an Elixir package from hex.pm.
 */
export async function fetchHexLatestVersion(
  packageName: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  // Check manifest first
  const manifestEntry = getManifestEntry(manifest, 'hex', packageName);
  if (manifestEntry?.latest) {
    return manifestEntry.latest;
  }

  if (offline) {
    return null;
  }

  const task = async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const url = `${HEX_API_BASE}/packages/${packageName}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'vibgrate-cli' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      const releases = data.releases as Array<{ version: string; retired?: any }>;

      if (!releases || releases.length === 0) {
        return null;
      }

      // Filter out retired versions and pre-releases
      const stableVersions = releases
        .filter(r => !r.retired)
        .map(r => r.version)
        .filter(v => {
          try {
            const semver = new SemVer(v);
            return semver.prerelease.length === 0;
          } catch {
            return false;
          }
        });

      if (stableVersions.length === 0) {
        return null;
      }

      // Sort and return the latest
      stableVersions.sort((a, b) => {
        try {
          return gt(a, b) ? -1 : 1;
        } catch {
          return 0;
        }
      });

      return stableVersions[0];
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return null;
      }
      return null;
    }
  };

  if (semaphore) {
    return semaphore.run(task);
  }

  return task();
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
