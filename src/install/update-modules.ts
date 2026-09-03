/**
 * Bring the optional local modules (relevance, hcs, haile) up to the
 * registry's latest as part of `vg update`.
 *
 * Modules are pinned to whatever `dist-tags.latest` was when they were first
 * provisioned and never refresh on their own (`installModule` short-circuits
 * on an existing install), so the CLI self-update is the natural moment to
 * check them. Policy per module:
 *
 *   - VIBGRATE_NO_KERNEL=1 skips everything; a recorded denial skips that
 *     module — `vg update` never overrides an explicit opt-out.
 *   - An installed module with a newer published version is reinstalled
 *     (force) at latest.
 *   - A missing module is installed only when its posture is ON by default
 *     (relevance, haile). HCS provisions on first use of `vg hcs` instead.
 *   - Every failure is reported, never thrown: a module problem must not
 *     fail a successful CLI update.
 */
import semver from 'semver';
import {
  type InstallOptions,
  type InstallResult,
  kernelDisabled,
  latestModuleVersion,
  readConsent,
} from './module-core.js';
import { RELEVANCE_MODULE_NAME, installRelevanceModule, moduleInstalled } from './relevance-module.js';
import { HCS_MODULE_NAME, hcsModuleInstalled, installHcsModule } from './hcs-module.js';
import { HAILE_MODULE_NAME, haileModuleInstalled, installHaileModule } from './haile-module.js';

export interface ModuleUpdateReport {
  /** Consent/registry id (`relevance`, `hcs`, `haile`). */
  id: string;
  npmName: string;
  status:
    | 'updated'
    | 'installed'
    | 'update-available'
    | 'install-available'
    | 'up-to-date'
    | 'not-installed'
    | 'declined'
    | 'disabled'
    | 'failed';
  /** Version installed before the check, when there was one. */
  from?: string;
  /** Version now installed (or available, on failure). */
  to?: string;
  detail?: string;
}

interface ManagedModuleRef {
  id: string;
  npmName: string;
  installedNow(): { installed: boolean; version?: string };
  install(opts: InstallOptions): Promise<InstallResult>;
  /** ON-by-default modules are installed by `vg update` even when absent. */
  defaultOn: boolean;
}

const MODULES: ManagedModuleRef[] = [
  { id: 'relevance', npmName: RELEVANCE_MODULE_NAME, installedNow: moduleInstalled, install: installRelevanceModule, defaultOn: true },
  { id: 'hcs', npmName: HCS_MODULE_NAME, installedNow: hcsModuleInstalled, install: installHcsModule, defaultOn: false },
  { id: 'haile', npmName: HAILE_MODULE_NAME, installedNow: haileModuleInstalled, install: installHaileModule, defaultOn: true },
];

/** True when `candidate` is a strictly newer version than `installed`. */
function isNewer(candidate: string, installed: string | undefined): boolean {
  if (!installed) return true;
  const a = semver.coerce(candidate)?.version;
  const b = semver.coerce(installed)?.version;
  return a !== undefined && b !== undefined ? semver.gt(a, b) : candidate !== installed;
}

/**
 * Check every module against the registry and (unless `checkOnly`) bring the
 * eligible ones to latest. Always resolves; never throws.
 */
export async function updateLocalModules(
  opts: InstallOptions & { checkOnly?: boolean } = {},
): Promise<ModuleUpdateReport[]> {
  const reports: ModuleUpdateReport[] = [];
  for (const mod of MODULES) {
    const base: Pick<ModuleUpdateReport, 'id' | 'npmName'> = { id: mod.id, npmName: mod.npmName };
    try {
      if (kernelDisabled()) {
        reports.push({ ...base, status: 'disabled' });
        continue;
      }
      if (readConsent()[mod.id] === 'denied') {
        reports.push({ ...base, status: 'declined' });
        continue;
      }
      const existing = mod.installedNow();
      if (!existing.installed && !mod.defaultOn) {
        reports.push({ ...base, status: 'not-installed' });
        continue;
      }
      const latest = await latestModuleVersion(mod.npmName, opts);
      if (!latest) {
        reports.push({ ...base, status: 'failed', from: existing.version, detail: 'registry unreachable or no published version' });
        continue;
      }
      if (existing.installed && !isNewer(latest, existing.version)) {
        reports.push({ ...base, status: 'up-to-date', from: existing.version, to: existing.version });
        continue;
      }
      if (opts.checkOnly) {
        reports.push({ ...base, status: existing.installed ? 'update-available' : 'install-available', from: existing.version, to: latest });
        continue;
      }
      const result = await mod.install({ ...opts, force: existing.installed });
      if (result.status === 'installed') {
        reports.push({ ...base, status: existing.installed ? 'updated' : 'installed', from: existing.version, to: result.version });
      } else {
        reports.push({ ...base, status: 'failed', from: existing.version, to: latest, detail: result.detail ?? result.status });
      }
    } catch (err) {
      reports.push({ ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}
