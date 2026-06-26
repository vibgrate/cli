import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { FREE_PACK } from '../grounding/pack.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg guide <name>` (VG-CLI-SPEC §5) — cited relevant standards/practices for a
 * node from the free knowledge pack (own content + OWASP/CWE/NIST). Honest about
 * recommended vs conjectured, with citations.
 */
export function registerGuide(program: Command): void {
  const cmd = program
    .command('guide')
    .description('cited relevant standards/practices for a node (free pack)')
    .argument('<name>', 'node to inspect')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { pick?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(`"${name}" ${candidates.length ? 'is ambiguous' : 'not found'}`, candidates);

      const entries = new Map(FREE_PACK.entries.map((e) => [e.id, e]));
      const grounding = (graph.grounding ?? []).filter((g) => g.src === node.id);

      if (global.json) {
        json({
          node: node.qualifiedName,
          guidance: grounding.map((g) => ({
            kind: g.kind,
            rationale: g.rationale,
            confidence: g.confidence,
            topic: entries.get(g.packEntryId)?.topic ?? g.packEntryId,
            summary: entries.get(g.packEntryId)?.summary ?? '',
            citation: g.citation,
          })),
        });
        return;
      }

      info(`${c.cyan('vg guide')} · ${c.bold(node.qualifiedName)} (${grounding.length})`);
      if (grounding.length === 0) {
        info(c.dim('  no matching guidance (no security-relevant signals detected)'));
        return;
      }
      for (const g of grounding) {
        const entry = entries.get(g.packEntryId);
        const tag = g.rationale === 'recommended' ? c.green(g.kind) : c.yellow(g.kind);
        info(`  ${tag} ${c.dim(`(${g.rationale}, conf ${g.confidence.toFixed(2)})`)}`);
        if (entry) {
          info(`    ${entry.summary}`);
          info(c.dim(`    ${entry.citation.title} — ${entry.citation.url}`));
        }
      }
    });
  applyGlobalOptions(cmd);
}
