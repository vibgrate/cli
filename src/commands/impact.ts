import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { impactOf } from '../engine/impact.js';
import { testsToRun, detectRunner } from '../engine/test-query.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg impact <name>` (VG-CLI-SPEC §3.5) — what breaks if you change it: the
 * deterministic structural blast radius (reverse reachability + decay
 * confidence), and with `--tests`, exactly the tests to run before shipping.
 * `--fail-on-untested` is a CI gate (exit 2).
 */
export function registerImpact(program: Command): void {
  const cmd = program
    .command('impact')
    .description('what breaks if you change it — and the tests to run')
    .argument('<name>', 'node to assess')
    .option('--depth <n>', 'max depth', '4')
    .option('--tests', 'also select the tests to run for the affected set')
    .option('--fail-on-untested', 'exit 2 if any affected node is untested')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { depth?: string; tests?: boolean; failOnUntested?: boolean; pick?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(`"${name}" ${candidates.length ? 'is ambiguous' : 'not found'}`, candidates);

      const depth = Number(opts.depth) || 4;
      const result = impactOf(graph, node.id, { depth });
      const withTests = opts.tests || opts.failOnUntested;
      const ti = withTests ? testsToRun(graph, node.id, depth) : undefined;
      const runner = ti ? detectRunner(rootOf(global), node.lang) : undefined;

      if (global.json) {
        json({
          ...result,
          tests: ti
            ? { toRun: ti.affectedTestFiles, command: runner?.command(ti.affectedTestFiles), untestedAffected: ti.untestedAffected }
            : undefined,
        });
      } else {
        info(`${c.cyan('Impact of')} ${c.bold(result.root.name)}`);
        info(`  Affected (${result.affected.length})   ▸ ${result.direct} direct, ${result.transitive} transitive (depth ≤ ${result.depth})`);
        const preview = result.affected.slice(0, 15);
        for (const a of preview) {
          info(`    ${c.dim(`d${a.depth}`)} ${a.name} ${c.dim(`${a.file}:${a.line} · conf ${a.confidence.toFixed(2)}`)}`);
        }
        if (result.affected.length > preview.length) info(c.dim(`    …and ${result.affected.length - preview.length} more (use --json)`));
        if (result.minEdgeConfidence < 1) info(c.dim(`  lowest edge confidence ${result.minEdgeConfidence.toFixed(2)} (ambiguous/dynamic edges lower it)`));
        if (ti) {
          info(`  ${c.cyan(`Tests to run (${ti.affectedTestFiles.length})`)} ▸ ${ti.affectedTestFiles.join(' · ') || c.dim('none found')}`);
          if (runner && ti.affectedTestFiles.length) info(c.dim(`    $ ${runner.command(ti.affectedTestFiles)}`));
          if (ti.untestedAffected.length) info(c.yellow(`  ${ti.untestedAffected.length} affected node(s) are untested`));
        }
      }

      if (opts.failOnUntested && ti && ti.untestedAffected.length > 0) {
        throw new CliError(
          `${ti.untestedAffected.length} affected node(s) are untested: ${ti.untestedAffected.slice(0, 5).map((u) => u.name).join(', ')}`,
          ExitCode.GATE_FAILED,
        );
      }
    });
  applyGlobalOptions(cmd);
}
