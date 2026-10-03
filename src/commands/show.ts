import { Command } from 'commander';
import { resolveOne } from '../engine/lookup.js';
import { indexFor } from '../engine/relations.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { countTokens } from '../engine/tokens.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { ambiguityError } from './ambiguity.js';
import { c, info, json, out } from '../util/output.js';
import { CliError, ExitCode } from '../util/exit.js';
import { loadHaileProvider } from '../engine/haile/haile-provider.js';
import { buildExplainDoc } from '../review/explain-doc.js';
import { keepInScratchpad } from '../review/scratchpad.js';
import { registerShowScratchpad } from './show-scratchpad.js';
import { renderReviewDocMarkdown } from '../review/doc.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { findHaileSymbol, formatHaileLines, haileJsonFields, readHaileSidecar } from '../engine/haile/index.js';
import { registerShowArch } from './arch.js';
import { registerShowSavings } from './show-savings.js';
import { registerShowSurfaces } from './show-surfaces.js';
import { registerShowFlow } from './show-flow.js';

/**
 * `vg show <name>` (VG-CLI-SPEC §3.3) — the richest single-node view: what it
 * is, its callers and callees and other edges, its area and importance.
 * `vg show arch` opens the local interactive architecture map of the same graph;
 * `vg show savings` opens the local page for what compression saved;
 * `vg show surfaces` lists the external services, models and MCP servers the
 * last scan found. `vg show <name> --diagram` explains the node with pinned
 * diagrams instead (review/explain-doc.ts).
 */
export function registerShow(program: Command): void {
  const cmd = program
    .command('show')
    .description('explain a node: what it is, what it calls, what calls it — or open the code map');

  registerShowArch(cmd);
  registerShowSavings(cmd);
  registerShowSurfaces(cmd);
  registerShowFlow(cmd);
  registerShowScratchpad(cmd);

  cmd
    .argument('<name>', 'qualified name, short name, file:line, glob, or id')
    .option('--pick <n>', 'pick the nth candidate when ambiguous')
    .option('--diagram', 'explain it with pinned diagrams: how it is reached, its flow, the data it reads and writes, where it sits (needs the Architecture module)')
    .option('--format <fmt>', 'with --diagram: output format (md | json)', 'md')
    .option('--keep', 'with --diagram: also keep it on top of the explain scratchpad (`vg show scratchpad`)')
    .action(async function (this: Command, name: string, opts: { pick?: string; diagram?: boolean; format: string; keep?: boolean }) {
      const global = readGlobal(this);
      const { root, graph } = requireGraph(global);
      const { node, candidates } = resolveOne(graph, name, opts.pick ? Number(opts.pick) : undefined);

      if (!node) {
        if (candidates.length === 0) {
          throw ambiguityError(`no node matches "${name}"`, []);
        }
        throw ambiguityError(`"${name}" is ambiguous`, candidates);
      }

      if (opts.diagram) {
        if (opts.format !== 'md' && opts.format !== 'json') {
          throw new CliError('unknown --format (expected md | json)', ExitCode.USAGE_ERROR);
        }
        const { doc } = buildExplainDoc({ root, graph, node, graphPath: global.graph, provider: await loadHaileProvider() });
        if (opts.keep) keepInScratchpad(root, doc);
        const asJson = Boolean(global.json) || opts.format === 'json';
        out(asJson ? JSON.stringify(doc, null, 2) : renderReviewDocMarkdown(doc).replace(/\n$/, ''));
        return;
      }

      const index = indexFor(graph);
      const callees = dedupe(index.callees(node.id).map((x) => x.node));
      const callers = dedupe(index.callers(node.id).map((x) => x.node));
      const extendsEdges = index.out(node.id, 'extends').concat(index.out(node.id, 'implements'));
      const supertypes = extendsEdges.map((e) => index.node(e.dst)?.qualifiedName).filter(Boolean);
      const area = graph.areas.find((a) => a.id === node.area);
      const sidecar = readHaileSidecar(resolveGraphPath(root, global.graph), {
        corpusHash: graph.provenance?.corpusHash,
      });
      const haile = findHaileSymbol(sidecar, node.id);
      // The pack (and any user overlays) the findings were judged under — a
      // reader must never have to infer it from a rule id's prefix.
      const archOpts = { policy: sidecar?.policy ?? null, overlays: sidecar?.overlays ?? null };

      // `show` is the CLI twin of the MCP `get_node` tool — record it under that
      // shared name (source `cli`) when an AI host identified itself. Baseline =
      // the node's file plus each caller/callee file a grep/read agent would open.
      if (global.client) {
        const files = new Set<string>([node.file]);
        for (const n of [...callees, ...callers]) if (n.file) files.add(n.file);
        const shown =
          node.qualifiedName +
          (node.signature ?? '') +
          callees.map((n) => n.qualifiedName).join('') +
          callers.map((n) => n.qualifiedName).join('');
        recordCliCall(
          rootOf(global),
          {
            tool: CLI_TOOL_ALIASES.show,
            client: global.client,
            outcome: 'complete',
            vgTokens: countTokens(shown),
            baselineFiles: files.size,
          },
          Date.now(),
        );
      }

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
          arch: haileJsonFields(haile, archOpts) ?? null,
        });
        return;
      }

      info(`${c.cyan(node.qualifiedName)}  ${c.dim(`(${node.kind})`)}`);
      info(`  ${c.dim(`${node.file}:${node.span.start}`)}`);
      if (node.signature) info(`  ${c.bold(node.signature)}`);
      info(
        `  importance ${node.importance.toFixed(3)}${node.isHub ? c.yellow(' ★ hub') : ''} · area #${node.area}${area ? ` ${c.dim(area.label)}` : ''}`,
      );
      if (haile) {
        for (const line of formatHaileLines(haile, archOpts)) info(line);
      }
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
