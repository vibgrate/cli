import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ArchiveLimitError, readManifestZipMembers, ZipManifestError } from '../core-open/utils/zip-manifest.js';

export interface EcosystemVersionEntry {
  latest?: string;
  versions?: string[];
}

export interface PackageVersionManifest {
  npm?: Record<string, EcosystemVersionEntry>;
  nuget?: Record<string, EcosystemVersionEntry>;
  pypi?: Record<string, EcosystemVersionEntry>;
  maven?: Record<string, EcosystemVersionEntry>;
  rubygems?: Record<string, EcosystemVersionEntry>;
  swift?: Record<string, EcosystemVersionEntry>;
  go?: Record<string, EcosystemVersionEntry>;
  cargo?: Record<string, EcosystemVersionEntry>;
  composer?: Record<string, EcosystemVersionEntry>;
  pub?: Record<string, EcosystemVersionEntry>;
  hex?: Record<string, EcosystemVersionEntry>;
  docker?: Record<string, EcosystemVersionEntry>;
  helm?: Record<string, EcosystemVersionEntry>;
  terraform?: Record<string, EcosystemVersionEntry>;
}

/** Why a `--package-manifest` path cannot be used. Stable for tests and exit handling. */
export type PackageManifestFailure = 'not_found' | 'unreadable' | 'unusable';

/**
 * Fail-closed error for a missing, unreadable, or unusable package-version
 * manifest. The message names the path and what to pass instead. It never
 * includes file contents, nearby files, or the environment.
 */
export class PackageManifestError extends Error {
  readonly failure: PackageManifestFailure;

  constructor(message: string, failure: PackageManifestFailure) {
    super(message);
    this.name = 'PackageManifestError';
    this.failure = failure;
  }
}

/** Top-level keys a package-version manifest may carry. `runtimes` is optional catalog data. */
const MANIFEST_KEYS = new Set([
  'runtimes',
  'npm',
  'nuget',
  'pypi',
  'maven',
  'rubygems',
  'swift',
  'go',
  'cargo',
  'composer',
  'pub',
  'hex',
  'docker',
  'helm',
  'terraform',
]);

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notFound(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest not found: ${resolved}. Pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    'not_found',
  );
}

function notReadable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not readable: ${resolved}. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    'unreadable',
  );
}

function notAFile(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not a file: ${resolved}. Pass a JSON or ZIP package-version manifest to --package-manifest.`,
    'unusable',
  );
}

function notUsable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not usable: ${resolved}. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.`,
    'unusable',
  );
}

function zipNotUsable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not usable: ${resolved}. The ZIP must contain package-versions.json, manifest.json, or index.json.`,
    'unusable',
  );
}

function ioFailure(err: unknown, resolved: string): PackageManifestError {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') return notFound(resolved);
  return notReadable(resolved);
}

function parseManifestObject(text: string, source: string): PackageVersionManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw notUsable(source);
  }
  if (!isPlainObject(value)) throw notUsable(source);

  const keys = Object.keys(value);
  const known = keys.filter((key) => MANIFEST_KEYS.has(key));
  if (keys.length > 0 && known.length === 0) throw notUsable(source);

  for (const key of known) {
    const entry = value[key];
    if (entry == null) continue;
    if (!isPlainObject(entry)) throw notUsable(source);
  }
  return value as PackageVersionManifest;
}

async function loadManifestFromZip(zipPath: string): Promise<PackageVersionManifest> {
  let members: string[];
  try {
    // Central directory first. Over-limit archives throw before any member is
    // inflated, and only the well-known manifest names are inflated at all.
    members = await readManifestZipMembers(zipPath);
  } catch (err) {
    if (err instanceof ArchiveLimitError) throw new PackageManifestError(err.message, 'unusable');
    if (err instanceof ZipManifestError) throw zipNotUsable(zipPath);
    throw err;
  }
  for (const text of members) {
    try {
      return parseManifestObject(text, zipPath);
    } catch {
      // Unusable candidate — try the next well-known name.
    }
  }
  throw zipNotUsable(zipPath);
}

async function loadResolved(resolved: string): Promise<PackageVersionManifest> {
  let info: { isFile(): boolean };
  try {
    info = await stat(resolved);
  } catch (err) {
    throw ioFailure(err, resolved);
  }
  if (!info.isFile()) throw notAFile(resolved);
  if (resolved.toLowerCase().endsWith('.zip')) return loadManifestFromZip(resolved);

  let text: string;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (err) {
    throw ioFailure(err, resolved);
  }
  return parseManifestObject(text, resolved);
}

export async function loadPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  const resolved = path.resolve(filePath);
  try {
    return await loadResolved(resolved);
  } catch (err) {
    if (err instanceof PackageManifestError) throw err;
    throw notReadable(resolved);
  }
}

export function getManifestEntry(
  manifest: PackageVersionManifest | undefined,
  ecosystem: keyof PackageVersionManifest,
  packageName: string,
): EcosystemVersionEntry | undefined {
  if (!manifest) return undefined;
  const table = manifest[ecosystem];
  if (!table) return undefined;
  if (ecosystem === 'nuget') {
    return table[packageName.toLowerCase()] ?? table[packageName];
  }
  return table[packageName];
}
