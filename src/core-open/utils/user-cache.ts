// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as os from 'node:os';
import * as path from 'node:path';

const APP = 'vibgrate';
const APP_MAC = 'Vibgrate';
const APP_WIN = 'Vibgrate';

/** Registry metadata is reusable for this long, then refetched. */
export const REGISTRY_META_TTL_MS = 4 * 60 * 60 * 1000;
/** @deprecated Use {@link REGISTRY_META_TTL_MS}. */
export const NPM_META_TTL_MS = REGISTRY_META_TTL_MS;

/**
 * Global user cache root — the same directory vgd uses for models, graphs,
 * and other machine-local state. Not inside the scanned repo, so it is
 * shared across branches and checkouts.
 *
 *   macOS:   ~/Library/Caches/Vibgrate
 *   Windows: %LOCALAPPDATA%\Vibgrate\Cache
 *   Linux:   $XDG_CACHE_HOME/vibgrate  (or ~/.cache/vibgrate)
 *
 * Override with VIBGRATE_CACHE_DIR. Pure path construction — no mkdir.
 */
export function vibgrateUserCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const override = env.VIBGRATE_CACHE_DIR?.trim();
  if (override) return path.resolve(override);

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', APP_MAC);
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(base, APP_WIN, 'Cache');
  }
  const xdg = env.XDG_CACHE_HOME?.trim() || path.join(home, '.cache');
  return path.join(xdg, APP);
}

/**
 * On-disk registry extracts for one ecosystem (`npm`, `pypi`, `nuget`, …).
 * Shared across repos; expired after {@link REGISTRY_META_TTL_MS}.
 */
export function registryMetaCacheDir(
  ecosystem: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): string {
  const safe = ecosystem.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'misc';
  return path.join(vibgrateUserCacheDir(env, platform, home), 'registry', safe);
}

/** @deprecated Use {@link registryMetaCacheDir} with `'npm'`. */
export function npmMetaCacheDir(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): string {
  return registryMetaCacheDir('npm', env, platform, home);
}
