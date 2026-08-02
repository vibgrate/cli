import * as fs from 'node:fs';
import { Command } from 'commander';
import { queryGraph } from '../engine/query.js';
import { parseGraph } from '../engine/serialize.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { loadGraphPreferIndex } from '../engine/index-db.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';

/**
 * `vg hook pre-tool-use` — the PreToolUse enrichment hook for assistant hosts
 * (Claude Code et al.): reads the host's hook payload from stdin, and when the
 * intercepted tool is a text/file search (Grep/Glob), answers with graph
 * context for the pattern via `hookSpecificOutput.additionalContext` — so the
 * host's own grep results arrive already annotated with where the symbols
 * live and what depends on them.
 *
 * Hard rules — a hook must never make the host worse:
 *  - NEVER blocks or modifies the tool call (no permissionDecision) — the
 *    grep still runs; vg only adds context.
 *  - Any problem (no graph, bad payload, no matches, ANY error) exits 0 with
 *    no output. Silence is the failure mode, not an error message.
 *  - Bounded: top matches only, lexical ranking only (the semantic model is
 *    never loaded here — hook latency budget beats ranking finesse).
 */

const MAX_HOOK_MATCHES = 5;
const MIN_PATTERN_CHARS = 3;

interface HookPayload {
  tool_name?: string;
  tool_input?: { pattern?: string; query?: string; path?: string };
}

/** Regex metacharacters stripped so a Grep pattern becomes a lexical query. */
export function patternToQuery(pattern: string): string {
  return pattern
    .replace(/\\[dwsbDWSB]/g, ' ')
    .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The additionalContext block for a payload, or null when there is nothing worth saying. */
export function hookContext(payloadText: string, root: string, graphOverride?: string): string | null {
  let payload: HookPayload;
  try {
    payload = JSON.parse(payloadText) as HookPayload;
  } catch {
    return null;
  }
  if (payload.tool_name !== 'Grep' && payload.tool_name !== 'Glob') return null;
  const raw = payload.tool_input?.pattern ?? payload.tool_input?.query ?? '';
  const query = patternToQuery(String(raw));
  if (query.length < MIN_PATTERN_CHARS) return null;

  const graphPath = resolveGraphPath(root, graphOverride);
  let graph;
  try {
    const preferred = loadGraphPreferIndex(root, graphPath);
    graph = preferred ? preferred.graph : parseGraph(fs.readFileSync(graphPath, 'utf8'));
  } catch {
    return null; // no map — stay silent, the grep proceeds unannotated
  }
  const result = queryGraph(graph, query, {});
  const matches = result.matches.slice(0, MAX_HOOK_MATCHES);
  if (!matches.length) return null;

  const lines = matches.map(
    (m) => `- \`${m.node.qualifiedName}\` (${m.node.kind}) — ${m.node.file}:${m.node.span.start}${m.node.isHub ? ' [hub — check impact_of before changing]' : ''}`,
  );
  return [
    `vg code map — symbols matching "${query}":`,
    ...lines,
    'These locations come from the deterministic code graph; prefer them over scanning the raw grep output.',
  ].join('\n');
}

export function registerHook(program: Command): void {
  const cmd = program
    .command('hook', { hidden: true })
    .description('assistant-host hook endpoints (wired by `vg install --hooks`)');
  const pre = cmd
    .command('pre-tool-use')
    .description('PreToolUse enrichment: annotate Grep/Glob calls with graph context (stdin: host hook payload)')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const root = rootOf(global);
      try {
        const stdin = fs.readFileSync(0, 'utf8');
        const context = hookContext(stdin, root, global.graph);
        if (context) {
          process.stdout.write(
            `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } })}\n`,
          );
        }
      } catch {
        /* silence is the failure mode — never break the host's tool call */
      }
    });
  applyGlobalOptions(pre);
  applyGlobalOptions(cmd);
}
