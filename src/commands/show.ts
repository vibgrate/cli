import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { GraphIndex } from '../engine/relations.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg show <name>` (VG-CLI-SPEC §3.3) — the richest single-node view: what it
 * is, its callers and callees and other edges, its area and importance.
 * (Facts + grounding are attached in Phase 2.)
 */
export function registerShow(program: Command): void {
  const cmd = program
    .command('show')
    .description('explain a node: what it is, what it calls, what calls it')
    .argument('<name>', 'qualified name, short name, file:line, glob, or id')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { pick?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);

      if (!node) {
        if (candidates.length === 0) {
          throw ambiguityError(`no node matches "${name}"`, []);
        }
        throw ambiguityError(`"${name}" is ambiguous`, candidates);
      }

      const index = new GraphIndex(graph);
      const callees = dedupe(index.callees(node.id).map((x) => x.node));
      const callers = dedupe(index.callers(node.id).map((x) => x.node));
      const extendsEdges = index.out(node.id, 'extends').concat(index.out(node.id, 'implements'));
      const supertypes = extendsEdges.map((e) => index.node(e.dst)?.qualifiedName).filter(Boolean);
      const area = graph.areas.find((a) => a.id === node.area);

      if (global.json) {
        json({
          id: node.id,
          name: node.qualifiedName,
          kind: node.kind,
          file: node.file,
          line: node.span.start,
          signature: node.signature ?? null,
          importance: node.importance,
          centrality: node.centrality,
          isHub: node.isHub,
          area: node.area,
          areaLabel: area?.label ?? null,
          tested: node.tested,
          calls: callees.map((n) => n.qualifiedName),
          calledBy: callers.map((n) => n.qualifiedName),
          extends: supertypes,
        });
        return;
      }

      info(`${c.cyan(node.qualifiedName)}  ${c.dim(`(${node.kind})`)}`);
      info(`  ${c.dim(`${node.file}:${node.span.start}`)}`);
      if (node.signature) info(`  ${c.bold(node.signature)}`);
      info(
        `  importance ${node.importance.toFixed(3)}${node.isHub ? c.yellow(' ★ hub') : ''} · area #${node.area}${area ? ` ${c.dim(area.label)}` : ''}`,
      );
      if (supertypes.length) info(`  ${c.dim('extends:')} ${supertypes.join(', ')}`);
      info(`  ${c.dim('calls')} (${callees.length}): ${callees.slice(0, 12).map((n) => n.qualifiedName).join(', ') || '—'}`);
      info(`  ${c.dim('called by')} (${callers.length}): ${callers.slice(0, 12).map((n) => n.qualifiedName).join(', ') || '—'}`);
    });
  applyGlobalOptions(cmd);
}

function dedupe<T extends { id: string }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
