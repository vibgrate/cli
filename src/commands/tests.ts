import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { coveringTests, detectRunner } from '../engine/test-query.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg tests <name>` (VG-CLI-SPEC §3.4) — which tests cover it, with the linkage
 * basis and confidence. `--missing` flips to untested nodes nearby; `--run`
 * prints (or `--exec` runs) the minimal command to exercise exactly those tests.
 */
export function registerTests(program: Command): void {
  const cmd = program
    .command('tests')
    .description('which tests cover a node (call/coverage linkage)')
    .argument('<name>', 'node to inspect')
    .option('--missing', 'show untested nodes nearby instead')
    .option('--run', 'print the command to run exactly these tests')
    .option('--exec', 'run that command')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { missing?: boolean; run?: boolean; exec?: boolean; pick?: string }) {
      const global = readGlobal(this);
      const { root, graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(`"${name}" ${candidates.length ? 'is ambiguous' : 'not found'}`, candidates);

      if (opts.missing) {
        const nearby = graph.nodes
          .filter((n) => n.file === node.file && (n.kind === 'function' || n.kind === 'method') && n.tested === false)
          .sort((a, b) => b.importance - a.importance);
        if (global.json) {
          json({ file: node.file, untested: nearby.map((n) => ({ name: n.qualifiedName, line: n.span.start })) });
          return;
        }
        info(`${c.cyan('vg tests --missing')} · untested in ${node.file} (${nearby.length})`);
        for (const n of nearby) info(`  ${c.yellow('○')} ${n.qualifiedName} ${c.dim(`:${n.span.start}`)}`);
        return;
      }

      const covers = coveringTests(graph, node);
      const testFiles = covers.filter((c) => c.basis === 'call').map((c) => c.file);

      if (opts.run || opts.exec) {
        const runner = detectRunner(rootOf(global), node.lang);
        const command = runner.command(testFiles);
        if (opts.exec) {
          info(c.dim(`$ ${command}`));
          execSync(command, { cwd: root, stdio: 'inherit' });
          return;
        }
        if (global.json) json({ runner: runner.name, command, testFiles });
        else info(command);
        return;
      }

      if (global.json) {
        json({ node: node.qualifiedName, tested: node.tested, coverage: node.coverage ?? null, covers });
        return;
      }

      info(`${c.cyan('vg tests')} · ${c.bold(node.qualifiedName)}  ${node.tested ? c.green('tested') : c.yellow('untested')}`);
      if (typeof node.coverage === 'number') info(c.dim(`  line coverage ${(node.coverage * 100).toFixed(0)}%`));
      if (covers.length === 0) {
        info(c.dim('  no covering tests found'));
        return;
      }
      for (const t of covers) {
        info(`  ${c.green('✔')} ${t.file} ${c.dim(`(${t.basis}, conf ${t.confidence.toFixed(2)})`)}`);
      }
    });
  applyGlobalOptions(cmd);
}
