import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { shortestPath } from '../engine/paths.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg path <A> <B>` (VG-CLI-SPEC §4.1) — how A connects to B (shortest path).
 */
export function registerPath(program: Command): void {
  const cmd = program
    .command('path')
    .description('how A connects to B (shortest path)')
    .argument('<a>', 'source node')
    .argument('<b>', 'target node')
    .option('--pick-a <n>', 'pick the nth candidate for A when ambiguous')
    .option('--pick-b <n>', 'pick the nth candidate for B when ambiguous')
    .action(function (this: Command, a: string, b: string, opts: { pickA?: string; pickB?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);

      const ra = resolveOne(graph, a, opts.pickA ? Number(opts.pickA) : undefined);
      if (!ra.node) throw ambiguityError(`"${a}" ${ra.candidates.length ? 'is ambiguous' : 'not found'}`, ra.candidates, '--pick-a');
      const rb = resolveOne(graph, b, opts.pickB ? Number(opts.pickB) : undefined);
      if (!rb.node) throw ambiguityError(`"${b}" ${rb.candidates.length ? 'is ambiguous' : 'not found'}`, rb.candidates, '--pick-b');

      const result = shortestPath(graph, ra.node.id, rb.node.id);
      // Record the call for the command-vs-MCP split when an AI identified itself
      // (before the not-found throw, so a no-path attempt is counted as a miss).
      if (global.client) {
        recordCliCall(
          rootOf(global),
          { tool: CLI_TOOL_ALIASES.path, client: global.client, outcome: result ? 'complete' : 'miss' },
          Date.now(),
        );
      }
      if (!result) {
        throw new CliError(
          `no path between ${ra.node.qualifiedName} and ${rb.node.qualifiedName}`,
          ExitCode.NOT_FOUND,
        );
      }

      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      const names = result.ids.map((id) => byId.get(id)?.qualifiedName ?? id);

      if (global.json) {
        json({ from: ra.node.qualifiedName, to: rb.node.qualifiedName, hops: names.length - 1, direction: result.direction, path: names });
        return;
      }

      info(`${c.cyan('vg path')} · ${names.length - 1} hop(s)${result.direction === 'reverse' ? c.dim(' (reverse)') : ''}`);
      info('  ' + names.map((n) => c.bold(n)).join(c.dim(' → ')));
    });
  applyGlobalOptions(cmd);
}
