// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { gt, SemVer } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

const TERRAFORM_REGISTRY_API = 'https://registry.terraform.io/v1';
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_REQUESTS = 10;

/**
 * Fetch the latest version of a Terraform provider.
 */
export async function fetchTerraformProviderLatestVersion(
  namespace: string,
  name: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  const key = `${namespace}/${name}`;

  // Check manifest first
  const manifestEntry = getManifestEntry(manifest, 'terraform', key);
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

      const url = `${TERRAFORM_REGISTRY_API}/providers/${namespace}/${name}/versions`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'vibgrate-cli' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      const versions = (data.versions || []) as Array<{ version: string }>;

      if (versions.length === 0) {
        return null;
      }

      // Filter pre-releases and sort
      const stableVersions: SemVer[] = [];
      for (const v of versions) {
        try {
          const semver = new SemVer(v.version);
          if (semver.prerelease.length === 0) {
            stableVersions.push(semver);
          }
        } catch {
          // Invalid semver
        }
      }

      if (stableVersions.length === 0) {
        return null;
      }

      // Sort descending
      stableVersions.sort((a, b) => (gt(a.version, b.version) ? -1 : 1));

      return stableVersions[0].version;
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
 * Fetch the latest version of a Terraform module.
 */
export async function fetchTerraformModuleLatestVersion(
  namespace: string,
  name: string,
  provider: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  const key = `${namespace}/${name}/${provider}`;

  // Check manifest first
  const manifestEntry = getManifestEntry(manifest, 'terraform', key);
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

      const url = `${TERRAFORM_REGISTRY_API}/modules/${namespace}/${name}/${provider}/versions`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'vibgrate-cli' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      const modules = (data.modules || []) as Array<{ versions: Array<{ version: string }> }>;

      if (modules.length === 0 || !modules[0].versions) {
        return null;
      }

      const versions = modules[0].versions;

      // Filter pre-releases and sort
      const stableVersions: SemVer[] = [];
      for (const v of versions) {
        try {
          const semver = new SemVer(v.version);
          if (semver.prerelease.length === 0) {
            stableVersions.push(semver);
          }
        } catch {
          // Invalid semver
        }
      }

      if (stableVersions.length === 0) {
        return null;
      }

      // Sort descending
      stableVersions.sort((a, b) => (gt(a.version, b.version) ? -1 : 1));

      return stableVersions[0].version;
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
 * Bulk fetch latest versions for Terraform providers and modules.
 */
export async function fetchTerraformVersionsBulk(
  items: Array<{ type: 'provider' | 'module'; namespace: string; name: string; provider?: string }>,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const semaphore = new Semaphore(CONCURRENT_REQUESTS);

  const promises = items.map(async (item) => {
    let version: string | null = null;
    let key: string;

    if (item.type === 'provider') {
      key = `${item.namespace}/${item.name}`;
      version = await fetchTerraformProviderLatestVersion(item.namespace, item.name, manifest, semaphore, offline);
    } else {
      key = `${item.namespace}/${item.name}/${item.provider}`;
      version = await fetchTerraformModuleLatestVersion(item.namespace, item.name, item.provider!, manifest, semaphore, offline);
    }

    if (version) {
      results.set(key, version);
    }
  });

  await Promise.all(promises);
  return results;
}
