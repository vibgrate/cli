// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { Semaphore } from '../utils/semaphore.js';
import { gt, SemVer } from 'semver';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

const ARTIFACT_HUB_API = 'https://artifacthub.io/api/v1';
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_REQUESTS = 10;

/**
 * Fetch the latest version of a Helm chart from Artifact Hub.
 */
export async function fetchHelmLatestVersion(
  chartName: string,
  repo?: string,
  manifest?: PackageVersionManifest,
  semaphore?: Semaphore,
  offline = false,
): Promise<string | null> {
  const key = repo ? `${repo}/${chartName}` : chartName;

  // Check manifest first
  const manifestEntry = getManifestEntry(manifest, 'helm', key);
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

      // Search for the chart
      const searchUrl = `${ARTIFACT_HUB_API}/packages/search?kind=0&ts_query_web=${encodeURIComponent(chartName)}&limit=10`;
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'vibgrate-cli' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      const packages = (data.packages || []) as Array<{
        name: string;
        version: string;
        repository?: { name?: string };
      }>;

      // Find matching chart
      let matchedPackage = packages.find(p => p.name === chartName);

      // If repo specified, try to match by repo too
      if (repo && packages.length > 1) {
        matchedPackage = packages.find(p => 
          p.name === chartName && p.repository?.name === repo
        ) || matchedPackage;
      }

      if (!matchedPackage) {
        return null;
      }

      return matchedPackage.version;
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
 * Bulk fetch latest versions for multiple Helm charts.
 */
export async function fetchHelmVersionsBulk(
  charts: Array<{ name: string; repo?: string }>,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const semaphore = new Semaphore(CONCURRENT_REQUESTS);

  const promises = charts.map(async (chart) => {
    const version = await fetchHelmLatestVersion(chart.name, chart.repo, manifest, semaphore, offline);
    if (version) {
      const key = chart.repo ? `${chart.repo}/${chart.name}` : chart.name;
      results.set(key, version);
    }
  });

  await Promise.all(promises);
  return results;
}
