// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { spawn } from 'node:child_process';
import * as semver from 'semver';
import { Semaphore } from '../utils/semaphore.js';
import type { NpmMeta } from '../types.js';
import { getManifestEntry, type PackageVersionManifest } from '../package-version-manifest.js';

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

function parseNpmMetaPayload(data: unknown): NpmMeta {
  let latest: string | null = null;
  let versions: string[] = [];
  let license: string | null = null;
  let releaseDates: Record<string, string> | undefined;

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const dtLatest = record['dist-tags.latest'];
    if (typeof dtLatest === 'string') latest = dtLatest;

    const distTags = record['dist-tags'];
    if (!latest && distTags && typeof distTags === 'object' && typeof (distTags as Record<string, unknown>).latest === 'string') {
      latest = (distTags as Record<string, string>).latest;
    }

    const v = record.versions;
    if (Array.isArray(v)) versions = v.map(String);
    else if (typeof v === 'string') versions = [v];

    license = parseLicenseField(record.license ?? record.licenses);
    releaseDates = parseReleaseDates(record.time);
  }

  const stable = stableOnly(versions);
  const latestStableOverall = maxStable(stable);
  if (!latest && latestStableOverall) latest = latestStableOverall;

  return { latest, stableVersions: stable, latestStableOverall, license, ...(releaseDates ? { releaseDates } : {}) };
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



const BATCH_SIZE = 24;
const WINDOWS_MAX_COMMAND_CHARS = 7_000;
const POSIX_MAX_COMMAND_CHARS = 30_000;
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function buildNpmViewChunks(pkgs: readonly string[], platform: NodeJS.Platform = process.platform): string[][] {
  const maxCommandChars = platform === 'win32' ? WINDOWS_MAX_COMMAND_CHARS : POSIX_MAX_COMMAND_CHARS;
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const pkg of pkgs) {
    const pkgChars = pkg.length + 1; // plus a spacer
    if (current.length >= BATCH_SIZE || (current.length > 0 && currentChars + pkgChars > maxCommandChars)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(pkg);
    currentChars += pkgChars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function npmViewJson(args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM_COMMAND, ['view', ...args, '--json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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

/** Cache npm metadata lookups with concurrency control */
export class NpmCache {
  private meta = new Map<string, Promise<NpmMeta>>();

  constructor(
    private cwd: string,
    private sem: Semaphore,
    private manifest?: PackageVersionManifest,
    private offline = false,
  ) {}

  async prefetch(pkgs: readonly string[]): Promise<void> {
    const unique = [...new Set(pkgs.filter(Boolean))];
    const pending = unique.filter((pkg) => !this.meta.has(pkg));
    if (pending.length === 0) return;

    const batchPromise = this.sem.run(() => this.fetchBatch(pending));

    for (const pkg of pending) {
      const promise = batchPromise.then((batch) => batch.get(pkg) ?? { latest: null, stableVersions: [], latestStableOverall: null, license: null });
      this.meta.set(pkg, promise);
    }

    await batchPromise;
  }

  get(pkg: string): Promise<NpmMeta> {
    const existing = this.meta.get(pkg);
    if (existing) return existing;

    const p = this.sem.run(() => this.fetchOne(pkg));
    this.meta.set(pkg, p);
    return p;
  }

  private async fetchBatch(pkgs: readonly string[]): Promise<Map<string, NpmMeta>> {
    const out = new Map<string, NpmMeta>();
    const remote: string[] = [];

    for (const pkg of pkgs) {
      const manifestEntry = getManifestEntry(this.manifest, 'npm', pkg);
      if (manifestEntry) {
        const stable = stableOnly(manifestEntry.versions ?? []);
        const latestStableOverall = maxStable(stable);
        out.set(pkg, {
          latest: manifestEntry.latest ?? latestStableOverall,
          stableVersions: stable,
          latestStableOverall,
          license: manifestEntry.license ?? null,
          ...(manifestEntry.releaseDates ? { releaseDates: manifestEntry.releaseDates } : {}),
        });
      } else if (this.offline) {
        out.set(pkg, { latest: null, stableVersions: [], latestStableOverall: null, license: null });
      } else {
        remote.push(pkg);
      }
    }

    if (remote.length === 0) return out;

    for (const chunk of buildNpmViewChunks(remote)) {
      const chunkResults = await this.fetchRemoteChunk(chunk);
      for (const [pkg, meta] of chunkResults) {
        out.set(pkg, meta);
      }
    }

    return out;
  }

  private async fetchRemoteChunk(pkgs: readonly string[]): Promise<Map<string, NpmMeta>> {
    const out = new Map<string, NpmMeta>();

    if (pkgs.length === 1) {
      out.set(pkgs[0]!, await this.fetchOneRemote(pkgs[0]!));
      return out;
    }

    try {
      const data = await npmViewJson([...pkgs, 'dist-tags.latest', 'versions', 'license', 'licenses', 'time'], this.cwd);

      if (Array.isArray(data)) {
        for (let i = 0; i < data.length && i < pkgs.length; i++) {
          out.set(pkgs[i]!, parseNpmMetaPayload(data[i]));
        }
      } else if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        let keyedByPkg = 0;
        for (const pkg of pkgs) {
          if (pkg in record) {
            out.set(pkg, parseNpmMetaPayload(record[pkg]));
            keyedByPkg++;
          }
        }

        if (keyedByPkg === 0 && pkgs.length === 1) {
          out.set(pkgs[0]!, parseNpmMetaPayload(record));
        }
      }
    } catch {
      // Fall through to one-by-one fetch below.
    }

    for (const pkg of pkgs) {
      if (!out.has(pkg)) {
        out.set(pkg, await this.fetchOneRemote(pkg));
      }
    }

    return out;
  }

  private async fetchOne(pkg: string): Promise<NpmMeta> {
    const manifestEntry = getManifestEntry(this.manifest, 'npm', pkg);
    if (manifestEntry) {
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

    if (this.offline) {
      return { latest: null, stableVersions: [], latestStableOverall: null, license: null };
    }

    return this.fetchOneRemote(pkg);
  }

  private async fetchOneRemote(pkg: string): Promise<NpmMeta> {
    try {
      const data = await npmViewJson([pkg, 'dist-tags.latest', 'versions', 'license', 'licenses', 'time'], this.cwd);
      return parseNpmMetaPayload(data);
    } catch {
      // package may be private or unavailable — fall back to separate calls
      let latest: string | null = null;
      let versions: string[] = [];

      try {
        const dist = (await npmViewJson([pkg, 'dist-tags'], this.cwd)) as Record<string, string> | null;
        if (dist && typeof dist === 'object' && typeof dist.latest === 'string') {
          latest = dist.latest;
        }
      } catch { /* private / unavailable */ }

      try {
        const v = await npmViewJson([pkg, 'versions'], this.cwd);
        if (Array.isArray(v)) versions = v.map(String);
        else if (typeof v === 'string') versions = [v];
      } catch { /* ignore */ }

      const stable = stableOnly(versions);
      const latestStableOverall = maxStable(stable);
      if (!latest && latestStableOverall) latest = latestStableOverall;
      return { latest, stableVersions: stable, latestStableOverall, license: null };
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
