import semver from 'semver';
import { ensureHaileModule, haileModuleInstalled, installHaileModule } from '../install/haile-module.js';
import { archConsent, HAILE_MODULE_NAME } from '../install/haile-module.js';
import { kernelDisabled, latestModuleVersion, type InstallOptions } from '../install/module-core.js';

/**
 * Provision the Architecture module for a security pack run.
 *
 * `vg scan --iac` needs the module the way `vg build` does, and takes the
 * same posture (install/haile-module.ts): a bounded, consent-respecting
 * install at use time, never under `--offline`, never fatal. What this adds
 * over `ensureHaileModule` is the *outdated* case — a module that is
 * installed but predates `vg_eval_facts` — where the only honest move is to
 * bring it to the registry's latest when that is newer, and otherwise to say
 * that the published module does not carry the packs yet.
 *
 * The outcome is returned, not printed: the scan's status line decides how
 * to word it, so a user who ran `--offline` reads "not provisioned (offline)"
 * and a user whose registry was unreachable reads that instead.
 */

export type ProvisionOutcome =
  /** The module was already installed and nothing was attempted. */
  | { action: 'present'; version?: string }
  /** A missing module was installed. */
  | { action: 'installed'; version?: string }
  /** An installed-but-too-old module was replaced by the registry's latest. */
  | { action: 'updated'; from?: string; version?: string }
  /** The installed module is too old and the registry has nothing newer. */
  | { action: 'no-newer-version'; version?: string; latest?: string }
  /** `--offline`: nothing was attempted. */
  | { action: 'skipped-offline' }
  /** VIBGRATE_NO_KERNEL is set. */
  | { action: 'disabled' }
  /** A recorded consent denial. */
  | { action: 'declined' }
  /** The attempt failed (registry unreachable, bad tarball, …). */
  | { action: 'unavailable'; detail?: string };

export interface ProvisionOptions {
  /** `--offline`: never touch the network. */
  offline?: boolean;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable installers (tests); default to the real module helpers. */
  ensure?: (io: { fetchImpl?: typeof fetch }) => Promise<{ status: string; version?: string; detail?: string }>;
  latest?: (npmName: string, opts: InstallOptions) => Promise<string | null>;
  reinstall?: (opts: InstallOptions) => Promise<{ status: string; version?: string; detail?: string }>;
}

function isNewer(candidate: string, installed: string | undefined): boolean {
  if (!installed) return true;
  const a = semver.coerce(candidate)?.version;
  const b = semver.coerce(installed)?.version;
  return a !== undefined && b !== undefined ? semver.gt(a, b) : candidate !== installed;
}

/**
 * Make sure a module that can evaluate facts is installed, when allowed.
 *
 * `outdated` tells the helper the caller already loaded a module and found it
 * lacks `evalFacts`; the helper then tries the registry for a newer version
 * instead of reporting "present". Never throws.
 */
export async function provisionArchModule(
  options: ProvisionOptions & { outdated?: boolean } = {},
): Promise<ProvisionOutcome> {
  try {
    if (options.offline) return { action: 'skipped-offline' };
    if (kernelDisabled()) return { action: 'disabled' };
    if (archConsent() === 'denied') return { action: 'declined' };

    const existing = haileModuleInstalled();
    if (existing.installed && !options.outdated) return { action: 'present', version: existing.version };

    if (existing.installed && options.outdated) {
      const latest = await (options.latest ?? latestModuleVersion)(HAILE_MODULE_NAME, { fetchImpl: options.fetchImpl });
      if (!latest) return { action: 'unavailable', detail: 'registry unreachable' };
      if (!isNewer(latest, existing.version)) {
        return { action: 'no-newer-version', version: existing.version, latest };
      }
      const result = await (options.reinstall ?? installHaileModule)({ fetchImpl: options.fetchImpl, force: true });
      if (result.status === 'installed') return { action: 'updated', from: existing.version, version: result.version };
      return { action: 'unavailable', detail: result.detail ?? result.status };
    }

    const result = await (options.ensure ?? ensureHaileModule)({ fetchImpl: options.fetchImpl });
    switch (result.status) {
      case 'installed':
        return { action: 'installed', version: result.version };
      case 'already-installed':
        return { action: 'present', version: result.version };
      case 'disabled':
        return { action: 'disabled' };
      case 'declined':
        return { action: 'declined' };
      default:
        return { action: 'unavailable', detail: result.detail };
    }
  } catch (err) {
    return { action: 'unavailable', detail: err instanceof Error ? err.message.slice(0, 200) : 'provisioning failed' };
  }
}
