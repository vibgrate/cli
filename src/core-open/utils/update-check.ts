// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import semver from 'semver';
import { VERSION } from '../version.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@vibgrate%2fcli/latest';
const CACHE_DIR = path.join(os.homedir(), '.vibgrate');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface CachedCheck {
  latest: string;
  checkedAt: number;
}

/**
 * Check the npm registry for a newer version.
 * Results are cached for 24 hours to avoid unnecessary network requests.
 * Never throws — returns null on any failure.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    // Try cache first
    const cached = await readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      return {
        current: VERSION,
        latest: cached.latest,
        updateAvailable: semver.gt(cached.latest, VERSION),
      };
    }

    // Fetch from registry with a short timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    timeout.unref?.();

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return null;

    const data = (await response.json()) as { version?: string };
    const latest = data.version;
    if (!latest || !semver.valid(latest)) return null;

    // Update cache
    await writeCache({ latest, checkedAt: Date.now() });

    return {
      current: VERSION,
      latest,
      updateAvailable: semver.gt(latest, VERSION),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the latest version from the npm registry (no cache).
 * Returns the version string or null on failure.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    timeout.unref?.();

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return null;

    const data = (await response.json()) as { version?: string };
    const latest = data.version;
    if (!latest || !semver.valid(latest)) return null;

    // Update cache
    await writeCache({ latest, checkedAt: Date.now() });

    return latest;
  } catch {
    return null;
  }
}

async function readCache(): Promise<CachedCheck | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw) as CachedCheck;
    if (data.latest && typeof data.checkedAt === 'number') return data;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(data: CachedCheck): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // Non-critical — silently ignore cache write failures
  }
}
