// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import { pathExists, readJsonFile } from './fs.js';

/** Repository name stored on scan artifacts and used for API deduplication. */
export async function resolveRepositoryName(rootDir: string): Promise<string> {
  const packageJsonPath = path.join(rootDir, 'package.json');
  let name = path.basename(rootDir);

  if (await pathExists(packageJsonPath)) {
    try {
      const packageJson = await readJsonFile<{ name?: string }>(packageJsonPath);
      if (typeof packageJson.name === 'string' && packageJson.name.trim()) {
        name = packageJson.name.trim();
      }
    } catch {
      // fall back to directory name
    }
  }

  return name;
}
