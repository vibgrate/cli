import { loadHaileProvider, resetHaileProviderCache, type HaileProvider } from '../engine/haile/haile-provider.js';
import { buildFactDocument } from './facts.js';
import { provisionArchModule, type ProvisionOptions, type ProvisionOutcome } from './provision.js';
import { sanitizeSecurityResult } from './sanitize.js';
import type { SecuritySection } from './types.js';

/**
 * Run security packs over a tree: build the fact document, hand it to the
 * Architecture module, sanitise what comes back.
 *
 * Four outcomes, and the caller must tell them apart (plan §2.1): a module
 * that is not installed is `module-missing`, one that is installed but
 * predates `vg_eval_facts` is `module-outdated`, a module that abstained or
 * returned something off-contract is `abstained`, and only a valid result is
 * `ok`. There is no path that turns "nothing ran" into an empty section — the
 * artifact's `extended.security` stays absent unless the module actually
 * evaluated the document.
 *
 * With `provision` set, a missing or outdated module is provisioned first
 * (plan §2.8: `--iac` auto-provisions the way `vg ask` provisions the
 * relevance module), under the same consent and offline rules as `vg build`.
 * The outcome rides on the result so the scan can say what happened.
 */

export type SecurityRunResult =
  | { status: 'ok'; section: SecuritySection; provision?: ProvisionOutcome }
  | { status: 'module-missing'; provision?: ProvisionOutcome }
  | { status: 'module-outdated'; version?: string; provision?: ProvisionOutcome }
  | { status: 'abstained'; provision?: ProvisionOutcome };

export interface RunSecurityPacksOptions {
  root: string;
  exclude?: string[];
  packs: readonly string[];
  /**
   * Inject a provider (tests, embedding). `null` means "no module"; omit the
   * key to load the installed module through {@link loadHaileProvider}.
   */
  provider?: HaileProvider | null;
  /**
   * Provision the module before loading it when it is missing or outdated.
   * Ignored when a provider is injected. Omit to never touch the network.
   */
  provision?: ProvisionOptions;
}

function moduleVersion(provider: HaileProvider): string | undefined {
  try {
    const v = provider.version();
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A provider is usable for packs only when it carries the facts entry point. */
function canEvaluate(provider: HaileProvider | null): provider is HaileProvider & { evalFacts: NonNullable<HaileProvider['evalFacts']> } {
  return Boolean(provider) && typeof provider!.evalFacts === 'function';
}

export async function runSecurityPacks(options: RunSecurityPacksOptions): Promise<SecurityRunResult> {
  let provider: HaileProvider | null;
  let provision: ProvisionOutcome | undefined;

  if ('provider' in options) {
    provider = options.provider ?? null;
  } else {
    provider = await loadHaileProvider();
    if (options.provision && !canEvaluate(provider)) {
      // Missing → install; present-but-old → update when the registry has a
      // newer build. Either way the memoised loader is reset by the install
      // (module-core `onChanged`), so a second load sees the new module; an
      // outdated module that could not be updated is reloaded to the same
      // provider and reported as outdated below.
      provision = await provisionArchModule({ ...options.provision, outdated: provider !== null });
      if (provision.action === 'installed' || provision.action === 'updated') {
        resetHaileProviderCache();
        provider = await loadHaileProvider();
      }
    }
  }

  if (!provider) return { status: 'module-missing', ...(provision ? { provision } : {}) };
  if (!canEvaluate(provider)) {
    return { status: 'module-outdated', version: moduleVersion(provider), ...(provision ? { provision } : {}) };
  }

  const document = await buildFactDocument({
    root: options.root,
    exclude: options.exclude,
    packs: options.packs,
  });

  let raw: unknown;
  try {
    // The contract is synchronous; awaiting tolerates a module that returns a promise.
    raw = await provider.evalFacts(document);
  } catch {
    return { status: 'abstained', ...(provision ? { provision } : {}) };
  }
  if (raw === null || raw === undefined) return { status: 'abstained', ...(provision ? { provision } : {}) };

  const section = sanitizeSecurityResult(raw, options.packs);
  if (!section) return { status: 'abstained', ...(provision ? { provision } : {}) };
  return { status: 'ok', section, ...(provision ? { provision } : {}) };
}
