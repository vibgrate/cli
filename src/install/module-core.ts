/**
 * Generic installer for optional local modules (relevance, hcs, arch, …).
 *
 * A module is a separately licensed, separately distributed local package that
 * the CLI loads through a provider seam. This core manages the shared
 * lifecycle without touching the user's project: it installs into the
 * vibgrate modules cache dir via a direct registry tarball fetch with an
 * integrity check — never a mutation of the *project's* `package.json`, never
 * a postinstall script execution (the tarball is unpacked, nothing in it is
 * run at install time). The cache dir itself does get a tiny
 * `{ "type": "module" }` package.json so Node does not treat the unpacked
 * `index.js` as typeless and walk up to an ancestor (often `~/package.json`).
 * Per-module policy (consent posture, auto-provisioning, error loudness)
 * lives with each module's own wrapper (relevance-module.ts, hcs-module.ts,
 * haile-module.ts) — this file is mechanism only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Everything the generic installer needs to know about one module. */
export interface ModuleDescriptor {
  /** Short id — the consent key and the cache dir name (e.g. "relevance"). */
  id: string;
  /** npm package name fetched from the registry. */
  npmName: string;
  /** Absolute install dir for this module. */
  dir(): string;
  /** Invalidate any memoized loader after install/remove. */
  onChanged?(): void;
}

export interface InstallResult {
  status: 'installed' | 'already-installed' | 'disabled' | 'declined' | 'unavailable';
  version?: string;
  detail?: string;
}

export interface InstallOptions {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Registry base URL; VIBGRATE_MODULE_REGISTRY overrides, then this. */
  registry?: string;
  /** Reinstall even when already present. */
  force?: boolean;
}

function registryBase(opts: InstallOptions): string {
  return (process.env.VIBGRATE_MODULE_REGISTRY || opts.registry || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/**
 * Base dir all modules install under.
 * `VIBGRATE_MODULE_DIR` overrides the whole tree; otherwise
 * `$XDG_CACHE_HOME|~/.cache/vibgrate/modules`.
 */
export function modulesBaseDir(): string {
  const override = process.env.VIBGRATE_MODULE_DIR?.trim();
  if (override) return path.resolve(override);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'modules');
}

function stateFile(): string {
  return path.join(modulesBaseDir(), 'consent.json');
}

/** Per-module consent, keyed by module id, shared in one state file. */
export type ConsentState = Partial<Record<string, 'granted' | 'denied'>>;

export function readConsent(): ConsentState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as ConsentState;
  } catch {
    return {};
  }
}

export function writeConsent(state: ConsentState): void {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    /* consent persistence is best-effort */
  }
}

/** The one kill switch for every optional module. */
export function kernelDisabled(): boolean {
  const v = process.env.VIBGRATE_NO_KERNEL;
  return v === '1' || v === 'true';
}

export function moduleInstalledAt(dir: string): { installed: boolean; version?: string } {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.module.json'), 'utf8')) as {
      version?: string;
    };
    if (fs.existsSync(path.join(dir, 'index.js'))) {
      // Existing installs (pre-ESM-marker) get healed on the next status
      // check — every `vg` already calls this via kickRelevanceReadiness —
      // so a Node warning does not wait for the next module reinstall.
      ensureModuleEsmPackageJson(dir);
      return { installed: true, version: meta.version };
    }
  } catch {
    /* not installed */
  }
  return { installed: false };
}

/**
 * Write a tiny `{ "type": "module" }` package.json next to a managed module's
 * `index.js`. The unpack maps `package/dist/*` onto the module root and
 * deliberately does not copy the published package.json (`main` would still
 * say `./dist/index.js`). Without a local type marker, Node 22 walks up to
 * the nearest ancestor package.json — commonly `~/package.json` — and emits
 * `MODULE_TYPELESS_PACKAGE_JSON` on every `import()` of the ESM `index.js`.
 *
 * Only writes into a directory that already has `.module.json` (the cache
 * layout we own). A custom `VIBGRATE_*_PATH` stub is left alone. Never
 * touches the user's project package.json.
 */
export function ensureModuleEsmPackageJson(moduleDir: string): void {
  try {
    const markerPath = path.join(moduleDir, '.module.json');
    const indexPath = path.join(moduleDir, 'index.js');
    if (!fs.existsSync(markerPath) || !fs.existsSync(indexPath)) return;
    const pkgPath = path.join(moduleDir, 'package.json');
    try {
      const existing = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { type?: unknown };
      if (existing && existing.type === 'module') return;
    } catch {
      /* missing or unreadable — write */
    }
    let name: string | undefined;
    let version: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof meta.name === 'string') name = meta.name;
      if (typeof meta.version === 'string') version = meta.version;
    } catch {
      /* still write the type marker */
    }
    const body: Record<string, unknown> = { private: true, type: 'module' };
    if (name) body.name = name;
    if (version) body.version = version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(body)}\n`);
  } catch {
    /* best-effort: a missing marker is a Node warning, not a failed command */
  }
}

/**
 * Verify a registry integrity string ("sha512-<b64>" / "sha1-<b64>") or a hex
 * shasum against the tarball bytes. Throws on mismatch; missing metadata is a
 * hard failure too — we never unpack unverified bytes.
 */
export function verifyIntegrity(buf: Buffer, integrity?: string, shasum?: string): void {
  if (integrity) {
    const [algo, expected] = integrity.split('-', 2);
    if (!algo || !expected) throw new Error('malformed integrity metadata');
    const actual = createHash(algo).update(buf).digest('base64');
    if (actual !== expected) throw new Error(`integrity mismatch (${algo})`);
    return;
  }
  if (shasum) {
    const actual = createHash('sha1').update(buf).digest('hex');
    if (actual !== shasum) throw new Error('integrity mismatch (shasum)');
    return;
  }
  throw new Error('registry provided no integrity metadata');
}

/**
 * Minimal ustar reader — enough for npm-pack tarballs (ustar + pax extended
 * headers + GNU longname). Returns file entries only. No symlinks, no device
 * nodes, and every emitted path is validated against traversal.
 */
export function untar(data: Buffer): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  let offset = 0;
  let pendingName: string | null = null;
  while (offset + 512 <= data.length) {
    const block = data.subarray(offset, offset + 512);
    offset += 512;
    if (block.every((b) => b === 0)) continue; // end-of-archive padding
    const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(block.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(block[156]!);
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const body = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      pendingName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (m) pendingName = m[1]!;
      continue;
    }
    if (type !== '0' && type !== '\0') continue; // files only
    const name = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingName = null;
    if (name.split('/').includes('..') || path.isAbsolute(name)) {
      throw new Error(`unsafe path in tarball: ${name}`);
    }
    out.push({ name, body: Buffer.from(body) });
  }
  return out;
}

/**
 * The registry's `dist-tags.latest` for a module package, or null when the
 * registry is unreachable or the package has no published version. Read-only:
 * fetches metadata only, never a tarball.
 */
export async function latestModuleVersion(npmName: string, opts: InstallOptions = {}): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${registryBase(opts)}/${npmName.replace('/', '%2f')}`);
    if (!res.ok) return null;
    const meta = (await res.json()) as { 'dist-tags'?: Record<string, string> };
    return meta['dist-tags']?.latest ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch, verify, and unpack a module into its cache dir. The loadable surface
 * is the tarball's `package/dist/*` mapped to the module root (so
 * `<dir>/index.js` is the seam's entrypoint), plus LICENSE/README. A tiny
 * `{ "type": "module" }` package.json is written next to `index.js` so Node
 * treats the entry as ESM without walking up to an ancestor package.json.
 */
export async function installModule(mod: ModuleDescriptor, opts: InstallOptions = {}): Promise<InstallResult> {
  if (kernelDisabled()) return { status: 'disabled', detail: 'VIBGRATE_NO_KERNEL is set' };
  const existing = moduleInstalledAt(mod.dir());
  if (existing.installed && !opts.force) return { status: 'already-installed', version: existing.version };

  const doFetch = opts.fetchImpl ?? fetch;
  const base = registryBase(opts);
  try {
    const metaRes = await doFetch(`${base}/${mod.npmName.replace('/', '%2f')}`);
    if (!metaRes.ok) return { status: 'unavailable', detail: `registry ${metaRes.status}` };
    const meta = (await metaRes.json()) as {
      'dist-tags'?: Record<string, string>;
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
    };
    const version = meta['dist-tags']?.latest;
    const dist = version ? meta.versions?.[version]?.dist : undefined;
    if (!version || !dist?.tarball) return { status: 'unavailable', detail: 'no published version' };

    const tarRes = await doFetch(dist.tarball);
    if (!tarRes.ok) return { status: 'unavailable', detail: `tarball ${tarRes.status}` };
    const gz = Buffer.from(await tarRes.arrayBuffer());
    verifyIntegrity(gz, dist.integrity, dist.shasum);

    const entries = untar(zlib.gunzipSync(gz));
    const dir = mod.dir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let wrote = 0;
    for (const e of entries) {
      let rel: string | null = null;
      if (e.name.startsWith('package/dist/')) rel = e.name.slice('package/dist/'.length);
      else if (e.name === 'package/LICENSE' || e.name === 'package/README.md') rel = e.name.slice('package/'.length);
      if (!rel) continue;
      const target = path.join(dir, rel);
      if (!target.startsWith(dir + path.sep) && target !== dir) throw new Error(`unsafe extract path: ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.body);
      wrote += 1;
    }
    if (!wrote || !fs.existsSync(path.join(dir, 'index.js'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { status: 'unavailable', detail: 'package layout not recognized (no dist/index.js)' };
    }
    fs.writeFileSync(path.join(dir, '.module.json'), JSON.stringify({ name: mod.npmName, version }));
    ensureModuleEsmPackageJson(dir);
    mod.onChanged?.();
    return { status: 'installed', version };
  } catch (e) {
    return { status: 'unavailable', detail: String((e as Error).message ?? e).slice(0, 200) };
  }
}

export function removeModule(mod: ModuleDescriptor): void {
  fs.rmSync(mod.dir(), { recursive: true, force: true });
  mod.onChanged?.();
}
