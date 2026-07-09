import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { GraphIndex, indexFor } from '../engine/relations.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { c, info, json } from '../util/output.js';
import type { GraphNode } from '../schema.js';

/**
 * `vg tree <name>` (VG-CLI-SPEC §2/§3) — the call tree rooted at a node
 * (callees by default; `--callers` to invert), depth-bounded and cycle-safe.
 */
export function registerTree(program: Command): void {
  const cmd = program
    .command('tree')
    .description('the call tree rooted at a node (callees; --callers to invert)')
    .argument('<name>', 'root node')
    .option('--callers', 'show callers instead of callees')
    .option('--depth <n>', 'max depth', '3')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .action(function (this: Command, name: string, opts: { callers?: boolean; depth?: string; pick?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);
      if (!node) throw ambiguityError(`"${name}" ${candidates.length ? 'is ambiguous' : 'not found'}`, candidates);

      const index = indexFor(graph);
      const maxDepth = Math.max(1, Number(opts.depth) || 3);
      const direction = opts.callers ? 'callers' : 'callees';
      // Record the call for the command-vs-MCP split when an AI identified itself.
      if (global.client) {
        recordCliCall(
          rootOf(global),
          { tool: CLI_TOOL_ALIASES.tree, client: global.client, outcome: 'complete' },
          Date.now(),
        );
      }

      if (global.json) {
        json(toJsonTree(index, node, direction, maxDepth, new Set()));
        return;
      }

      info(`${c.cyan('vg tree')} · ${direction} of ${c.bold(node.qualifiedName)} (depth ${maxDepth})`);
      const lines: string[] = [];
      walk(index, node, direction, maxDepth, 0, new Set(), lines, '');
      for (const l of lines) info(l);
    });
  applyGlobalOptions(cmd);
}

function next(index: GraphIndex, node: GraphNode, direction: 'callers' | 'callees'): GraphNode[] {
  const rel = direction === 'callees' ? index.callees(node.id) : index.callers(node.id);
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const { node: n } of rel) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out.sort((a, b) => b.importance - a.importance || a.qualifiedName.localeCompare(b.qualifiedName));
}

function walk(
  index: GraphIndex,
  node: GraphNode,
  direction: 'callers' | 'callees',
  maxDepth: number,
  depth: number,
  visited: Set<string>,
  lines: string[],
  prefix: string,
): void {
  if (depth === 0) lines.push(`${c.bold(node.qualifiedName)} ${c.dim(`(${node.kind})`)}`);
  if (depth >= maxDepth) return;
  if (visited.has(node.id)) {
    lines.push(`${prefix}${c.dim('↻ (cycle)')}`);
    return;
  }
  visited.add(node.id);
  const children = next(index, node, direction);
  children.forEach((child, i) => {
    const last = i === children.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const cyc = visited.has(child.id) ? c.dim(' ↻') : '';
    lines.push(`${prefix}${c.dim(branch)}${child.qualifiedName}${cyc}`);
    walk(index, child, direction, maxDepth, depth + 1, new Set(visited), lines, prefix + (last ? '   ' : c.dim('│  ')));
  });
}

function toJsonTree(
  index: GraphIndex,
  node: GraphNode,
  direction: 'callers' | 'callees',
  maxDepth: number,
  visited: Set<string>,
): unknown {
  if (maxDepth <= 0 || visited.has(node.id)) {
    return { name: node.qualifiedName, kind: node.kind, cycle: visited.has(node.id) };
  }
  const nextVisited = new Set(visited).add(node.id);
  return {
    name: node.qualifiedName,
    kind: node.kind,
    children: next(index, node, direction).map((child) =>
      toJsonTree(index, child, direction, maxDepth - 1, nextVisited),
    ),
  };
}
