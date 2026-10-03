import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { callPath, describeHops, pathDisconnect, shortestPath } from '../engine/paths.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json, out } from '../util/output.js';
import { buildPathDoc, ExplainEmpty } from '../review/explain-doc.js';
import { renderReviewDocMarkdown } from '../review/doc.js';
import { keepInScratchpad } from '../review/scratchpad.js';

/**
 * `vg path <A> <B>` (VG-CLI-SPEC §4.1) — how A connects to B (shortest path).
 */
export function registerPath(program: Command): void {
  const cmd = program
    .command('path')
    .description('how A connects to B (shortest path; --calls follows call edges only)')
    .argument('<a>', 'source node')
    .argument('<b>', 'target node')
    .option('--pick-a <n>', 'pick the nth candidate for A when ambiguous')
    .option('--pick-b <n>', 'pick the nth candidate for B when ambiguous')
    .option('--calls', 'follow call edges only, and show the call-site line of each hop')
    .option('--diagram', 'draw the path as a pinned call path: each step linked to its code and each hop to the line that makes it')
    .option('--format <fmt>', 'with --diagram: output format (md | json)', 'md')
    .option('--keep', 'with --diagram: also keep it on top of the explain scratchpad (`vg show scratchpad`)')
    .action(function (this: Command, a: string, b: string, opts: { pickA?: string; pickB?: string; calls?: boolean; diagram?: boolean; format: string; keep?: boolean }) {
      const global = readGlobal(this);
      const { root, graph } = requireGraph(global);
      if (opts.diagram && opts.format !== 'md' && opts.format !== 'json') {
        throw new CliError('unknown --format (expected md | json)', ExitCode.USAGE_ERROR);
      }

      const ra = resolveOne(graph, a, opts.pickA ? Number(opts.pickA) : undefined);
      if (!ra.node) throw ambiguityError(`"${a}" ${ra.candidates.length ? 'is ambiguous' : 'not found'}`, ra.candidates, '--pick-a');
      const rb = resolveOne(graph, b, opts.pickB ? Number(opts.pickB) : undefined);
      if (!rb.node) throw ambiguityError(`"${b}" ${rb.candidates.length ? 'is ambiguous' : 'not found'}`, rb.candidates, '--pick-b');

      const result = opts.calls ? callPath(graph, ra.node.id, rb.node.id) : shortestPath(graph, ra.node.id, rb.node.id);
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
        const disc = pathDisconnect(graph, ra.node.id, rb.node.id);
        if (global.json) {
          // disc.from/to are neighborhood objects; keep names as the primary keys.
          json(disc);
          // Still a miss for CI/agents, but with structured neighbors for recovery.
          throw new CliError(
            `no path between ${ra.node.qualifiedName} and ${rb.node.qualifiedName}`,
            ExitCode.NOT_FOUND,
          );
        }
        info(`${c.cyan('vg path')} · no path between ${c.bold(disc.from.name)} and ${c.bold(disc.to.name)}`);
        printNeighborhood('from', disc.from);
        printNeighborhood('to', disc.to);
        info(c.dim(`  ${disc.hint}`));
        info(c.dim(`  try: vg show ${disc.from.name} · vg impact ${disc.from.name} · vg show ${disc.to.name}`));
        throw new CliError(
          `no path between ${ra.node.qualifiedName} and ${rb.node.qualifiedName}`,
          ExitCode.NOT_FOUND,
        );
      }

      if (opts.diagram) {
        try {
          const { doc } = buildPathDoc({ root, graph, path: result, callsOnly: Boolean(opts.calls) });
          if (opts.keep) keepInScratchpad(root, doc);
          out(Boolean(global.json) || opts.format === 'json' ? JSON.stringify(doc, null, 2) : renderReviewDocMarkdown(doc).replace(/\n$/, ''));
        } catch (err) {
          if (err instanceof ExplainEmpty) throw new CliError(err.message, ExitCode.NOT_FOUND);
          throw err;
        }
        return;
      }

      const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
      const names = result.ids.map((id) => byId.get(id)?.qualifiedName ?? id);
      const steps = describeHops(graph, result.ids, result.direction);

      if (global.json) {
        json({
          from: ra.node.qualifiedName,
          to: rb.node.qualifiedName,
          hops: names.length - 1,
          direction: result.direction,
          path: names,
          steps,
          ...(opts.calls ? { callsOnly: true } : {}),
        });
        return;
      }

      info(`${c.cyan('vg path')} · ${names.length - 1} hop(s)${opts.calls ? c.dim(' · calls only') : ''}${result.direction === 'reverse' ? c.dim(' (reverse)') : ''}`);
      if (!opts.calls) {
        info('  ' + names.map((n) => c.bold(n)).join(c.dim(' → ')));
        return;
      }
      info(`  ${c.bold(names[0])}`);
      for (const s of steps) {
        const where = s.line ? ` ${s.file ?? ''}:${s.line}` : '';
        const how = [s.awaited ? 'awaited' : null, s.resolution].filter(Boolean).join(', ');
        info(`  ${c.dim('→')} ${c.bold(s.to)}${c.dim(`  ${s.kind}${where} · ${how}`)}`);
      }
    });
  applyGlobalOptions(cmd);
}

function printNeighborhood(
  label: string,
  n: { name: string; calls: string[]; calledBy: string[]; imports: string[]; importedBy: string[] },
): void {
  const parts: string[] = [];
  if (n.calls.length) parts.push(`calls ${n.calls.join(', ')}`);
  if (n.calledBy.length) parts.push(`called by ${n.calledBy.join(', ')}`);
  if (n.imports.length) parts.push(`imports ${n.imports.join(', ')}`);
  if (n.importedBy.length) parts.push(`imported by ${n.importedBy.join(', ')}`);
  info(`  ${c.dim(label)} ${c.bold(n.name)}${parts.length ? c.dim(` · ${parts.join(' · ')}`) : c.dim(' · (no call/import neighbors)')}`);
}
