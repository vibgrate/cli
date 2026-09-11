/**
 * External Surface Inventory scanner.
 *
 * Two halves that must stay apart: `observe.ts` reports what the repository
 * literally contains, and the surface catalog (in the optional module, behind
 * `engine/surface-provider.ts`) says which vendor that means and whether it is
 * still current. This file is only the join between them.
 *
 * Offline-first: observation never touches the network, and the catalog's
 * bundled floor answers without one. When the module is unavailable the scan
 * still completes — it simply reports no inventory, which the dashboard
 * distinguishes from an empty one.
 */
import type { FileCache, ProjectScan, ServiceDependenciesResult, ServiceDependencyItem, SurfaceInventory } from '../../../core-open/index.js';
import { loadSurfaceCatalog, sanitizeInventory, type LegacyServiceRow } from '../../../engine/surface-provider.js';
import { observeSurfaces } from './observe.js';

export { observeMcpServers, observePackages, observeSource, observeSurfaces } from './observe.js';

export interface SurfaceScanResult {
  inventory: SurfaceInventory;
  serviceDependencies: ServiceDependenciesResult;
}

/** The legacy buckets, in their historical order. */
const LEGACY_BUCKETS = [
  'payment', 'auth', 'email', 'cloud', 'databases',
  'messaging', 'observability', 'crm', 'storage', 'search',
] as const;

export function emptyServiceDependencies(): ServiceDependenciesResult {
  return {
    payment: [], auth: [], email: [], cloud: [], databases: [],
    messaging: [], observability: [], crm: [], storage: [], search: [],
  };
}

/**
 * Fold the catalog's flat legacy rows back into the `ServiceDependenciesResult`
 * shape the artifact has always carried. The locale-aware sort is deliberate —
 * it is the ordering the previous hardcoded scanner produced, and changing it
 * would churn every stored artifact for no reader's benefit.
 */
export function toServiceDependencies(rows: LegacyServiceRow[]): ServiceDependenciesResult {
  const result = emptyServiceDependencies();
  const byBucket = result as unknown as Record<string, ServiceDependencyItem[]>;
  for (const row of rows) {
    if (!(LEGACY_BUCKETS as readonly string[]).includes(row.bucket)) continue;
    byBucket[row.bucket].push({ name: row.name, package: row.package, version: row.version });
  }
  for (const bucket of LEGACY_BUCKETS) {
    byBucket[bucket].sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

export interface SurfaceScanOptions {
  /**
   * Stamped onto the inventory and used as the kernel's "today" for catalog
   * staleness. Injectable so fixtures can pin it — it is the artifact's only
   * nondeterministic field.
   */
  generatedAt?: string;
}

// There is deliberately no `offline` option. Surface detection makes no network
// call at all — the vendor catalog is compiled into the relevance module — so
// there is nothing for an offline or max-privacy run to switch off.


/**
 * Detect the external surfaces this repo talks to. Returns `null` when the
 * surface catalog is unavailable (kernel disabled, module not installed, or an
 * older module) — the caller then leaves both fields off the artifact rather
 * than writing an empty inventory, because "not scanned" and "none found" are
 * different facts.
 */
export async function scanExternalSurfaces(
  rootDir: string,
  cache: FileCache,
  projects: ProjectScan[],
  opts: SurfaceScanOptions = {},
): Promise<SurfaceScanResult | null> {
  const catalog = await loadSurfaceCatalog();
  if (!catalog) return null;

  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const observations = await observeSurfaces(rootDir, cache, projects, generatedAt.slice(0, 10));

  // No catalog is fetched or passed in. Both halves of the vendor facts — the
  // generated roster and the curated announcements — are compiled into the
  // module, so a scan makes no network call for surfaces and returns the same
  // verdicts online, offline and air-gapped. The module's own version is the
  // freshness signal; the weekly refresh job republishes it.
  try {
    const classified = catalog.classify(observations);
    return {
      inventory: sanitizeInventory(classified.inventory, generatedAt),
      serviceDependencies: toServiceDependencies(classified.serviceDependencies ?? []),
    };
  } catch {
    // A module that throws is treated as no module at all — the scan proceeds.
    return null;
  }
}
