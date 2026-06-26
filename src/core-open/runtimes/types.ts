// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Runtime Catalog — a fresh, vendor-sourced (endoflife.date) dataset that drives
 * runtime *latest*, *latest LTS*, and *EOL date* signals for both the CLI/core
 * DriftScore and the server RiskScore. See
 * docs/product-analysis/specs/RUNTIME-DATA-DESTALING-SPEC.md.
 *
 * These types and the accessors in `catalog.ts` are **pure** (no Node or network
 * imports) so the exact same logic is shared by `@vibgrate/core` and
 * `@vibgrate/api` — the two scores can never disagree about whether a runtime is
 * EOL ("one brain").
 */

/** A single release line of a runtime, as published by endoflife.date. */
export interface RuntimeCycle {
  /** e.g. "22", "3.13", "8.0", "21". */
  cycle: string;
  /** ISO release date (for libyear / freshness), when known. */
  releaseDate?: string;
  /** ISO end-of-life date, or boolean (true = already EOL, false = supported). */
  eol: string | boolean;
  /** LTS flag, or the ISO date the cycle entered LTS. */
  lts?: boolean | string;
  /** Latest patch on this cycle, e.g. "22.3.0". */
  latestPatch?: string;
}

/** All known cycles for one endoflife.date product (e.g. `nodejs`). */
export interface RuntimeProduct {
  product: string;
  cycles: RuntimeCycle[];
}

/** The full catalog across every runtime product Vibgrate scores. */
export interface RuntimeCatalog {
  /** ISO timestamp the catalog was generated — the freshness/confidence signal. */
  generatedAt: string;
  source: 'endoflife.date';
  /** Keyed by endoflife.date product slug: nodejs, python, dotnet, java, php, ruby, go. */
  products: Record<string, RuntimeProduct>;
}

/** Where a resolved catalog came from, for confidence disclosure. */
export type RuntimeCatalogSource = 'cache' | 'api' | 'manifest' | 'bundled';

/** A resolved catalog plus its provenance. */
export interface ResolvedRuntimeCatalog {
  catalog: RuntimeCatalog;
  source: RuntimeCatalogSource;
}

/** A major(.minor) runtime version parsed from a cycle string. */
export interface RuntimeVersion {
  major: number;
  minor: number;
}
