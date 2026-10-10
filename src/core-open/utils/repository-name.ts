// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { readRootPackageIdentity } from './root-package-identity.js';

/** Repository name stored on scan artifacts and used for API deduplication. */
export function resolveRepositoryName(rootDir: string): string {
  return readRootPackageIdentity(rootDir).name;
}
