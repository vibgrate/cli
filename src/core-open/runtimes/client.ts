// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as os from 'node:os';
import * as path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import type { RuntimeCatalog, ResolvedRuntimeCatalog, RuntimeCatalogSource } from './types.js';
import { BUNDLED_RUNTIME_CATALOG } from './snapshot.js';

/**
 * Resolves the {@link RuntimeCatalog} for a scan, mirroring how dependency
 * versions are resolved (live with offline fallback). Resolution order:
 *
 *   fresh local cache → `/v1/reference/runtimes` (Vibgrate API) →
 *   user manifest `runtimes` → bundled snapshot
 *
 * The CLI never hits endoflife.date directly — the API owns the vendor fetch and
 * D1 cache; the CLI consumes the catalog it serves and caches it locally. Every
 * step is best-effort and never throws; the bundled snapshot is the guaranteed
 * floor. The resolved `source` is surfaced as a confidence signal.
 */

const DEFAULT_API_BASE = 'https://api.vibgrate.com';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const FETCH_TIMEOUT_MS = 5_000;

export interface RuntimeCatalogClientOptions {
  /** Base URL of the Vibgrate API (default `https://api.vibgrate.com`, or `VIBGRATE_API_BASE`). */
  apiBase?: string;
  /** Skip the network entirely; use manifest/bundled only. */
  offline?: boolean;
  /** Offline manifest that may carry a `runtimes` catalog (`--package-manifest`). */
  manifest?: PackageVersionManifest;
  /** Override the on-disk cache directory (testing). */
  cacheDir?: string;
  /** Override the fetch implementation (testing). */
  fetchImpl?: typeof fetch;
}

interface CacheEnvelope {
  fetchedAt: string;
  catalog: RuntimeCatalog;
}

function isRuntimeCatalog(value: unknown): value is RuntimeCatalog {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as RuntimeCatalog).generatedAt === 'string' &&
    typeof (value as RuntimeCatalog).products === 'object' &&
    (value as RuntimeCatalog).products !== null
  );
}

export class RuntimeCatalogClient {
  private readonly apiBase: string;
  private readonly offline: boolean;
  private readonly manifest?: PackageVersionManifest;
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private resolution: Promise<ResolvedRuntimeCatalog> | null = null;

  constructor(opts: RuntimeCatalogClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env.VIBGRATE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.offline = opts.offline ?? false;
    this.manifest = opts.manifest;
    this.cacheDir = opts.cacheDir ?? path.join(os.homedir(), '.vibgrate', 'cache');
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  /** Resolve the catalog once; concurrent/repeat calls share the result. */
  resolve(): Promise<ResolvedRuntimeCatalog> {
    if (!this.resolution) this.resolution = this.doResolve();
    return this.resolution;
  }

  private get cacheFile(): string {
    return path.join(this.cacheDir, 'runtimes.json');
  }

  private async doResolve(): Promise<ResolvedRuntimeCatalog> {
    let staleCache: RuntimeCatalog | undefined;

    if (!this.offline) {
      const envelope = await this.readCache();
      if (envelope) {
        const fresh = Date.now() - Date.parse(envelope.fetchedAt) < CACHE_TTL_MS;
        if (fresh) return { catalog: envelope.catalog, source: 'cache' };
        staleCache = envelope.catalog;
      }

      const fetched = await this.fetchFromApi();
      if (fetched) {
        await this.writeCache(fetched);
        return { catalog: fetched, source: 'api' };
      }
    }

    const manifestCatalog = this.manifest?.runtimes;
    if (isRuntimeCatalog(manifestCatalog)) {
      return { catalog: manifestCatalog, source: 'manifest' };
    }

    // Prefer a stale cache over the bundled floor when it is genuinely newer.
    if (staleCache && Date.parse(staleCache.generatedAt) > Date.parse(BUNDLED_RUNTIME_CATALOG.generatedAt)) {
      return { catalog: staleCache, source: 'cache' };
    }

    return { catalog: BUNDLED_RUNTIME_CATALOG, source: 'bundled' };
  }

  private async fetchFromApi(): Promise<RuntimeCatalog | null> {
    if (!this.fetchImpl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/v1/reference/runtimes`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      return isRuntimeCatalog(data) ? data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCache(): Promise<CacheEnvelope | null> {
    try {
      const text = await readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(text) as CacheEnvelope;
      if (parsed && typeof parsed.fetchedAt === 'string' && isRuntimeCatalog(parsed.catalog)) {
        return parsed;
      }
    } catch {
      // no/invalid cache — ignore
    }
    return null;
  }

  private async writeCache(catalog: RuntimeCatalog): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const envelope: CacheEnvelope = { fetchedAt: new Date().toISOString(), catalog };
      await writeFile(this.cacheFile, JSON.stringify(envelope), 'utf8');
    } catch {
      // best-effort cache write
    }
  }
}

export type { RuntimeCatalogSource };
