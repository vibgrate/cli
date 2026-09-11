// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Vendor Surface Catalog types and the shared builder.
 *
 * This package is compiled into the public CLI, so it carries NO vendor data:
 * no curated announcements, no roster, no bundled snapshot. All of that lives
 * in `packages/vibgrate-relevance/data/surfaces/`, compiled into the relevance
 * module for the CLI and imported by the API Worker for the dashboard and the
 * weekly refresh job. What is left here is pure logic — types plus the merge
 * the Worker and that job share so they cannot disagree.
 */
export * from './types.js';
export * from './catalog.js';
