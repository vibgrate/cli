// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import { pathExists, readJsonFile } from './fs.js';
import { directoryBaseName, manifestField, type PackageNameVersion } from './root-package-identity.js';

/** Repository name stored on scan artifacts and used for API deduplication. */
export async function resolveRepositoryName(rootDir: string): Promise<string> {
  const packageJsonPath = path.join(rootDir, 'package.json');

  if (await pathExists(packageJsonPath)) {
    try {
      const packageJson = await readJsonFile<PackageNameVersion>(packageJsonPath);
      const declared = manifestField(packageJson.name);
      if (declared) return declared;
    } catch {
      // fall back to directory name
    }
  }

  return directoryBaseName(rootDir);
}
