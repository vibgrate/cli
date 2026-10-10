import * as path from 'node:path';
import { pathExists, readJsonFile } from './fs.js';
import { codedWarning, WARNING_CODES, type CodedWarning } from '../warnings.js';

/**
 * Identity of the root component when `package.json` omits `name`, `version`,
 * or both.
 *
 * The name is the manifest's `name` when that field is a non-empty string.
 * Otherwise it is the directory's basename: the last path segment only. It is
 * never an absolute path, a home directory, or a host name. An empty basename,
 * `.`, or `..` becomes {@link UNNAMED_ROOT_PACKAGE}.
 *
 * The version is the manifest's `version` when that field is a non-empty
 * string. Otherwise it is omitted. No version is invented — a made-up
 * `0.0.0` would be a different claim from "this package did not declare one".
 *
 * No Package URL is built for the root. An empty name is what makes other
 * SBOM tools throw "PURL name is required".
 */
export const UNNAMED_ROOT_PACKAGE = 'unnamed';

export interface PackageNameVersion {
  name?: unknown;
  version?: unknown;
}

export interface RootPackageIdentity {
  /** Component name. Never empty and never an absolute path. */
  name: string;
  /** Declared version, or null when the field is absent or blank. */
  version: string | null;
  usedNameFallback: boolean;
  usedVersionFallback: boolean;
  /** One warning when either field was missing. Null when both are present. */
  warning: CodedWarning | null;
}

/** A non-empty trimmed string, or null for anything else (blank, number, missing). */
export function manifestField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Last segment of `dir`. `path.resolve` is used only to drop `.` and `..`;
 * the returned string is that segment, not the absolute path.
 */
export function directoryBaseName(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return UNNAMED_ROOT_PACKAGE;
  const base = path.basename(path.resolve(trimmed));
  if (!base || base === '.' || base === '..') return UNNAMED_ROOT_PACKAGE;
  return base;
}

/**
 * Scan-root label safe to store as a component name. A normal basename is
 * returned unchanged. An absolute path, a multi-segment path, or an empty
 * label becomes the last segment (or {@link UNNAMED_ROOT_PACKAGE}).
 */
export function portableRootComponentName(rootPath: string | null | undefined): string {
  const trimmed = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!trimmed || trimmed === '.' || trimmed === '..') return UNNAMED_ROOT_PACKAGE;
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return directoryBaseName(trimmed);
  }
  return trimmed;
}

export function describeRootPackageIdentity(name: string, nameFallback: boolean, versionFallback: boolean): string {
  if (nameFallback && versionFallback) {
    return `Root package.json has no name or version. The root component name is "${name}". No version was invented.`;
  }
  if (nameFallback) {
    return `Root package.json has no name. The root component name is "${name}".`;
  }
  return 'Root package.json has no version. No version was invented for the root component.';
}

export function rootPackageIdentity(dir: string, manifest: PackageNameVersion | null | undefined): RootPackageIdentity {
  const record = manifest && typeof manifest === 'object' ? manifest : undefined;
  const declaredName = record ? manifestField(record.name) : null;
  const declaredVersion = record ? manifestField(record.version) : null;
  const usedNameFallback = declaredName === null;
  const usedVersionFallback = declaredVersion === null;
  const name = declaredName ?? directoryBaseName(dir);
  const warning =
    usedNameFallback || usedVersionFallback
      ? codedWarning(
          WARNING_CODES.ROOT_PACKAGE_IDENTITY,
          describeRootPackageIdentity(name, usedNameFallback, usedVersionFallback),
        )
      : null;
  return {
    name,
    version: declaredVersion,
    usedNameFallback,
    usedVersionFallback,
    warning,
  };
}

/**
 * Read the root `package.json`. Returns null when the file is absent or not
 * JSON — that is a different failure, not a missing name. A parsed manifest
 * always returns an identity, with a warning when `name` or `version` is missing.
 */
export async function readRootPackageIdentity(rootDir: string): Promise<RootPackageIdentity | null> {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!(await pathExists(packageJsonPath))) return null;
  try {
    const manifest = await readJsonFile<PackageNameVersion>(packageJsonPath);
    return rootPackageIdentity(rootDir, manifest);
  } catch {
    return null;
  }
}
