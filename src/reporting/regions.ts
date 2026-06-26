/**
 * Data-residency region registry (CLI client view).
 *
 * Mirrors the server registry in
 * packages/vibgrate-api/src/lib/regions.ts. The CLI only needs the public
 * routing facts (ingest/dash hostnames + availability); region recommendation
 * is performed server-side via GET /v1/regions.
 *
 * Keep in sync with the API registry and docs/DATA-RESIDENCY.md.
 */

export type RegionId = 'us' | 'eu' | 'apac';

export interface CliRegion {
  id: RegionId;
  label: string;
  ingestHost: string;
  dashHost: string;
  available: boolean;
}

export const REGIONS: CliRegion[] = [
  {
    id: 'us',
    label: 'United States',
    ingestHost: 'us.ingest.vibgrate.com',
    dashHost: 'dash.vibgrate.com',
    available: true,
  },
  {
    id: 'eu',
    label: 'European Union',
    ingestHost: 'eu.ingest.vibgrate.com',
    dashHost: 'dash.vibgrate.eu',
    available: true,
  },
  {
    id: 'apac',
    label: 'Asia-Pacific (coming soon)',
    ingestHost: 'apac.ingest.vibgrate.com',
    dashHost: 'dash.vibgrate.com',
    available: false,
  },
];

export const DEFAULT_REGION: RegionId = 'us';

/** Region ids that are live and selectable today. */
export function availableRegionIds(): RegionId[] {
  return REGIONS.filter((r) => r.available).map((r) => r.id);
}

function findRegion(id: string): CliRegion | undefined {
  return REGIONS.find((r) => r.id === id);
}

/**
 * Resolve the ingest host for a region (or an explicit --ingest URL override).
 *
 * - An explicit `ingest` URL always wins (host is extracted from it).
 * - Otherwise the region must be known AND available.
 */
export function resolveIngestHost(region?: string, ingest?: string): string {
  if (ingest) {
    try {
      return new URL(ingest).host;
    } catch {
      throw new Error(`Invalid ingest URL: ${ingest}`);
    }
  }
  const id = (region ?? DEFAULT_REGION).toLowerCase();
  const match = findRegion(id);
  if (!match) {
    throw new Error(`Unknown region "${id}". Supported: ${availableRegionIds().join(', ')}`);
  }
  if (!match.available) {
    throw new Error(`Region "${id}" (${match.label}) is not yet available. Supported: ${availableRegionIds().join(', ')}`);
  }
  return match.ingestHost;
}

/** Resolve the dashboard host for a given ingest host (for report links). */
export function dashHostForIngestHost(ingestHost: string): string {
  const match = REGIONS.find((r) => r.ingestHost === ingestHost);
  return match?.dashHost ?? 'dash.vibgrate.com';
}

/**
 * Resolve the ingest host for a known region id, without throwing.
 *
 * Unlike {@link resolveIngestHost}, this never throws and ignores availability:
 * it is used to honour a server-issued residency redirect (a workspace pinned
 * to a region different from the endpoint we reached), so we must be able to
 * route to that region's host even if it is otherwise not user-selectable.
 * Returns `undefined` for an unknown region id.
 */
export function ingestHostForRegionId(region: string): string | undefined {
  return findRegion(region.toLowerCase())?.ingestHost;
}
