/**
 * Always-on bridge from local `vg serve` (Vibgrate AI Context) tools into the
 * VG Code agent tool list.
 *
 * External project MCP servers (`.mcp.json`, etc.) remain optional. The tools
 * shipped by the installed `vg` CLI — `search_symbols`, `query_graph`,
 * `impact_of`, `library_docs`, … — are available on every run without spawning
 * a separate MCP process: same handlers as stdio `vg serve`, in-process over
 * the session graph.
 *
 * Namespaced as `mcp__vibgrate__<tool>` so they sit next to third-party
 * `mcp__<server>__*` tools without collisions.
 */

import { TOOLS, type VgTool } from '../mcp/tools.js';
import type { VgGraph } from '../schema.js';
import type { ToolCall, ToolSpec } from './types.js';
import type { ToolResult } from './tools.js';

export const VG_MCP_SERVER_ID = 'vibgrate' as const;
const NS = `mcp__${VG_MCP_SERVER_ID}__`;

/**
 * Agent-native names that must keep going to the VG Code tool set, not the
 * un-namespaced MCP alias. `library_docs` exists on both surfaces.
 */
const AGENT_RESERVED_NAMES = new Set(['library_docs']);

export type ExternalToolset = {
  specs: ToolSpec[];
  owns: (name: string) => boolean;
  execute: (call: ToolCall, live?: { graph: VgGraph }) => Promise<ToolResult>;
};

export interface VgBuiltinMcpOptions {
  /** Live graph accessor (session overlay may refresh symbols mid-run). */
  getGraph: () => VgGraph;
  root: string;
  /** Air-gap: no network in library/docs/embedder paths. */
  local?: boolean;
}

/** In-process toolset matching the local `vg serve` MCP surface. */
export function createVgBuiltinMcpTools(opts: VgBuiltinMcpOptions): ExternalToolset {
  const byName = new Map<string, VgTool>();
  for (const t of TOOLS) byName.set(`${NS}${t.name}`, t);

  const specs: ToolSpec[] = TOOLS.map((t) => ({
    name: `${NS}${t.name}`,
    description: `[${VG_MCP_SERVER_ID}] ${t.description}`,
    parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  })).sort((a, b) => a.name.localeCompare(b.name));

  /** Advertised name, or the bare MCP name Spark copies from AGENTS.md. */
  const resolveName = (name: string): string | undefined => {
    if (byName.has(name)) return name;
    const namespaced = name.startsWith(NS) ? name : `${NS}${name}`;
    if (namespaced !== name && byName.has(namespaced) && !AGENT_RESERVED_NAMES.has(name)) {
      return namespaced;
    }
    return undefined;
  };

  return {
    specs,
    owns: (name) => resolveName(name) != null,
    async execute(call, live) {
      const resolved = resolveName(call.name);
      const tool = resolved ? byName.get(resolved) : undefined;
      if (!tool) return { content: `unknown MCP tool ${call.name}`, mutated: false };
      try {
        const graph = live?.graph ?? opts.getGraph();
        const raw = await tool.handler(graph, call.arguments ?? {}, {
          root: opts.root,
          local: opts.local,
          dedup: false,
        });
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        return { content: text.slice(0, 12_000), mutated: false };
      } catch (e) {
        return { content: `MCP tool ${call.name} failed: ${(e as Error).message}`, mutated: false };
      }
    },
  };
}

/** Merge toolsets; later sets win on name clashes. */
export function mergeExternalToolsets(...sets: Array<ExternalToolset | undefined | null>): ExternalToolset | undefined {
  const active = sets.filter((s): s is ExternalToolset => !!s && s.specs.length > 0);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const byName = new Map<string, { set: ExternalToolset; spec: ToolSpec }>();
  for (const set of active) {
    for (const spec of set.specs) byName.set(spec.name, { set, spec });
  }
  const specs = [...byName.values()].map((v) => v.spec).sort((a, b) => a.name.localeCompare(b.name));
  return {
    specs,
    owns: (name) => active.some((s) => s.owns(name)),
    async execute(call, live) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i]!.owns(call.name)) return active[i]!.execute(call, live);
      }
      return { content: `unknown external tool ${call.name}`, mutated: false };
    },
  };
}

/** Namespaced vibgrate tool names for tests / prompts. */
export function vgMcpToolNames(): string[] {
  return TOOLS.map((t) => `${NS}${t.name}`);
}
