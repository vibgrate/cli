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
    .option('--all', 'include framework/runtime externals (default: filter them out)')
    .action(function (this: Command, opts: { limit?: string; all?: boolean }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const limit = Number(opts.limit) || 20;
      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      const list = graph.edges
        .filter((e) => typeof e.surprise === 'number' && e.surprise > 0)
        .filter((e) => opts.all || !isFrameworkOddity(byId.get(e.src), byId.get(e.dst), e.kind))
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
        info(
          `${c.cyan('vg oddities')} · none found` +
            (opts.all
              ? ' (no cross-area links, or only one area)'
              : ' (no app-level surprises; try --all for framework links)'),
        );
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

/**
 * Framework/runtime imports are almost always cross-area by construction and
 * drown real architectural smells (import→react, import→vue, …). Default filter
 * drops edges whose source or target is an external package in this set, or any
 * external node on a pure `import` edge to a known framework.
 */
const FRAMEWORK_EXTERNALS = new Set([
  'react',
  'react-dom',
  'react-native',
  'vue',
  'vue-router',
  'svelte',
  'svelte/store',
  'next',
  'next/link',
  'next/router',
  'next/navigation',
  'nuxt',
  'angular',
  '@angular/core',
  '@angular/common',
  'preact',
  'solid-js',
  'express',
  'fastify',
  'koa',
  'hono',
  'rxjs',
  'lodash',
  'lodash-es',
  'underscore',
  'jquery',
  'axios',
  'node:fs',
  'node:path',
  'node:url',
  'node:http',
  'node:https',
  'fs',
  'path',
  'url',
  'http',
  'https',
  'crypto',
  'util',
  'stream',
  'events',
  'assert',
  'os',
  'child_process',
]);

/** Exported for unit tests — pure filter used by `vg oddities`. */
export function isFrameworkOddity(
  from: GraphNode | undefined,
  to: GraphNode | undefined,
  kind: string,
): boolean {
  // Only demote pure package imports to known frameworks/runtimes — never hide
  // app-to-app links just because a symbol is named like a library.
  if (kind !== 'import') return false;
  for (const n of [from, to]) {
    if (n?.kind === 'external' && isFrameworkName(n.qualifiedName || n.name)) return true;
  }
  return false;
}

/** Exported for unit tests. */
export function isFrameworkName(name: string): boolean {
  if (!name) return false;
  if (FRAMEWORK_EXTERNALS.has(name)) return true;
  // Scoped packages: @vue/runtime-dom, @react-navigation/native, …
  const base = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  if (FRAMEWORK_EXTERNALS.has(base)) return true;
  if (base.startsWith('react-') || base.startsWith('@types/react')) return true;
  if (base.startsWith('@vue/') || base.startsWith('@angular/') || base.startsWith('@sveltejs/')) {
    return true;
  }
  return false;
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
