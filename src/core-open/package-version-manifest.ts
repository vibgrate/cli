// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RuntimeCatalog } from './runtimes/types.js';
import { ArchiveLimitError, readManifestZipMembers, ZipManifestError } from './utils/zip-manifest.js';

/**
 * An advisory entry as carried by an offline package-version manifest, used for
 * air-gapped vulnerability scanning. Mirrors the affected-range shape of an OSV
 * advisory so the same version-matching logic applies online and offline.
 */
export interface ManifestAdvisory {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
  cvss?: number;
  cvssVector?: string;
  /** Affected semver ranges as [introduced, fixed) pairs (either bound optional). */
  ranges?: Array<{ introduced?: string; fixed?: string }>;
  /** Explicit affected versions, as an alternative/complement to `ranges`. */
  versions?: string[];
  published?: string;
  withdrawn?: string;
  references?: string[];
  /**
   * FIRST EPSS probability (0–1) already known for this advisory. Omitted or
   * null when unknown — never use `0` to mean "not scored". A numeric string
   * such as `"0.42"` is accepted; values outside 0–1 are ignored.
   */
  epss?: number | string | null;
  /** EPSS percentile (0–1) already known for this advisory. Same absence rule as `epss`. */
  epssPercentile?: number | string | null;
  /**
   * CISA Known Exploited Vulnerabilities membership, when this bundle already
   * says so. Omit when unknown; `false` means the bundle explicitly says not listed.
   */
  kev?: boolean | null;
}

export interface EcosystemVersionEntry {
  latest?: string;
  versions?: string[];
  /** Declared license (SPDX id/expression) for the package, when known. */
  license?: string;
  /**
   * Optional map of version → ISO-8601 publish date. When present, enables
   * libyear-based dependency-freshness scoring fully offline (no registry or
   * Vibgrate server-side call). Producers of offline manifests should populate
   * this from `npm view <pkg> time` (or the equivalent per ecosystem).
   */
  releaseDates?: Record<string, string>;
  /**
   * Optional known-vulnerability advisories for this package, enabling air-gapped
   * vulnerability scanning. Each advisory carries its own affected ranges so the
   * matcher decides applicability against the installed version.
   */
  vulns?: ManifestAdvisory[];
}

export interface PackageVersionManifest {
  /**
   * Optional Runtime Catalog (Node/Python/Java/.NET/Go/Ruby latest, LTS, and EOL
   * dates). Lets `--package-manifest`/`--offline` users supply or refresh runtime
   * currency data the same way they supply package data.
   */
  runtimes?: RuntimeCatalog;
  npm?: Record<string, EcosystemVersionEntry>;
  nuget?: Record<string, EcosystemVersionEntry>;
  pypi?: Record<string, EcosystemVersionEntry>;
  maven?: Record<string, EcosystemVersionEntry>;
  rubygems?: Record<string, EcosystemVersionEntry>;
  swift?: Record<string, EcosystemVersionEntry>;
  go?: Record<string, EcosystemVersionEntry>;
  cargo?: Record<string, EcosystemVersionEntry>;
  composer?: Record<string, EcosystemVersionEntry>;
  pub?: Record<string, EcosystemVersionEntry>;
  hex?: Record<string, EcosystemVersionEntry>;
  docker?: Record<string, EcosystemVersionEntry>;
  helm?: Record<string, EcosystemVersionEntry>;
  terraform?: Record<string, EcosystemVersionEntry>;
}

async function parseManifestText(text: string, source: string): Promise<PackageVersionManifest> {
  try {
    return JSON.parse(text) as PackageVersionManifest;
  } catch {
    throw new Error(`Invalid JSON in package version manifest: ${source}`);
  }
}

async function loadManifestFromZip(zipPath: string): Promise<PackageVersionManifest> {
  let members: string[];
  try {
    members = await readManifestZipMembers(zipPath);
  } catch (err) {
    if (err instanceof ArchiveLimitError) throw err;
    if (err instanceof ZipManifestError) {
      throw new Error('Zip must contain package-versions.json, manifest.json, or index.json');
    }
    throw err;
  }
  for (const text of members) {
    try {
      return await parseManifestText(text, zipPath);
    } catch {
      // keep searching the well-known names
    }
  }
  throw new Error('Zip must contain package-versions.json, manifest.json, or index.json');
}

export async function loadPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  const resolved = path.resolve(filePath);
  if (resolved.toLowerCase().endsWith('.zip')) {
    return loadManifestFromZip(resolved);
  }
  const text = await readFile(resolved, 'utf8');
  return parseManifestText(text, resolved);
}

/** Package ecosystems in the manifest (everything except the runtime catalog). */
export type ManifestEcosystem = Exclude<keyof PackageVersionManifest, 'runtimes'>;

export function getManifestEntry(
  manifest: PackageVersionManifest | undefined,
  ecosystem: ManifestEcosystem,
  packageName: string,
): EcosystemVersionEntry | undefined {
  if (!manifest) return undefined;
  const table = manifest[ecosystem];
  if (!table) return undefined;
  if (ecosystem === 'nuget') {
    return table[packageName.toLowerCase()] ?? table[packageName];
  }
  return table[packageName];
}
