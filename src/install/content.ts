/**
 * Shared, deterministic content for `vg install`: the skill body and the advisory
 * nudge. Posture is deliberately lighter-touch than Graphify — the nudge
 * *suggests* the graph as the faster path, never asserts "MANDATORY"
 * (VG-ASSISTANT-INSTALL §1). On small repos we say searching is fine.
 */

export const SKILL_MARKER = 'vg-graph-skill';
export const NUDGE_BEGIN = '<!-- vg:begin -->';
export const NUDGE_END = '<!-- vg:end -->';

export function skillMarkdown(): string {
  return `---
name: vg
description: Query the local code graph (vg) for structure, impact, and navigation instead of grepping/reading many files.
---

# vg — the code map

This repo has a deterministic code graph built by \`vg\`. Prefer it over reading or
grepping many files — it is smaller, more relevant context, and free.

## When to use it

- **Understand code:** \`vg "<question>"\` returns a budget-bounded, fact-annotated
  context block. Start here instead of opening files blindly.
- **Find a symbol:** \`vg show <name>\` — what it is, what it calls, what calls it.
- **Before changing something:** \`vg impact <name>\` — what breaks if you change it.
- **Navigate:** \`vg path <A> <B>\`, \`vg tree <name>\`, \`vg hubs\`, \`vg areas\`.

## Dependencies & library docs

- **Upgrade drift:** \`vg drift\` lists what is outdated across dependencies
  (offline; \`--online\` for currency). \`vg scan\` scores upgrade drift and
  \`vg report\` renders it (text | json | sarif | md).
- **Version-correct docs:** \`vg lib <name>\` returns drift-annotated, version-
  specific usage docs for a library — inject these instead of guessing an API.

## Via MCP

If the \`vg\` MCP server is registered, call its read-only tools directly:
\`query_graph\`, \`get_node\`, \`impact_of\`, \`find_path\`, \`list_hubs\`, \`list_areas\`,
\`get_graph_summary\`. They are side-effect-free and auto-approvable.

## Keep it fresh

The map keeps itself fresh: \`vg ask\` and the MCP tools detect changed files
and rebuild it incrementally before answering — you can edit code and query
immediately. Running \`vg\` after a large pull still warms everything in one go.
The map lives at \`.vibgrate/graph.json\` and is deterministic (byte-identical
across machines).
`;
}

export function nudgeMarkdown(smallRepo: boolean): string {
  if (smallRepo) {
    return `${NUDGE_BEGIN}
## Code navigation (vg)

This repo is small enough that searching files directly is fine. Still, before a
change, \`vg impact <name>\` shows what it breaks, and \`vg "<question>"\` gives a
compact, cited context block when you want one.
${NUDGE_END}`;
  }
  return `${NUDGE_BEGIN}
## Code navigation (vg) — prefer the map

A deterministic code graph is available. It is usually the faster, cheaper path
than reading or grepping many files:

- \`vg "<question>"\` — a compact, fact-annotated context block for a question.
- \`vg show <name>\` — what a symbol is, its callers and callees.
- \`vg impact <name>\` — what breaks if you change it.

Prefer these (or the \`vg\` MCP tools) before opening many files. This is advisory,
not mandatory — remove it with \`vg uninstall\` (or delete this block).
${NUDGE_END}`;
}

/** The MCP server entry registered for local stdio use. */
export function mcpServerEntry(launch: ServeLaunch = { command: 'vg', args: ['serve'] }): {
  command: string;
  args: string[];
} {
  return { command: launch.command, args: launch.args };
}

export interface ServeLaunch {
  command: string;
  args: string[];
  /** Human-readable explanation when the launch is not the plain `vg serve`. */
  note?: string;
}
