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
export async function ensureRelevanceModule(io: { fetchImpl?: typeof fetch } = {}): Promise<InstallResult> {
  try {
    if (kernelDisabled()) return { status: 'disabled' };
    const existing = moduleInstalled();
    if (existing.installed) return { status: 'already-installed', version: existing.version };
    if (readConsent().relevance === 'denied') return { status: 'declined' };
    return await installRelevanceModule({ fetchImpl: io.fetchImpl });
  } catch {
    return { status: 'unavailable', detail: 'auto-install failed' };
  }
}
