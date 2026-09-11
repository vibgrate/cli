// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Vendor Surface Catalog — the freshness half of the External Surface Inventory.
 *
 * Two datasets back that feature and they are deliberately kept apart:
 *
 *   1. The **provider brain** — which package, host, env-key name or model-id
 *      prefix belongs to which vendor, its category and its icon. Curated,
 *      valuable, and compiled into the relevance kernel. It is not here and
 *      must not come here.
 *   2. The **vendor freshness catalog** — which models a vendor has deprecated
 *      or retired, and which API version is current. These are public facts the
 *      vendors themselves publish, they are served unauthenticated from
 *      `/v1/reference/surfaces`, and they need refreshing every week. That is
 *      this file.
 *
 * Like the Runtime Catalog next door, these types and the accessors in
 * `catalog.ts` are **pure** — no Node, no network — so the CLI, the API Worker
 * and the weekly refresh job all share one implementation and cannot disagree
 * about whether a model is retired.
 */

/** One model a vendor offers, or used to. */
export interface VendorModelEntry {
  /** Canonical provider slug the relevance catalog also uses: `openai`, `anthropic`, … */
  providerId: string;
  /** The id as the vendor's API accepts it, lowercased. */
  modelId: string;
  displayName: string;
  /** ISO date the model was released, when the source states one. */
  releasedAt?: string;
  /** The vendor has announced a retirement date but still serves it. */
  deprecated?: boolean;
  /** The vendor no longer serves it at all. */
  retired?: boolean;
  /** What the vendor points users at instead. */
  successorId?: string;
  /**
   * The newest model in this provider's family, as of `generatedAt`. Drives the
   * `behind` verdict, so it is only ever set from a source that actually lists
   * what a vendor currently offers — never inferred from a version number.
   */
  latestForFamily?: boolean;
  /**
   * Where this row came from. `curated` rows are hand-maintained vendor
   * announcements; the refresh job must preserve them rather than overwrite
   * them from a roster that cannot express a retirement.
   */
  origin: VendorFactOrigin;
}

/** Provenance of a single catalog row. */
export type VendorFactOrigin = 'curated' | 'vibgrate-models' | 'openrouter';

/** A vendor API whose version a caller can pin. */
export interface VendorApiEntry {
  providerId: string;
  /** `rest`, `ingest`, … — a provider may expose more than one. */
  apiId: string;
  currentVersion: string;
  deprecatedVersions?: string[];
  hosts?: string[];
  origin: VendorFactOrigin;
}

/** An MCP server package and the version the registry currently publishes. */
export interface VendorMcpEntry {
  providerId: string;
  package: string;
  latestVersion: string;
  defaultCommand?: string;
  defaultArgs?: string[];
  origin: VendorFactOrigin;
}

export interface VendorSurfaceCatalog {
  /** ISO date the catalog's knowledge is good as of — the freshness signal. */
  generatedAt: string;
  /** Every source that contributed, so a reader can judge the rows. */
  sources: string[];
  models: VendorModelEntry[];
  apis: VendorApiEntry[];
  mcp: VendorMcpEntry[];
}

/** Where a resolved catalog came from, for confidence disclosure. */
export type SurfaceCatalogSource = 'module' | 'none';

export interface ResolvedSurfaceCatalog {
  catalog: VendorSurfaceCatalog;
  source: SurfaceCatalogSource;
}
