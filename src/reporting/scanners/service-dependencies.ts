/**
 * Third-party service dependencies (the `serviceDependencies` artifact field).
 *
 * This scanner used to carry a 360-entry table mapping npm package names to
 * vendor display names and service categories. Two problems with that: it was
 * curated data sitting in the public CLI, and every new vendor — or every
 * recategorisation — needed a CLI release before a single user saw it.
 *
 * The table now lives in the surface catalog with the rest of the vendor brain
 * (see `scanners/surfaces/`), so it is refreshed in one place. What is left
 * here is the shape: the same ten buckets, the same item fields, the same
 * locale-aware ordering the artifact has always had. Callers that already ran
 * the surface scan pass its legacy rows straight through
 * `toServiceDependencies`; this entry point exists for the ones that have not.
 *
 * When the catalog is unavailable the result is an **empty** set of buckets
 * rather than a partial one built from a stale inlined copy. A short list that
 * looks authoritative is worse than an obviously empty one.
 */
import type { ProjectScan, ServiceDependenciesResult } from '../../core-open/index.js';
import { loadSurfaceCatalog } from '../../engine/surface-provider.js';
import { emptyServiceDependencies, observePackages, toServiceDependencies } from './surfaces/index.js';

export { emptyServiceDependencies, toServiceDependencies } from './surfaces/index.js';

export async function scanServiceDependencies(projects: ProjectScan[]): Promise<ServiceDependenciesResult> {
  const catalog = await loadSurfaceCatalog();
  if (!catalog) return emptyServiceDependencies();
  try {
    const { serviceDependencies } = catalog.classify({ packages: observePackages(projects) });
    return toServiceDependencies(serviceDependencies ?? []);
  } catch {
    return emptyServiceDependencies();
  }
}
