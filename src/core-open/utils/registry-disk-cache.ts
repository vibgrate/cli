// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { REGISTRY_META_TTL_MS, registryMetaCacheDir } from './user-cache.js';

const DISK_CACHE_VERSION = 1;

export const REGISTRY_USER_AGENT = 'vibgrate-cli (https://github.com/vibgrate/vibgrate-cli)';
export const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

export interface RegistryCacheOptions {
  /** Absolute dir for this ecosystem's extracts. `null` disables the disk cache. */
  cacheDir?: string | null;
  ttlMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface DiskEntry<T> {
  v: typeof DISK_CACHE_VERSION;
  fetchedAt: number;
  meta: T;
}

function resolveCacheDir(ecosystem: string, explicit: string | null | undefined): string | null {
  if (explicit === null) return null;
  if (typeof explicit === 'string') return explicit;
  // Vitest inherits the developer's machine cache unless a test opts in.
  if (process.env.VITEST) return null;
  try {
    return registryMetaCacheDir(ecosystem);
  } catch {
    return null;
  }
}

/**
 * Shared 4-hour on-disk cache for registry metadata, sitting next to vgd
 * (`~/Library/Caches/Vibgrate/registry/<ecosystem>/` on macOS).
 */
export class RegistryDiskCache<T> {
  private readonly cacheDir: string | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private swept = false;

  constructor(ecosystem: string, options: RegistryCacheOptions = {}) {
    this.cacheDir = resolveCacheDir(ecosystem, options.cacheDir);
    this.ttlMs = options.ttlMs ?? REGISTRY_META_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async read(key: string): Promise<T | null> {
    await this.sweep();
    const file = this.cacheFile(key);
    if (!file) return null;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as DiskEntry<T>;
      if (parsed.v !== DISK_CACHE_VERSION || typeof parsed.fetchedAt !== 'number' || parsed.meta === undefined) {
        return null;
      }
      if (this.now() - parsed.fetchedAt > this.ttlMs) {
        await fs.unlink(file).catch(() => undefined);
        return null;
      }
      return parsed.meta;
    } catch {
      return null;
    }
  }

  async write(key: string, meta: T): Promise<void> {
    const file = this.cacheFile(key);
    if (!file || !this.cacheDir) return;
    const entry: DiskEntry<T> = { v: DISK_CACHE_VERSION, fetchedAt: this.now(), meta };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(entry));
      await fs.rename(tmp, file);
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  async sweep(): Promise<void> {
    if (this.swept || !this.cacheDir) return;
    this.swept = true;
    let names: string[];
    try {
      names = await fs.readdir(this.cacheDir);
    } catch {
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    await Promise.all(names.map(async (name) => {
      if (!name.endsWith('.json')) return;
      const file = path.join(this.cacheDir!, name);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        // ignore
      }
    }));
  }

  private cacheFile(key: string): string | null {
    if (!this.cacheDir) return null;
    return path.join(this.cacheDir, `${encodeURIComponent(key)}.json`);
  }
}
