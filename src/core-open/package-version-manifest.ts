// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import type { RuntimeCatalog } from './runtimes/types.js';

export interface EcosystemVersionEntry {
  latest?: string;
  versions?: string[];
  /** Declared license (SPDX id/expression) for the package, when known. */
  license?: string;
  /**
   * Optional map of version → ISO-8601 publish date. When present, enables
   * libyear-based dependency-freshness scoring fully offline (no registry or
   * Vibgrate server-side call). Producers of offline manifests should populate
   * this from `npm view <pkg> time` (or the equivalent per ecosystem).
   */
  releaseDates?: Record<string, string>;
}

export interface PackageVersionManifest {
  /**
   * Optional Runtime Catalog (Node/Python/Java/.NET/Go/Ruby latest, LTS, and EOL
   * dates). Lets `--package-manifest`/`--offline` users supply or refresh runtime
   * currency data the same way they supply package data.
   */
  runtimes?: RuntimeCatalog;
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

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += String(d)));
    child.stderr.on('data', (d: Buffer) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} failed (code=${code}): ${err.trim()}`));
        return;
      }
      resolve(out);
    });
  });
}

async function parseManifestText(text: string, source: string): Promise<PackageVersionManifest> {
  try {
    return JSON.parse(text) as PackageVersionManifest;
  } catch {
    throw new Error(`Invalid JSON in package version manifest: ${source}`);
  }
}

async function loadManifestFromZip(zipPath: string): Promise<PackageVersionManifest> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibgrate-manifest-'));
  try {
    await runCommand('unzip', ['-qq', zipPath, '-d', tmpDir]);
    const candidates = [
      path.join(tmpDir, 'package-versions.json'),
      path.join(tmpDir, 'manifest.json'),
      path.join(tmpDir, 'index.json'),
    ];

    for (const candidate of candidates) {
      try {
        const text = await readFile(candidate, 'utf8');
        return await parseManifestText(text, candidate);
      } catch {
        // keep searching
      }
    }

    throw new Error('Zip must contain package-versions.json, manifest.json, or index.json');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function loadPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  const resolved = path.resolve(filePath);
  if (resolved.toLowerCase().endsWith('.zip')) {
    return loadManifestFromZip(resolved);
  }
  const text = await readFile(resolved, 'utf8');
  return parseManifestText(text, resolved);
}

/** Package ecosystems in the manifest (everything except the runtime catalog). */
export type ManifestEcosystem = Exclude<keyof PackageVersionManifest, 'runtimes'>;

export function getManifestEntry(
  manifest: PackageVersionManifest | undefined,
  ecosystem: ManifestEcosystem,
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
