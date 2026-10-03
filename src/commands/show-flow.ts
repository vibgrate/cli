/**
 * `vg show flow <entry>` — what a function does, step by step, as a pinned
 * flow diagram drawn from the code map.
 *
 * Nested under `vg show` (FEATURE-DESIGN-PRINCIPLES P1): it is the explain
 * view of `vg show <name> --diagram` narrowed to its flows, so the schema,
 * validator and renderers are the same.
 */
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { loadHaileProvider } from '../engine/haile/haile-provider.js';
import { resolveOne } from '../engine/lookup.js';
import { renderReviewDocMarkdown } from '../review/doc.js';
import { buildExplainDoc, ExplainEmpty } from '../review/explain-doc.js';
import { CliError, ExitCode } from '../util/exit.js';
import { out } from '../util/output.js';
import { ambiguityError } from './ambiguity.js';
import { requireGraph } from './util.js';

export function registerShowFlow(show: Command): void {
  const cmd = show
    .command('flow')
    .description('what a function does, step by step, as a pinned flow diagram from the code map (needs the Architecture module)')
    .argument('<entry>', 'the function: qualified name, short name, file:line, glob or id')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .option('--format <fmt>', 'output format (md | json)', 'md')
    .action(async function (this: Command, entry: string, opts: { pick?: string; format: string }) {
      const global = readGlobal(this);
      if (opts.format !== 'md' && opts.format !== 'json') throw new CliError('unknown --format (expected md | json)', ExitCode.USAGE_ERROR);
      const { root, graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, entry, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(candidates.length === 0 ? `no node matches "${entry}"` : `"${entry}" is ambiguous`, candidates);
      const provider = await loadHaileProvider();
      if (!provider) {
        throw new CliError('`vg show flow` needs the Architecture module — install it with `vg module install arch`', ExitCode.ENGINE_UNAVAILABLE);
      }
      try {
        const { doc } = buildExplainDoc({ root, graph, node, graphPath: global.graph, provider, only: ['flow'] });
        out(Boolean(global.json) || opts.format === 'json' ? JSON.stringify(doc, null, 2) : renderReviewDocMarkdown(doc).replace(/\n$/, ''));
      } catch (err) {
        if (err instanceof ExplainEmpty) throw new CliError(err.message, ExitCode.NOT_FOUND);
        throw err;
      }
    });
  applyGlobalOptions(cmd);
}
