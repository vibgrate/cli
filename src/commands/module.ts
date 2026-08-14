import * as readline from 'node:readline';
import { Command } from 'commander';
import {
  DISCLOSURE,
  RELEVANCE_MODULE_NAME,
  installRelevanceModule,
  moduleInstalled,
  removeRelevanceModule,
} from '../install/relevance-module.js';
import {
  HCS_DISCLOSURE,
  HCS_MODULE_NAME,
  hcsModuleInstalled,
  installHcsModule,
  removeHcsModule,
} from '../install/hcs-module.js';
import { type InstallOptions, type InstallResult, kernelDisabled, readConsent, writeConsent } from '../install/module-core.js';
import { loadRelevanceProvider, resetRelevanceProviderCache } from '../engine/relevance-provider.js';
import { loadHcsEngine, resetHcsEngineCache } from '../engine/hcs-provider.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json, out } from '../util/output.js';
import { readGlobal, applyGlobalOptions } from '../cli-options.js';

/** Everything the command needs to manage one optional module. */
interface ManagedModule {
  npmName: string;
  disclosure: string;
  install(opts: InstallOptions): Promise<InstallResult>;
  remove(): void;
  installed(): { installed: boolean; version?: string };
  resetLoader(): void;
  /** Load through the seam; report the loaded engine/provider version. */
  loadedVersion(): Promise<string | null>;
}

const MODULES: Record<string, ManagedModule> = {
  relevance: {
    npmName: RELEVANCE_MODULE_NAME,
    disclosure: DISCLOSURE,
    install: installRelevanceModule,
    remove: removeRelevanceModule,
    installed: moduleInstalled,
    resetLoader: resetRelevanceProviderCache,
    loadedVersion: async () => {
      const provider = await loadRelevanceProvider();
      return provider ? provider.version() : null;
    },
  },
  hcs: {
    npmName: HCS_MODULE_NAME,
    disclosure: HCS_DISCLOSURE,
    install: installHcsModule,
    remove: removeHcsModule,
    installed: hcsModuleInstalled,
    resetLoader: resetHcsEngineCache,
    loadedVersion: async () => {
      const engine = await loadHcsEngine();
      return engine ? engine.version() : null;
    },
  },
};

const SUPPORTED = Object.keys(MODULES).join(', ');

/**
 * `vg module` — manage optional local modules (relevance, hcs).
 *
 * `install` fetches the module from the npm registry as a plain tarball,
 * verifies its integrity, and unpacks it into the vibgrate cache — the user's
 * project is never touched and nothing from the tarball executes at install
 * time. `remove` deletes it. `status` reports what is installed and whether
 * the seam can load it. All state is per-user, not per-repo.
 */
export function registerModule(program: Command): void {
  const cmd = program.command('module').description(`manage optional local modules (${SUPPORTED})`);

  cmd
    .command('install')
    .description('install an optional module (fetches from the registry, integrity-checked)')
    .argument('<name>', `module name (supported: ${SUPPORTED})`)
    .option('--yes', 'skip the confirmation prompt')
    .option('--force', 'reinstall even when already present')
    .action(async function (this: Command, name: string, opts: { yes?: boolean; force?: boolean }) {
      const global = readGlobal(this);
      const mod = requireModule(name);
      if (kernelDisabled()) {
        throw new CliError(`VIBGRATE_NO_KERNEL is set — unset it to install the ${name} module`, ExitCode.USAGE_ERROR);
      }
      if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const ok = await confirm(`${mod.disclosure}\nInstall now? [Y/n] `);
        if (!ok) {
          writeConsent({ ...readConsent(), [name]: 'denied' });
          info('not installed');
          return;
        }
      }
      writeConsent({ ...readConsent(), [name]: 'granted' });
      const result = await mod.install({ force: opts.force });
      if (global.json) {
        json(result);
        if (result.status === 'unavailable') process.exitCode = ExitCode.ERROR;
        return;
      }
      if (result.status === 'installed') out(`installed ${mod.npmName}@${result.version}`);
      else if (result.status === 'already-installed') out(`already installed (${result.version ?? 'unknown'}) — use --force to reinstall`);
      else throw new CliError(`install failed: ${result.detail ?? result.status} — check network access to the registry, or retry later`, ExitCode.ERROR);
    });

  cmd
    .command('remove')
    .description('remove an installed module')
    .argument('<name>', `module name (supported: ${SUPPORTED})`)
    .action(async function (this: Command, name: string) {
      requireModule(name).remove();
      out('removed');
    });

  cmd
    .command('status')
    .description('show installed modules and whether they load')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const consent = readConsent();
      const status: Record<
        string,
        { installed: boolean; version: string | null; loadable: boolean; providerVersion: string | null; disabled: boolean; consent: string }
      > = {};
      for (const [name, mod] of Object.entries(MODULES)) {
        const installed = mod.installed();
        mod.resetLoader();
        const loadedVersion = installed.installed ? await mod.loadedVersion() : null;
        status[name] = {
          installed: installed.installed,
          version: installed.version ?? null,
          loadable: loadedVersion !== null,
          providerVersion: loadedVersion,
          disabled: kernelDisabled(),
          consent: consent[name] ?? 'unset',
        };
      }
      if (global.json) {
        json(status);
        return;
      }
      for (const [name, s] of Object.entries(status)) {
        out(`${name}: ${s.installed ? `installed ${s.version}` : 'not installed'}${s.disabled ? ' (disabled via VIBGRATE_NO_KERNEL)' : ''}`);
        if (s.installed) out(`  loads: ${s.loadable ? `yes (${s.providerVersion})` : 'no'}`);
        info(c.dim(`  consent: ${s.consent}`));
      }
    });

  applyGlobalOptions(cmd);
}

function requireModule(name: string): ManagedModule {
  const mod = MODULES[name];
  if (!mod) throw usageError(`unknown module '${name}' — supported modules: ${SUPPORTED}`);
  return mod;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() === '' || /^y(es)?$/i.test(answer.trim()));
    });
  });
}
