/**
 * `vg policy` — inspect / verify context-policy patches (Fusion Phase 7).
 *
 * Learning never mutates production from a single task. This command only
 * verifies a signed `context-policy-patch/0` JSON file and reports whether it
 * is ready for a release PR that bumps CONTEXT_POLICY_VERSION.
 */

import * as fs from 'node:fs';
import { Command } from 'commander';
import {
  canProposeProductionBump,
  verifyContextPolicyPatch,
  type ContextPolicyPatch,
} from '../code/context-policy.js';
import { CONTEXT_POLICY_VERSION } from '../code/run-provenance.js';
import { CAPSULE_RANKING_VERSION } from '../code/capsule.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

export function registerPolicy(program: Command): void {
  const cmd = program
    .command('policy')
    .description('context-policy pins and signed learning patches (Fusion Runtime)')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const payload = {
        productionPin: CONTEXT_POLICY_VERSION,
        rankingVersion: CAPSULE_RANKING_VERSION,
        note: 'Bumps only via signed context-policy-patch/0 after benchmark significance (nTasks ≥ 10). Never from a single task.',
      };
      if (global.json) {
        json(payload);
        return;
      }
      info(`${c.cyan('vg policy')} · production pin ${c.bold(CONTEXT_POLICY_VERSION)}`);
      info(c.dim(`  ranking ${CAPSULE_RANKING_VERSION}`));
      info(c.dim('  verify a patch with `vg policy verify <file.json>`'));
    });
  applyGlobalOptions(cmd);

  const verify = cmd
    .command('verify')
    .description('verify a context-policy-patch/0 JSON file (hash + optional signature)')
    .argument('<file>', 'path to a context-policy-patch/0 JSON document')
    .action(function (this: Command, file: string) {
      const global = readGlobal(this);
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        throw new CliError(`cannot read ${file}`, ExitCode.NOT_FOUND);
      }
      let patch: ContextPolicyPatch;
      try {
        patch = JSON.parse(raw) as ContextPolicyPatch;
      } catch {
        throw new CliError(`${file} is not valid JSON`, ExitCode.USAGE_ERROR);
      }
      if (!patch || patch.schemaVersion !== 'context-policy-patch/0') {
        throw new CliError(
          `expected schemaVersion context-policy-patch/0 (got ${String((patch as { schemaVersion?: string })?.schemaVersion)})`,
          ExitCode.USAGE_ERROR,
        );
      }
      const v = verifyContextPolicyPatch(patch);
      const gate = canProposeProductionBump(patch);
      const report = {
        file,
        verify: v,
        productionGate: gate,
        currentPin: CONTEXT_POLICY_VERSION,
        proposed: patch.proposedPolicyVersion,
        nTasks: patch.significance?.nTasks,
      };
      if (global.json) {
        json(report);
        return;
      }
      info(`${c.cyan('vg policy verify')} · ${file}`);
      info(`  hash/signature: ${v.status} — ${v.reason}`);
      info(
        `  production gate: ${gate.ok ? c.green('ready') : c.yellow('not ready')} — ${gate.reason}`,
      );
      info(c.dim(`  current pin ${CONTEXT_POLICY_VERSION} → proposed ${patch.proposedPolicyVersion}`));
      if (!gate.ok) process.exitCode = ExitCode.ERROR;
    });
  applyGlobalOptions(verify);
}
