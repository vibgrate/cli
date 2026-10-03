import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

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

/**
 * Ecosystem tables a package-version manifest may carry. Kept in lockstep with
 * {@link PackageVersionManifest} so a new ecosystem is accepted here too.
 */
const ECOSYSTEM_TABLE = {
  npm: true,
  nuget: true,
  pypi: true,
  maven: true,
  rubygems: true,
  swift: true,
  go: true,
  cargo: true,
  composer: true,
  pub: true,
  hex: true,
  docker: true,
  helm: true,
  terraform: true,
} as const satisfies Record<keyof PackageVersionManifest, true>;

const ECOSYSTEM_KEYS = Object.keys(ECOSYSTEM_TABLE).sort() as (keyof PackageVersionManifest)[];

const PASS_INSTEAD = 'Pass a JSON or ZIP package-version manifest to --package-manifest.';

/** Names of the package-version manifest entry inside a ZIP bundle, in lookup order. */
const ZIP_ENTRY_NAMES = ['package-versions.json', 'manifest.json', 'index.json'] as const;

/**
 * A bad `--package-manifest` path. `message` names that path and what to pass
 * instead. It never includes file contents, directory listings, unzip output,
 * or the environment.
 */
export class PackageVersionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageVersionManifestError';
  }
}

function quotePath(filePath: string): string {
  return JSON.stringify(filePath);
}

function manifestError(filePath: string, why: 'does not exist' | 'is not readable' | 'is not a package-version manifest'): PackageVersionManifestError {
  return new PackageVersionManifestError(`--package-manifest ${quotePath(filePath)} ${why}. ${PASS_INSTEAD}`);
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function throwForAccess(filePath: string, err: unknown): never {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') throw manifestError(filePath, 'does not exist');
  if (code === 'EACCES' || code === 'EPERM') throw manifestError(filePath, 'is not readable');
  throw manifestError(filePath, 'is not a package-version manifest');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsablePackageVersionManifest(value: unknown): value is PackageVersionManifest {
  if (!isPlainObject(value)) return false;
  let recognized = false;
  if (Object.prototype.hasOwnProperty.call(value, 'runtimes')) {
    if (!isPlainObject(value.runtimes)) return false;
    recognized = true;
  }
  for (const key of ECOSYSTEM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const table = value[key];
    if (!isPlainObject(table)) return false;
    for (const entry of Object.values(table)) {
      if (!isPlainObject(entry)) return false;
    }
    recognized = true;
  }
  return recognized;
}

function parseUsableManifest(text: string): PackageVersionManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isUsablePackageVersionManifest(value) ? value : undefined;
}

/** Unzip without retaining stdout or stderr, so a failure cannot echo them. */
function unzipQuiet(zipPath: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('unzip', ['-qq', zipPath, '-d', dest], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function loadManifestFromZip(displayPath: string, zipPath: string): Promise<PackageVersionManifest> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibgrate-manifest-'));
  try {
    const extracted = await unzipQuiet(zipPath, tmpDir);
    if (!extracted) throw manifestError(displayPath, 'is not a package-version manifest');
    for (const name of ZIP_ENTRY_NAMES) {
      let text: string;
      try {
        text = await readFile(path.join(tmpDir, name), 'utf8');
      } catch {
        continue;
      }
      const manifest = parseUsableManifest(text);
      if (manifest) return manifest;
    }
    throw manifestError(displayPath, 'is not a package-version manifest');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function readPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  const resolved = path.resolve(filePath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch (err) {
    throwForAccess(filePath, err);
  }
  if (!info.isFile()) throw manifestError(filePath, 'is not a package-version manifest');
  try {
    await access(resolved, constants.R_OK);
  } catch (err) {
    throwForAccess(filePath, err);
  }
  if (resolved.toLowerCase().endsWith('.zip')) {
    return loadManifestFromZip(filePath, resolved);
  }
  let text: string;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (err) {
    throwForAccess(filePath, err);
  }
  const manifest = parseUsableManifest(text);
  if (!manifest) throw manifestError(filePath, 'is not a package-version manifest');
  return manifest;
}

export async function loadPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  try {
    return await readPackageVersionManifest(filePath);
  } catch (err) {
    if (err instanceof PackageVersionManifestError) throw err;
    throw manifestError(filePath, 'is not a package-version manifest');
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
