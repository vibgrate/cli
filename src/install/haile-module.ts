/**
 * Install / remove / auto-provision the architecture-classify module.
 *
 * The compiled kernel ships as a separately distributed local package.
 * The CLI loads it through engine/haile/haile-provider.ts. Shared
 * fetch/verify/unpack lives in install/module-core.ts.
 *
 * Consent posture: ON by default. Every `vg` invocation kicks a throttled
 * silent background install (cli.ts, suppressed under --offline/--local),
 * and `vg build` runs the bounded ensure at use time and prints the one
 * user-visible warning when the module cannot be provisioned. A recorded
 * denial and VIBGRATE_NO_KERNEL=1 always win. A missing or failed module
 * omits architecture lines; it never breaks vg build / vg show and never
 * falls back to a TypeScript lexicon.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { haileModuleDir, resetHaileProviderCache } from '../engine/haile/haile-provider.js';
import {
  type InstallOptions,
  type InstallResult,
  type ModuleDescriptor,
  installModule,
  kernelDisabled,
  moduleInstalledAt,
  readConsent,
  removeModule,
} from './module-core.js';

export const HAILE_MODULE_NAME = '@vibgrate/haile';

const HAILE_MODULE: ModuleDescriptor = {
  id: 'haile',
  npmName: HAILE_MODULE_NAME,
  dir: haileModuleDir,
  onChanged: resetHaileProviderCache,
};

export const HAILE_DISCLOSURE =
  'vg can install the optional Vibgrate architecture module (proprietary license, runs fully locally ' +
  'in a WASM sandbox — no network). Disable any time with VIBGRATE_NO_KERNEL=1.';

export function haileModuleInstalled(): { installed: boolean; version?: string } {
  return moduleInstalledAt(haileModuleDir());
}

export async function installHaileModule(opts: InstallOptions = {}): Promise<InstallResult> {
  return installModule(HAILE_MODULE, opts);
}

export function removeHaileModule(): void {
  removeModule(HAILE_MODULE);
}

export async function ensureHaileModule(io: { fetchImpl?: typeof fetch } = {}): Promise<InstallResult> {
  try {
    if (kernelDisabled()) return { status: 'disabled' };
    const existing = haileModuleInstalled();
    if (existing.installed) return { status: 'already-installed', version: existing.version };
    if (readConsent().haile === 'denied') return { status: 'declined' };
    return await installHaileModule({ fetchImpl: io.fetchImpl });
  } catch {
    return { status: 'unavailable', detail: 'auto-install failed' };
  }
}

const READINESS_THROTTLE_MS = 60 * 60 * 1000;
/** A kick older than this with no install behind it is a failed attempt, not one in flight. */
const ATTEMPT_SETTLE_MS = 2 * 60 * 1000;

export type HaileModuleStatus =
  | { status: 'present'; version?: string }
  /** Default-install was attempted and did not produce a module — the one case a UI may offer an install. */
  | { status: 'unavailable' }
  /** Not installed and no settled attempt yet (a kick may be in flight). Never a banner. */
  | { status: 'absent' }
  | { status: 'disabled' }
  | { status: 'declined' };

/**
 * Where the architecture module stands, for surfaces that must decide
 * between "say nothing" and "offer an install" — the LSP projects this onto
 * `vibgrate/architecture` so the editor never reads the cache itself.
 * Explicit opt-outs win; a fresh kick reads as absent until it has had time
 * to settle, so an install that is about to succeed never flashes a banner.
 */
export function haileModuleStatus(now = Date.now()): HaileModuleStatus {
  try {
    if (kernelDisabled()) return { status: 'disabled' };
    if (readConsent().haile === 'denied') return { status: 'declined' };
    const existing = haileModuleInstalled();
    if (existing.installed) return { status: 'present', version: existing.version };
    const stamp = path.join(path.dirname(haileModuleDir()), 'haile.last-attempt');
    const at = Number(fs.readFileSync(stamp, 'utf8'));
    if (Number.isFinite(at) && now - at >= ATTEMPT_SETTLE_MS) return { status: 'unavailable' };
    return { status: 'absent' };
  } catch {
    return { status: 'absent' };
  }
}

/**
 * Fire-and-forget readiness kick, called on every `vg` invocation (cli.ts).
 * When the architecture module is missing and no attempt was made within the
 * last hour, start a silent background install and return immediately — the
 * command never waits on it. `vg build` still runs a bounded ensure at use
 * time. Failures never throw and never change the command exit code.
 */
export function kickHaileReadiness(io: { fetchImpl?: typeof fetch } = {}): void {
  try {
    if (kernelDisabled()) return;
    if (readConsent().haile === 'denied') return;
    const existing = haileModuleInstalled();
    if (existing.installed) return;
    const modulesRoot = path.dirname(haileModuleDir());
    const stamp = path.join(modulesRoot, 'haile.last-attempt');
    try {
      const at = Number(fs.readFileSync(stamp, 'utf8'));
      if (Number.isFinite(at) && Date.now() - at < READINESS_THROTTLE_MS) return;
    } catch {
      /* no stamp yet — attempt */
    }
    try {
      fs.mkdirSync(modulesRoot, { recursive: true });
      fs.writeFileSync(stamp, String(Date.now()));
    } catch {
      /* unwritable cache dir — skip quietly */
    }
    void ensureHaileModule(io).catch(() => {});
  } catch {
    /* readiness must never affect the command */
  }
}
