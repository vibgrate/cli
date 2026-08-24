/**
 * Install / remove / auto-provision the optional relevance module.
 *
 * The relevance module is a separately licensed, separately distributed local
 * package (`@vibgrate/relevance`) that the CLI loads through the generic
 * provider seam (engine/relevance-provider.ts). The shared fetch/verify/unpack
 * mechanism lives in install/module-core.ts; this file holds the relevance
 * descriptor and its consent posture.
 *
 * Consent posture (maintainer decision, 2026-08 — see
 * docs/RELEVANCE-KERNEL-PLAN.md §4 in the monorepo): ON by default. First
 * interactive use asks once and persists the answer; non-interactive runs
 * (CI) install silently with a one-line stderr notice. `VIBGRATE_NO_KERNEL=1`
 * always wins and disables both install and use. Offline or fetch failure
 * degrades with a one-line message — never an error (GUARDRAILS §3.4).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { relevanceModuleDir, resetRelevanceProviderCache } from '../engine/relevance-provider.js';
import {
  type InstallOptions,
  type InstallResult,
  type ModuleDescriptor,
  installModule,
  kernelDisabled,
  moduleInstalledAt,
  readConsent,
  removeModule,
  writeConsent,
} from './module-core.js';

export type { InstallOptions, InstallResult };
export { kernelDisabled, readConsent, writeConsent };
export { verifyIntegrity, untar } from './module-core.js';

export const RELEVANCE_MODULE_NAME = '@vibgrate/relevance';

const RELEVANCE_MODULE: ModuleDescriptor = {
  id: 'relevance',
  npmName: RELEVANCE_MODULE_NAME,
  dir: relevanceModuleDir,
  onChanged: resetRelevanceProviderCache,
};

export function moduleInstalled(): { installed: boolean; version?: string } {
  return moduleInstalledAt(relevanceModuleDir());
}

/** The one-line disclosure shown before/at install. Public copy — keep plain. */
export const DISCLOSURE =
  'vg can install the optional Vibgrate relevance module (proprietary license, runs fully locally, ' +
  'improves how questions find the code they mean). Disable any time with VIBGRATE_NO_KERNEL=1.';

/**
 * Fetch, verify, and unpack the module into the modules cache dir. The
 * loadable surface is the tarball's `package/dist/*` mapped to the module
 * root (so `<dir>/index.js` is the seam's entrypoint), plus LICENSE/README.
 */
export async function installRelevanceModule(opts: InstallOptions = {}): Promise<InstallResult> {
  return installModule(RELEVANCE_MODULE, opts);
}

export function removeRelevanceModule(): void {
  removeModule(RELEVANCE_MODULE);
}

/**
 * Auto-provision hook for `vg code` startup — fully SILENT by design
 * (maintainer decision, 2026-08): the module installs automatically with no
 * prompt and no notice; if the install or the module itself fails for any
 * reason the run simply proceeds without it, exactly as if it were never
 * there. Fast no-op when already installed. Two opt-outs still always win:
 * `VIBGRATE_NO_KERNEL=1`, and an explicit decline recorded via
 * `vg module install relevance` answering "no" (or `vg module remove`
 * followed by a recorded denial). Never throws, never blocks a run on
 * anything but the (bounded) fetch itself.
 */
/**
 * Oldest module version whose provider carries the `rankSymbols` ranking API
 * (the 2026-08 relevance relocation). An older install still loads for
 * analyze/tagNode, but the seam treats it as "no ranking engine", so the
 * ensure path force-upgrades it in place.
 */
export const RANKING_MIN_MODULE_VERSION = '2026.823.0';

/** Dotted-numeric version compare (module versions are `YYYY.MDD.N`). */
function versionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map((n) => Number(n));
  const b = min.split('.').map((n) => Number(n));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

export async function ensureRelevanceModule(io: { fetchImpl?: typeof fetch } = {}): Promise<InstallResult> {
  try {
    if (kernelDisabled()) return { status: 'disabled' };
    if (readConsent().relevance === 'denied') return { status: 'declined' };
    const existing = moduleInstalled();
    if (existing.installed) {
      // Pre-ranking installs upgrade in place — since the relocation, the
      // module IS the relevance engine, so an old version is as good as none.
      if (versionAtLeast(existing.version, RANKING_MIN_MODULE_VERSION)) {
        return { status: 'already-installed', version: existing.version };
      }
      return await installRelevanceModule({ fetchImpl: io.fetchImpl, force: true });
    }
    return await installRelevanceModule({ fetchImpl: io.fetchImpl });
  } catch {
    return { status: 'unavailable', detail: 'auto-install failed' };
  }
}

/** Stamp file throttling background readiness attempts (offline machines must
 *  not pay a fetch on every `vg` invocation). Lives beside the module dir. */
const READINESS_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Fire-and-forget readiness kick, called on EVERY `vg` invocation (cli.ts):
 * when the module is missing (or predates the ranking API) and no attempt was
 * made within the last hour, start a silent background install and return
 * immediately — the command never waits on it. `vg ask` / `vg code` still
 * run their own bounded `ensureRelevanceModule()` retry at use time, so a
 * fresh machine gets the module on the first ask even if this kick's install
 * has not finished. Failures are invisible by design: the run proceeds on
 * the mechanical fallback exactly as if the module never existed.
 */
export function kickRelevanceReadiness(io: { fetchImpl?: typeof fetch } = {}): void {
  try {
    if (kernelDisabled()) return;
    if (readConsent().relevance === 'denied') return;
    const existing = moduleInstalled();
    if (existing.installed && versionAtLeast(existing.version, RANKING_MIN_MODULE_VERSION)) return;
    const modulesRoot = path.dirname(relevanceModuleDir());
    const stamp = path.join(modulesRoot, 'relevance.last-attempt');
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
    void ensureRelevanceModule(io).catch(() => {});
  } catch {
    /* readiness must never affect the command */
  }
}
