import * as readline from 'node:readline';
import { Command } from 'commander';
import {
  DISCLOSURE,
  RELEVANCE_MODULE_NAME,
  installRelevanceModule,
  kernelDisabled,
  moduleInstalled,
  readConsent,
  removeRelevanceModule,
  writeConsent,
} from '../install/relevance-module.js';
import { loadRelevanceProvider, resetRelevanceProviderCache } from '../engine/relevance-provider.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json, out } from '../util/output.js';
import { readGlobal, applyGlobalOptions } from '../cli-options.js';

/**
 * `vg module` — manage optional local modules (today: `relevance`).
 *
 * `install` fetches the module from the npm registry as a plain tarball,
 * verifies its integrity, and unpacks it into the vibgrate cache — the user's
 * project is never touched and nothing from the tarball executes at install
 * time. `remove` deletes it. `status` reports what is installed and whether
 * the seam can load it. All state is per-user, not per-repo.
 */
export function registerModule(program: Command): void {
  const cmd = program.command('module').description('manage optional local modules (relevance)');

  cmd
    .command('install')
    .description('install an optional module (fetches from the registry, integrity-checked)')
    .argument('<name>', 'module name (supported: relevance)')
    .option('--yes', 'skip the confirmation prompt')
    .option('--force', 'reinstall even when already present')
    .action(async function (this: Command, name: string, opts: { yes?: boolean; force?: boolean }) {
      const global = readGlobal(this);
      requireRelevance(name);
      if (kernelDisabled()) {
        throw new CliError('VIBGRATE_NO_KERNEL is set — unset it to install the relevance module', ExitCode.USAGE_ERROR);
      }
      if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const ok = await confirm(`${DISCLOSURE}\nInstall now? [Y/n] `);
        if (!ok) {
          writeConsent({ ...readConsent(), relevance: 'denied' });
          info('not installed');
          return;
        }
      }
      writeConsent({ ...readConsent(), relevance: 'granted' });
      const result = await installRelevanceModule({ force: opts.force });
      if (global.json) {
        json(result);
        if (result.status === 'unavailable') process.exitCode = ExitCode.ERROR;
        return;
      }
      if (result.status === 'installed') out(`installed ${RELEVANCE_MODULE_NAME}@${result.version}`);
      else if (result.status === 'already-installed') out(`already installed (${result.version ?? 'unknown'}) — use --force to reinstall`);
      else throw new CliError(`install failed: ${result.detail ?? result.status} — check network access to the registry, or retry later`, ExitCode.ERROR);
    });

  cmd
    .command('remove')
    .description('remove an installed module')
    .argument('<name>', 'module name (supported: relevance)')
    .action(async function (this: Command, name: string) {
      requireRelevance(name);
      removeRelevanceModule();
      out('removed');
    });

  cmd
    .command('status')
    .description('show installed modules and whether they load')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const installed = moduleInstalled();
      resetRelevanceProviderCache();
      const provider = installed.installed ? await loadRelevanceProvider() : null;
      const status = {
        relevance: {
          installed: installed.installed,
          version: installed.version ?? null,
          loadable: !!provider,
          providerVersion: provider ? provider.version() : null,
          disabled: kernelDisabled(),
          consent: readConsent().relevance ?? 'unset',
        },
      };
      if (global.json) {
        json(status);
        return;
      }
      const r = status.relevance;
      out(`relevance: ${r.installed ? `installed ${r.version}` : 'not installed'}${r.disabled ? ' (disabled via VIBGRATE_NO_KERNEL)' : ''}`);
      if (r.installed) out(`  loads: ${r.loadable ? `yes (${r.providerVersion})` : 'no'}`);
      info(c.dim(`  consent: ${r.consent}`));
    });

  applyGlobalOptions(cmd);
}

function requireRelevance(name: string): void {
  if (name !== 'relevance') {
    throw usageError(`unknown module '${name}' — supported modules: relevance`);
  }
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
