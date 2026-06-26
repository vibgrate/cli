import * as path from 'node:path';
import { Command } from 'commander';
import { verifyDeterminism } from '../engine/verify.js';
import { ExitCode, CliError } from '../util/exit.js';
import { c, info, json } from '../util/output.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';

/**
 * `vg verify` — determinism self-check. Re-derives the graph and asserts
 * byte-equality run-to-run and cache-vs-full. Exit 4 on mismatch (the contract
 * that keeps the headline determinism claim from wobbling — run in CI).
 */
export function registerVerify(program: Command): void {
  const cmd = program
    .command('verify')
    .description('determinism self-check (exit 4 on mismatch)')
    .option('--only <langs>', 'restrict to languages, e.g. ts,py')
    .option('--jobs <n>', 'worker count')
    .action(async function (this: Command, opts: { only?: string; jobs?: string }) {
      const global = readGlobal(this);
      const root = path.resolve(global.cwd ?? '.');
      const result = await verifyDeterminism({
        root,
        only: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        jobs: opts.jobs ? Number(opts.jobs) : undefined,
      });

      if (global.json) {
        json({ ok: result.ok, checks: result.checks, digest: result.digest });
      } else {
        info(`${c.cyan('vg verify')} · ${path.relative(process.cwd(), root) || '.'}`);
        for (const check of result.checks) {
          const mark = check.ok ? c.green('✔') : c.red('✘');
          const detail = check.detail ? c.dim(` (${check.detail})`) : '';
          info(`  ${mark} ${check.name}${detail}`);
        }
        info(result.ok ? c.green(`  deterministic · digest ${result.digest.slice(0, 16)}…`) : c.red('  NON-DETERMINISTIC'));
      }

      if (!result.ok) {
        throw new CliError('determinism self-check failed', ExitCode.NON_DETERMINISTIC);
      }
    });
  applyGlobalOptions(cmd);
}
