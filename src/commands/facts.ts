import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg facts <name>` (VG-CLI-SPEC §5) — the deterministic open facts for a node,
 * epistemic-typed (declared/static → Observed/Derived; never learned/Hypothesized).
 * Facts are derived with `--deep`.
 */
export function registerFacts(program: Command): void {
  const cmd = program
    .command('facts')
    .description('the deterministic facts for a node (contract / invariant / characterization)')
    .argument('<name>', 'node to inspect')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { pick?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(`"${name}" ${candidates.length ? 'is ambiguous' : 'not found'}`, candidates);

      if (!graph.facts) {
        if (global.json) json({ node: node.qualifiedName, facts: [], note: 'facts require a --deep build' });
        else info(`${c.cyan('vg facts')} · run ${c.bold('vg --deep')} to derive facts (none in this map)`);
        return;
      }

      const facts = graph.facts.filter((f) => f.subjectIds.includes(node.id));
      if (global.json) {
        json({ node: node.qualifiedName, facts });
        return;
      }
      info(`${c.cyan('vg facts')} · ${c.bold(node.qualifiedName)} (${facts.length})`);
      if (facts.length === 0) {
        info(c.dim('  no facts derived for this node'));
        return;
      }
      for (const f of facts) {
        info(`  ${c.bold(f.kind)} ${c.dim(`[${f.derivedBy}→${f.confidence}]`)}: ${summarize(f.predicate)}`);
      }
    });
  applyGlobalOptions(cmd);
}

function summarize(predicate: unknown): string {
  if (predicate && typeof predicate === 'object') {
    const o = predicate as Record<string, unknown>;
    if (typeof o.signature === 'string') return o.signature;
    if (typeof o.guard === 'string') return `guards: ${o.guard}`;
    if (Array.isArray(o.pinnedBy)) return `pinned by ${(o.pinnedBy as string[]).join(', ')}`;
  }
  return JSON.stringify(predicate);
}
