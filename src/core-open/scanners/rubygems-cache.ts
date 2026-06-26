// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

export interface RubyGemsMeta {
  latest: string | null;
  stableVersions: string[];
  latestStableOverall: string | null;
}

/**
 * Normalise a Ruby gem version into something semver.valid can parse.
 * Ruby uses relaxed semver (e.g. "3.2.1", "7.1.3.4", "1.0.0.pre").
 * Returns null for pre-release versions.
 */
function rubyVersionToSemver(ver: string): string | null {
  const v = ver.trim();

  // Pre-release markers in Ruby gems
  if (/(?:\.pre|\.rc|\.beta|\.alpha|\.dev)/i.test(v)) return null;

  // Split on dots — Ruby sometimes uses 4-segment versions (e.g. 7.1.3.4)
  const parts = v.split('.');

  // Need at least major.minor
  if (parts.length < 2) return null;

  // Take first 3 parts, pad if needed
  while (parts.length < 3) parts.push('0');
  const semverStr = parts.slice(0, 3).join('.');

  return semver.valid(semverStr);
}

/**
 * Fetch gem metadata from RubyGems.org API with caching and concurrency control.
 */
export class RubyGemsCache {
  private meta = new Map<string, Promise<RubyGemsMeta>>();

  constructor(
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  get(gem: string): Promise<RubyGemsMeta> {
    const existing = this.meta.get(gem);
    if (existing) return existing;

    const p = this.sem.run(async () => {
      // Check manifest first (for offline mode)
      const manifestEntry = getManifestEntry(this.manifest, 'rubygems', gem);
      if (manifestEntry) {
        const stableVersions: string[] = [];
        for (const ver of manifestEntry.versions ?? []) {
          const sv = rubyVersionToSemver(ver);
          if (sv) stableVersions.push(sv);
        }
        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? null;
        return {
          latest: manifestEntry.latest ? rubyVersionToSemver(manifestEntry.latest) ?? latestStableOverall : latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      }

      if (this.offline) {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }

      try {
        // RubyGems.org API: https://rubygems.org/api/v1/versions/{gem}.json
        const url = `https://rubygems.org/api/v1/versions/${encodeURIComponent(gem)}.json`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        const data = await response.json() as Array<{
          number?: string;
          prerelease?: boolean;
        }>;

        if (!Array.isArray(data)) {
          return { latest: null, stableVersions: [], latestStableOverall: null };
        }

        // Convert Ruby versions to semver and filter to stable
        const stableVersions: string[] = [];
        for (const entry of data) {
          if (entry.prerelease) continue;
          const ver = entry.number;
          if (!ver) continue;
          const sv = rubyVersionToSemver(ver);
          if (sv) stableVersions.push(sv);
        }

        // Sort descending to find latest
        const sorted = [...stableVersions].sort(semver.rcompare);
        const latestStableOverall = sorted[0] ?? null;

        return {
          latest: latestStableOverall,
          stableVersions,
          latestStableOverall,
        };
      } catch {
        return { latest: null, stableVersions: [], latestStableOverall: null };
      }
    });

    this.meta.set(gem, p);
    return p;
  }
}

/**
 * Quick connectivity check for RubyGems.org API.
 * Returns true if the registry is reachable.
 */
export async function checkRubyGemsAccess(): Promise<boolean> {
  try {
    const response = await fetch('https://rubygems.org/api/v1/gems/rails.json', {
      signal: AbortSignal.timeout(5_000),
      headers: { 'Accept': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
