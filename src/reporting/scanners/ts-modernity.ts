import * as path from 'node:path';
import { findPackageJsonFiles, readJsonFile, readTextFile, pathExists, findFiles, FileCache } from '../../core-open/index.js';
import type { PackageJson, TsModernityResult } from '../../core-open/index.js';

export async function scanTsModernity(rootDir: string, cache?: FileCache): Promise<TsModernityResult> {
  const result: TsModernityResult = {
    typescriptVersion: null,
    strict: null,
    noImplicitAny: null,
    strictNullChecks: null,
    module: null,
    moduleResolution: null,
    target: null,
    moduleType: null,
    exportsField: false,
  };

  // Find TypeScript version from any package.json
  const pkgFiles = cache
    ? await cache.findPackageJsonFiles(rootDir)
    : await findPackageJsonFiles(rootDir);
  let hasEsm = false;
  let hasCjs = false;

  for (const pjPath of pkgFiles) {
    try {
      const pj = cache
        ? await cache.readJsonFile<PackageJson>(pjPath)
        : await readJsonFile<PackageJson>(pjPath);

      // TypeScript version (first found)
      if (!result.typescriptVersion) {
        const tsVer = pj.devDependencies?.['typescript'] ?? pj.dependencies?.['typescript'];
        if (tsVer) {
          result.typescriptVersion = tsVer.replace(/^[\^~>=<\s]+/, '');
        }
      }

      // Module type from package.json "type" field
      const typeField = (pj as Record<string, unknown>).type;
      if (typeField === 'module') hasEsm = true;
      else if (typeField === 'commonjs') hasCjs = true;
      else if (!typeField) hasCjs = true; // default is CJS

      // exports field presence
      if ((pj as Record<string, unknown>).exports) {
        result.exportsField = true;
      }
    } catch { /* skip */ }
  }

  // Determine module type
  if (hasEsm && hasCjs) result.moduleType = 'mixed';
  else if (hasEsm) result.moduleType = 'esm';
  else if (hasCjs) result.moduleType = 'cjs';

  // Read tsconfig.json (root-level first, then first found)
  let tsConfigPath = path.join(rootDir, 'tsconfig.json');
  const tsConfigExists = cache
    ? await cache.pathExists(tsConfigPath)
    : await pathExists(tsConfigPath);
  if (!tsConfigExists) {
    const tsConfigs = cache
      ? await cache.findFiles(rootDir, (name) => name === 'tsconfig.json')
      : await findFiles(rootDir, (name) => name === 'tsconfig.json');
    if (tsConfigs.length > 0) {
      tsConfigPath = tsConfigs[0]!;
    } else {
      return result;
    }
  }

  try {
    const raw = cache
      ? await cache.readTextFile(tsConfigPath)
      : await readTextFile(tsConfigPath);
    // Strip comments (tsconfig allows // and /* */ comments)
    const stripped = raw
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Remove trailing commas
      .replace(/,(\s*[}\]])/g, '$1');
    const tsConfig = JSON.parse(stripped);
    const co = tsConfig?.compilerOptions;
    if (co) {
      if (typeof co.strict === 'boolean') result.strict = co.strict;
      if (typeof co.noImplicitAny === 'boolean') result.noImplicitAny = co.noImplicitAny;
      if (typeof co.strictNullChecks === 'boolean') result.strictNullChecks = co.strictNullChecks;
      if (typeof co.module === 'string') result.module = co.module;
      if (typeof co.moduleResolution === 'string') result.moduleResolution = co.moduleResolution;
      if (typeof co.target === 'string') result.target = co.target;
    }
  } catch { /* malformed tsconfig */ }

  return result;
}
