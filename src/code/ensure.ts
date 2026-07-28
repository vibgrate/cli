/**
 * Lazy, consent-gated runtime dependency install (VG-CLI-CODE §6).
 *
 * The code capability must stay lean by default: we ship **no** model weights
 * and **no** heavyweight inference runtime in the published package, and we do
 * not pull anything until the `code`/`models` commands are actually used for the
 * first time — and even then only with explicit consent. This mirrors the
 * existing optional-embedder pattern (a host-side install into its own storage
 * on consent), generalized so any provider backend that needs an out-of-tree
 * package can request it.
 *
 * Guarantees:
 *  - `--local`/offline never installs (air-gapped stays air-gapped).
 *  - Non-interactive runs never install silently — they require `--yes`.
 *  - Nothing is written into the published package tree; installs live under a
 *    per-user runtime cache and load via `createRequire` from there.
 *  - The installer is injectable, so tests exercise every branch without ever
 *    shelling out to npm.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { whichOnPath } from '../util/cli-invocation.js';

/** Why a package could not be made available — for calm, actionable messaging. */
export type EnsureFailure = 'offline' | 'no-consent' | 'install-failed' | 'load-failed';

export interface EnsureOptions {
  /** `--local`: never touch the network, never install. */
  local?: boolean;
  /** `--yes`/`--install`: consent to install without an interactive prompt. */
  consent?: boolean;
  /** Whether the caller is attached to an interactive TTY (defaults to a real check). */
  interactive?: boolean;
  /** Injectable installer — defaults to `npm install --prefix <dir> <spec>`. Returns true on success. */
  install?: (spec: string, dir: string) => boolean;
  /** Called (not thrown) with the reason when the package can't be provided. */
  onUnavailable?: (reason: EnsureFailure, spec: string) => void;
}

export interface EnsureResult {
  /** The loaded module, or null when unavailable. */
  module: unknown | null;
  /** The runtime dir the package was resolved from (for diagnostics). */
  dir: string;
  reason?: EnsureFailure;
  /**
   * Optional one-line cause when `reason` is install-failed (EACCES, npm
   * missing, npm stderr tail). Prefer {@link ensureUnavailableMessage} so
   * callers always get the full actionable line.
   */
  detail?: string;
}

/**
 * The per-user runtime cache for on-demand packages. XDG-standard, shared across
 * repos (like the model cache), never inside the published package.
 * `$XDG_CACHE_HOME/vibgrate/runtime` (or `~/.cache/vibgrate/runtime`).
 */
export function runtimeCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'runtime');
}

/** Whether `spec`'s package is already resolvable from the runtime cache. */
export function isPackageInstalled(spec: string): boolean {
  const name = packageName(spec);
  try {
    const req = createRequire(path.join(runtimeCacheDir(), 'package.json'));
    req.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * A one-line, actionable explanation of why a runtime dependency isn't available
 * — always names the off switch and the fix, never alarms (GUARDRAILS §1.3).
 */
export function ensureUnavailableMessage(reason: EnsureFailure, spec: string, detail?: string): string {
  const name = packageName(spec);
  switch (reason) {
    case 'offline':
      return `${name} is needed for this backend but --local/offline is set — using a backend that needs no install, or drop --local to allow a one-time install.`;
    case 'no-consent':
      return `${name} is needed for this backend and isn't installed yet. Run \`vg models install\` (or \`vg models pull\`) to install runtime deps for the provider into ${runtimeCacheDir()} (nothing is written into the CLI itself), or pick a backend that needs no install (e.g. --provider ollama).`;
    case 'install-failed':
      if (detail?.trim()) {
        return `couldn't install ${name}: ${detail.trim()}`;
      }
      return `couldn't install ${name} (offline, or npm unavailable) — using a backend that needs no install. It will try again next time.`;
    case 'load-failed':
    default:
      return `${name} installed but couldn't be loaded here — using a backend that needs no install.`;
  }
}

/**
 * Ensure `spec` (e.g. `node-llama-cpp@^3`) is available, installing it once into
 * the runtime cache with consent if needed, then load and return it. Returns
 * `{ module: null, reason }` on any refusal/failure — the caller degrades to a
 * backend that needs no install; it never throws for an unavailable optional
 * package.
 */
export async function ensurePackage(spec: string, options: EnsureOptions = {}): Promise<EnsureResult> {
  const dir = runtimeCacheDir();
  const fail = (reason: EnsureFailure, detail?: string): EnsureResult => {
    options.onUnavailable?.(reason, spec);
    return { module: null, dir, reason, detail };
  };

  // Already present → just load it (no network, no consent needed).
  if (isPackageInstalled(spec)) {
    const mod = await load(spec, dir);
    return mod ? { module: mod, dir } : fail('load-failed');
  }

  // Not present. `--local`/offline forbids install outright.
  if (options.local) return fail('offline');

  // Non-interactive without consent must not install silently.
  const interactive = options.interactive ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!options.consent && !interactive) return fail('no-consent');
  if (!options.consent && interactive) return fail('no-consent'); // caller prompts, then re-invokes with consent

  // Install into the runtime cache.
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensureRuntimeManifest(dir);
  } catch (err) {
    return fail('install-failed', cacheWriteFailureDetail(dir, err));
  }

  if (options.install) {
    const ok = options.install(spec, dir);
    if (!ok || !isPackageInstalled(spec)) {
      return fail('install-failed', !ok ? 'installer returned failure' : `${packageName(spec)} not resolvable after install`);
    }
  } else {
    const inst = runDefaultInstaller(spec, dir);
    if (!inst.ok || !isPackageInstalled(spec)) {
      return fail(
        'install-failed',
        inst.detail ?? (!inst.ok ? 'npm install failed' : `${packageName(spec)} not resolvable after install`),
      );
    }
  }

  const mod = await load(spec, dir);
  return mod ? { module: mod, dir } : fail('load-failed');
}

/** A minimal manifest so npm has a project to install into. */
function ensureRuntimeManifest(dir: string): void {
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ name: 'vibgrate-runtime-deps', private: true, description: 'On-demand vg runtime packages' }, null, 2),
    );
  }
}

async function load(spec: string, dir: string): Promise<unknown | null> {
  const name = packageName(spec);
  try {
    const req = createRequire(path.join(dir, 'package.json'));
    const resolved = req.resolve(name);
    const mod: any = await import(pathToFileURL(resolved).href);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

/** Human detail when the runtime cache cannot be created or written. */
export function cacheWriteFailureDetail(dir: string, err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'EACCES' || code === 'EPERM') {
    const parent = path.dirname(dir);
    return (
      `cannot write runtime cache at ${dir} (permission denied). ` +
      `If ${parent} is root-owned (often from a past sudo run), fix with: ` +
      `sudo chown -R "$(whoami)" ${parent} — then re-run \`vg models install\``
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `cannot prepare runtime cache at ${dir}: ${msg}`;
}

/**
 * Resolve `npm` for install. GUI apps (Dock-launched VS Code) often have a
 * stripped PATH without Homebrew; fall back to common install locations.
 */
export function resolveNpmBinary(): string | null {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    const hit = whichOnPath(name);
    if (hit) return hit;
  }
  const candidates =
    process.platform === 'win32'
      ? []
      : [
          '/opt/homebrew/bin/npm',
          '/usr/local/bin/npm',
          path.join(os.homedir(), '.npm-global', 'bin', 'npm'),
          path.join(os.homedir(), '.local', 'bin', 'npm'),
        ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** `npm install --prefix <dir> <spec>` with no scripts; capture failure detail. */
function runDefaultInstaller(spec: string, dir: string): { ok: boolean; detail?: string } {
  const npm = resolveNpmBinary();
  if (!npm) {
    return {
      ok: false,
      detail:
        'npm not found on PATH (common when VS Code is launched from the Dock). ' +
        'Install Node.js, or run `vg models install` from a terminal where `npm` works',
    };
  }
  const res = spawnSync(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', '--ignore-scripts', spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  if (res.error) {
    const code = 'code' in res.error ? String((res.error as NodeJS.ErrnoException).code ?? '') : '';
    if (code === 'ENOENT') {
      return {
        ok: false,
        detail: `npm binary not executable at ${npm} — install Node.js or fix PATH, then re-run \`vg models install\``,
      };
    }
    return { ok: false, detail: res.error.message };
  }
  if (res.status === 0) return { ok: true };
  const tail = [res.stderr, res.stdout]
    .filter(Boolean)
    .join('\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' · ');
  return {
    ok: false,
    detail: tail || `npm install exited ${res.status ?? 'null'} (offline network, or registry error)`,
  };
}

/** Strip a version range from a spec → the bare package name (scoped-safe). */
export function packageName(spec: string): string {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}
