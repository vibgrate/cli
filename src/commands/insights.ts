import { Command } from 'commander';
import { renderReport } from '../engine/report.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph } from './util.js';
import { c, info, json, out } from '../util/output.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Map insights (VG-CLI-SPEC §4.1): `vg map`, `vg hubs`, `vg areas`,
 * `vg oddities`. Read-only views over the committed graph.
 */
export function registerInsights(program: Command): void {
  const map = program
    .command('map')
    .description('the overview report (areas, hubs, untested hotspots)')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      if (global.json) json(reportJson(graph));
      else out(renderReport(graph));
    });
  applyGlobalOptions(map);

  const hubs = program
    .command('hubs')
    .description('the most-depended-on code (centrality outliers)')
    .option('-n, --limit <n>', 'how many to show', '20')
    .action(function (this: Command, opts: { limit?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const limit = Number(opts.limit) || 20;
      const list = graph.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'external')
        .sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName))
        .slice(0, limit);
      if (global.json) {
        json(list.map(nodeSummary));
        return;
      }
      info(`${c.cyan('vg hubs')} · top ${list.length} by importance`);
      for (const n of list) {
        const hub = n.isHub ? c.yellow(' ★') : '';
        info(`  ${pad(n.importance.toFixed(3), 6)}  ${c.bold(n.qualifiedName)}${hub}  ${c.dim(`${n.file}:${n.span.start}`)}`);
      }
    });
  applyGlobalOptions(hubs);

  const areas = program
    .command('areas')
    .description('the natural groupings (communities), each labelled and sized')
    .option('-n, --limit <n>', 'how many to show', '30')
    .action(function (this: Command, opts: { limit?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const limit = Number(opts.limit) || 30;
      const list = [...graph.areas].sort((a, b) => b.size - a.size || a.id - b.id).slice(0, limit);
      if (global.json) {
        json(list);
        return;
      }
      info(`${c.cyan('vg areas')} · ${graph.areas.length} communities (${graph.meta.cluster})`);
      for (const a of list) {
        info(
          `  ${c.bold(`#${a.id}`)} ${a.label}  ${c.dim(`${a.size} nodes · cohesion ${a.cohesion.toFixed(2)} · ${a.externalEdges} external`)}`,
        );
      }
    });
  applyGlobalOptions(areas);

  const oddities = program
    .command('oddities')
    .description('surprising cross-area links (architectural smells)')
    .option('-n, --limit <n>', 'how many to show', '20')
    .action(function (this: Command, opts: { limit?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const limit = Number(opts.limit) || 20;
      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      const list = graph.edges
        .filter((e) => typeof e.surprise === 'number' && e.surprise > 0)
        .sort((a, b) => (b.surprise ?? 0) - (a.surprise ?? 0) || a.id.localeCompare(b.id))
        .slice(0, limit);
      if (global.json) {
        json(
          list.map((e) => ({
            kind: e.kind,
            surprise: e.surprise,
            from: byId.get(e.src)?.qualifiedName ?? e.src,
            to: byId.get(e.dst)?.qualifiedName ?? e.dst,
          })),
        );
        return;
      }
      if (!list.length) {
        info(`${c.cyan('vg oddities')} · none found (no cross-area links, or only one area)`);
        return;
      }
      info(`${c.cyan('vg oddities')} · top ${list.length} surprising links`);
      for (const e of list) {
        const from = byId.get(e.src)?.qualifiedName ?? e.src;
        const to = byId.get(e.dst)?.qualifiedName ?? e.dst;
        info(`  ${pad((e.surprise ?? 0).toFixed(2), 5)}  ${c.bold(from)} ${c.dim(`—${e.kind}→`)} ${c.bold(to)}`);
      }
    });
  applyGlobalOptions(oddities);
}

function nodeSummary(n: GraphNode) {
  return {
    id: n.id,
    name: n.qualifiedName,
    kind: n.kind,
    file: n.file,
    line: n.span.start,
    importance: n.importance,
    isHub: n.isHub,
    area: n.area,
  };
}

function reportJson(graph: VgGraph) {
  return {
    counts: graph.meta.counts,
    languages: graph.meta.languages,
    cluster: graph.meta.cluster,
    areas: graph.areas.length,
    hubs: graph.nodes.filter((n) => n.isHub).length,
  };
}

function pad(s: string, n: number): string {
  return s.padStart(n, ' ');
}
