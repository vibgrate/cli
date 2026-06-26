// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface PyPIMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
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

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(pkg: string): Promise<PyPIMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.sem.run(async () => {
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

      if (this.offline) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      try {
        // PyPI JSON API: https://pypi.org/pypi/{package}/json
        const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as {
          info?: { version?: string };
          releases?: Record<string, unknown[]>;
        };

        const allVersionKeys = Object.keys(data.releases ?? {});

        // Convert PEP 440 versions to semver and filter to stable
        const stableVersions: string[] = [];
        for (const ver of allVersionKeys) {
          const sv = pep440ToSemver(ver);
          if (sv) stableVersions.push(sv);
        }

        // Latest from PyPI info
        const pypiLatest = data.info?.version ?? null;
        const pypiLatestSemver = pypiLatest ? pep440ToSemver(pypiLatest) : null;

        // Find the latest stable version via semver sort
        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? pypiLatestSemver ?? null;

        return {
          latest: pypiLatestSemver ?? latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      } catch {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }
    });

    this.meta.set(pkg, p);
    return p;
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
      headers: { 'Accept': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
