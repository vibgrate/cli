// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { spawn } from 'node:child_process';
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import type { NpmMeta } from '../types.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';
import { RegistryDiskCache, type RegistryCacheOptions } from '../utils/registry-disk-cache.js';

export { NPM_META_TTL_MS, npmMetaCacheDir, vibgrateUserCacheDir, REGISTRY_META_TTL_MS, registryMetaCacheDir } from '../utils/user-cache.js';
export type { RegistryCacheOptions as NpmCacheOptions } from '../utils/registry-disk-cache.js';

const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const USER_AGENT = 'vibgrate-cli (https://github.com/vibgrate/vibgrate-cli)';
const FETCH_TIMEOUT_MS = 10_000;

function emptyMeta(): NpmMeta {
  return { latest: null, stableVersions: [], latestStableOverall: null, license: null };
}

function stableOnly(versions: string[]): string[] {
  return versions.filter((v) => semver.valid(v) && semver.prerelease(v) === null);
}

function maxStable(versions: string[]): string | null {
  const stable = stableOnly(versions);
  if (stable.length === 0) return null;
  return stable.sort(semver.rcompare)[0] ?? null;
}

/** Extract a version → ISO-date map from an npm `time` object, dropping the
 *  non-version `created` / `modified` keys. */
function parseReleaseDates(time: unknown): Record<string, string> | undefined {
  if (!time || typeof time !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(time as Record<string, unknown>)) {
    if (key === 'created' || key === 'modified') continue;
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * npm's `license` field is usually a string, but legacy packages use an object
 * ({ type }) or an array of such objects under `licenses`. Reduce any of these
 * to a single declared string (an SPDX expression for the array form).
 */
function parseLicenseField(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(parseLicenseField).filter((s): s is string => Boolean(s));
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === 'string') return obj.type.trim() || null;
    if (typeof obj.spdx === 'string') return obj.spdx.trim() || null;
  }
  return null;
}

function metaFromManifest(pkg: string, manifest: PackageVersionManifest | undefined): NpmMeta | null {
  const manifestEntry = getManifestEntry(manifest, 'npm', pkg);
  if (!manifestEntry) return null;
  const stable = stableOnly(manifestEntry.versions ?? []);
  const latestStableOverall = maxStable(stable);
  return {
    latest: manifestEntry.latest ?? latestStableOverall,
    stableVersions: stable,
    latestStableOverall,
    license: manifestEntry.license ?? null,
    ...(manifestEntry.releaseDates ? { releaseDates: manifestEntry.releaseDates } : {}),
  };
}

/** Parse a registry packument (or the slimmer `npm view` JSON) into {@link NpmMeta}. */
export function parseNpmMetaPayload(data: unknown): NpmMeta {
  if (!data || typeof data !== 'object') return emptyMeta();
  const record = data as Record<string, unknown>;

  let latest: string | null = null;
  const dtLatest = record['dist-tags.latest'];
  if (typeof dtLatest === 'string') latest = dtLatest;
  const distTags = record['dist-tags'];
  if (!latest && distTags && typeof distTags === 'object' && typeof (distTags as Record<string, unknown>).latest === 'string') {
    latest = (distTags as Record<string, string>).latest;
  }

  let versions: string[] = [];
  const v = record.versions;
  if (Array.isArray(v)) {
    versions = v.map(String);
  } else if (v && typeof v === 'object') {
    versions = Object.keys(v);
  } else if (typeof v === 'string') {
    versions = [v];
  }

  let license = parseLicenseField(record.license ?? record.licenses);
  if (latest && v && typeof v === 'object' && !Array.isArray(v)) {
    const verDoc = (v as Record<string, unknown>)[latest];
    if (verDoc && typeof verDoc === 'object') {
      const fromVer = parseLicenseField(
        (verDoc as Record<string, unknown>).license ?? (verDoc as Record<string, unknown>).licenses,
      );
      if (fromVer) license = fromVer;
    }
  }

  const releaseDates = parseReleaseDates(record.time);
  const stable = stableOnly(versions);
  const latestStableOverall = maxStable(stable);
  if (!latest && latestStableOverall) latest = latestStableOverall;

  return { latest, stableVersions: stable, latestStableOverall, license, ...(releaseDates ? { releaseDates } : {}) };
}

async function npmViewJson(args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM_COMMAND, ['view', ...args, '--json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Scans also run from console-less hosts (vgd background rebuilds,
      // editor-spawned servers) — never flash a console window on Windows.
      windowsHide: true,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += String(d)));
    child.stderr.on('data', (d: Buffer) => (err += String(d)));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`npm view ${args.join(' ')} failed (code=${code}): ${err.trim()}`));
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve(trimmed.replace(/^"|"$/g, ''));
      }
    });
  });
}

/** Cache npm metadata lookups with concurrency control and a shared 4-hour disk cache. */
export class NpmCache {
  private meta = new Map<string, Promise<NpmMeta>>();
  private readonly disk: RegistryDiskCache<NpmMeta>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private cwd: string,
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
    options: RegistryCacheOptions = {},
  ) {
    this.disk = new RegistryDiskCache<NpmMeta>('npm', options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolve every unique package through {@link get}. Each lookup takes its
   * own semaphore slot, so `--concurrency` actually caps in-flight registry
   * HTTP (the old path held one slot around a sequential `npm view` loop).
   */
  async prefetch(pkgs: readonly string[]): Promise<void> {
    const unique = [...new Set(pkgs.filter(Boolean))];
    if (unique.length === 0) return;
    await this.disk.sweep();
    await Promise.all(unique.map((pkg) => this.get(pkg)));
  }

  get(pkg: string): Promise<NpmMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.resolve(pkg);
    this.meta.set(pkg, p);
    return p;
  }

  private async resolve(pkg: string): Promise<NpmMeta> {
    const fromManifest = metaFromManifest(pkg, this.manifest);
    if (fromManifest) return fromManifest;

    const fromDisk = await this.disk.read(pkg);
    if (fromDisk) return fromDisk;

    if (this.offline) return emptyMeta();

    const fetched = await this.sem.run(() => this.fetchRemote(pkg));
    if (fetched.persist) {
      await this.disk.write(pkg, fetched.meta);
    }
    return fetched.meta;
  }

  private async fetchRemote(pkg: string): Promise<{ meta: NpmMeta; persist: boolean }> {
    try {
      const url = `${REGISTRY_ORIGIN}/${encodeURIComponent(pkg)}`;
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      });

      if (response.status === 404) {
        return { meta: emptyMeta(), persist: true };
      }
      if (response.ok) {
        return { meta: parseNpmMetaPayload(await response.json()), persist: true };
      }
    } catch {
      // Fall through to the npm CLI — some corporate registries are only
      // reachable through `.npmrc`, not a direct registry.npmjs.org GET.
    }

    try {
      const data = await npmViewJson([pkg, 'dist-tags.latest', 'versions', 'license', 'licenses', 'time'], this.cwd);
      return { meta: parseNpmMetaPayload(data), persist: true };
    } catch {
      return { meta: emptyMeta(), persist: false };
    }
  }
}

/**
 * Quick connectivity check — pings the npm registry via HTTP HEAD.
 * Falls back to `npm view` if fetch is unavailable.
 * Returns true if the registry is reachable, false otherwise.
 */
export async function checkRegistryAccess(cwd: string): Promise<boolean> {
  try {
    // Prefer a direct HTTP check to avoid npm CLI cache-permission issues
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch('https://registry.npmjs.org/npm/latest', {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    // Fallback to npm CLI
    try {
      const result = await npmViewJson(['npm', 'dist-tags.latest'], cwd);
      return typeof result === 'string' && result.length > 0;
    } catch {
      return false;
    }
  }
}

export function isSemverSpec(spec: string): boolean {
  const s = spec.trim();
  if (!s) return false;
  if (s.startsWith('workspace:')) return false;
  if (s.startsWith('file:')) return false;
  if (s.startsWith('link:')) return false;
  if (s.startsWith('git+')) return false;
  if (s.includes('://')) return false;
  if (s.startsWith('github:')) return false;
  if (s === '*' || s.toLowerCase() === 'latest') return true;
  return semver.validRange(s) !== null;
}
