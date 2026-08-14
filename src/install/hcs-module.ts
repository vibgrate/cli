/**
 * Install / remove / auto-provision the optional HCS engine module.
 *
 * The HCS engine (`@vibgrate/hcs-engine`) carries every HCS computation as
 * compiled WASM; the CLI loads it through engine/hcs-provider.ts. The shared
 * fetch/verify/unpack mechanism lives in install/module-core.ts.
 *
 * Consent posture: invoking `vg hcs …` is explicit intent to use HCS, which
 * cannot work at all without the engine — so first use auto-installs with a
 * one-line stderr notice (printed by the command layer). A recorded denial
 * (`vg module install hcs` answered "no") and `VIBGRATE_NO_KERNEL=1` always
 * win. Unlike relevance, a missing engine is NEVER a silent degrade: the
 * command layer fails loudly with ExitCode.ENGINE_UNAVAILABLE (6).
 */
import { hcsModuleDir, resetHcsEngineCache } from '../engine/hcs-provider.js';
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

export const HCS_MODULE_NAME = '@vibgrate/hcs-engine';

const HCS_MODULE: ModuleDescriptor = {
  id: 'hcs',
  npmName: HCS_MODULE_NAME,
  dir: hcsModuleDir,
  onChanged: resetHcsEngineCache,
};

/** The one-line disclosure shown before/at install. Public copy — keep plain. */
export const HCS_DISCLOSURE =
  'vg can install the optional Vibgrate HCS engine module (proprietary license, runs fully locally ' +
  'in a WASM sandbox — no network, no process spawns). Disable any time with VIBGRATE_NO_KERNEL=1.';

export function hcsModuleInstalled(): { installed: boolean; version?: string } {
  return moduleInstalledAt(hcsModuleDir());
}

export async function installHcsModule(opts: InstallOptions = {}): Promise<InstallResult> {
  return installModule(HCS_MODULE, opts);
}

export function removeHcsModule(): void {
  removeModule(HCS_MODULE);
}

/**
 * Auto-provision hook for `vg hcs …`: fast no-op when installed; otherwise
 * install unless denied or disabled. The caller decides how to surface the
 * result — for HCS every non-installed outcome becomes a loud
 * ENGINE_UNAVAILABLE failure, never a silent skip.
 */
export async function ensureHcsModule(io: { fetchImpl?: typeof fetch } = {}): Promise<InstallResult> {
  try {
    if (kernelDisabled()) return { status: 'disabled' };
    const existing = hcsModuleInstalled();
    if (existing.installed) return { status: 'already-installed', version: existing.version };
    if (readConsent().hcs === 'denied') return { status: 'declined' };
    return await installHcsModule({ fetchImpl: io.fetchImpl });
  } catch {
    return { status: 'unavailable', detail: 'auto-install failed' };
  }
}
