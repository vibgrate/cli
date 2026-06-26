// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Pure, dependency-free runtime-catalog surface shared by `@vibgrate/core` and
 * `@vibgrate/api` (imported as `@vibgrate/core/runtimes`). Contains only types,
 * pure accessors, and the bundled snapshot — no Node or network imports — so it
 * is safe to bundle into the Cloudflare Worker.
 */
export * from './types.js';
export * from './catalog.js';
export { BUNDLED_RUNTIME_CATALOG } from './snapshot.js';
