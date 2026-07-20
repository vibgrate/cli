/**
 * Shared, deterministic content for `vg install`: the skill body and the advisory
 * nudge. Posture is deliberately lighter-touch than Graphify — the nudge
 * *suggests* the graph as the faster path, never asserts "MANDATORY"
 * (VG-ASSISTANT-INSTALL §1). On small repos we say searching is fine.
 */

export const SKILL_MARKER = 'vg-graph-skill';
export const NUDGE_BEGIN = '<!-- vg:begin -->';
export const NUDGE_END = '<!-- vg:end -->';

/**
 * Version of the generated instruction content (skill + nudge). Bump on ANY
 * wording/structure change to those templates: files written by `vg install`
 * carry this number in an HTML-comment marker, and `vg` builds auto-refresh
 * installed copies whose marker is older (see registry.ts
 * refreshInstalledInstructions) — so evolved instructions reach existing
 * repos the first time a new CLI version builds there.
 *
 * History: v1 = the unversioned originals (detected by their headings);
 * v2 = versioned markers + the strong MCP-first recommendation.
 */
export const INSTALL_CONTENT_VERSION = 2;

const VERSION_MARKER_RE = /<!--\s*vg:v(\d+)\b[^>]*-->/;

/** The marker line embedded in every generated instruction file. */
export function versionMarker(): string {
  return `<!-- vg:v${INSTALL_CONTENT_VERSION} · managed by \`vg install\` — auto-refreshed when these instructions evolve; remove this line to opt out -->`;
}

/**
 * The content version a previously-written instruction file carries, or null
 * when it has no marker (pre-versioning installs, or user-authored files).
 */
export function installedContentVersion(text: string): number | null {
  const m = VERSION_MARKER_RE.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The `--client` value the skill/nudge tells the assistant to pass to `vg` so its
 * CLI calls are attributed. `vg install <assistant>` passes the assistant id
 * (e.g. `claude`, `cursor`); the canonical reference copy uses a placeholder.
 */
function clientFlag(client?: string): string {
  return client ? `--client=${client}` : '--client=<your-ai>';
}

export function skillMarkdown(client?: string): string {
  const cf = clientFlag(client);
  return `---
name: vg
description: Query the local code graph (vg) for structure, impact, and navigation instead of grepping/reading many files.
---

${versionMarker()}

# vg — the code map

This repo has a deterministic code graph built by \`vg\`. Prefer it over reading or
grepping many files — it is smaller, more relevant context, and free.

## Use the MCP tools — not the CLI

When the \`vg\` MCP server is registered (it is after \`vg install\`), **always call
its read-only tools instead of shelling out to the CLI.** The server keeps the
map parsed, the relation index warm, and the embedding model loaded across
calls, so an MCP call answers in milliseconds — while every CLI invocation pays
Node startup plus a fresh map parse, hundreds of times more. Tools:
\`query_graph\`, \`get_node\`, \`impact_of\`, \`find_path\`, \`list_hubs\`, \`list_areas\`,
\`get_graph_summary\`, \`search_symbols\`. They are side-effect-free and
auto-approvable, and the server records which client is calling automatically.
Reach for the CLI only when the MCP server is genuinely unavailable — never as
the first resort.

## CLI fallback — only when the MCP server is unavailable

If (and only if) no \`vg\` MCP server is available, use the CLI — and **always
pass \`${cf}\`** so your calls are counted (that's how the CLI-vs-MCP split is
measured and the tools improved):

- **Understand code:** \`vg "<question>" ${cf}\` — a budget-bounded, fact-annotated context block.
- **Find a symbol:** \`vg show <name> ${cf}\` — what it is, what it calls, what calls it.
- **Before changing something:** \`vg impact <name> ${cf}\` — what breaks if you change it.
- **Navigate:** \`vg path <A> <B> ${cf}\`, \`vg tree <name> ${cf}\`.

## Dependencies & library docs

- **Upgrade drift:** \`vg drift\` lists what is outdated across dependencies
  (offline; \`--online\` for currency). \`vg scan\` scores upgrade drift and
  \`vg report\` renders it (text | json | sarif | md).
- **Version-correct docs:** \`vg lib <name>\` returns drift-annotated, version-
  specific usage docs for a library — inject these instead of guessing an API.

### Library-docs discipline

When a task needs a library's API, use the docs tools before web search or
training-data recall — they are official content matched to the version **this
project has installed**, and they win when the two conflict.

- **Workflow:** \`resolve_library\` once per library, then \`library_docs\` with the
  returned \`targetId\` and a focused query (good: "zod refine custom error
  message"; bad: "zod"). Never guess a targetId.
- **Budget:** at most **3 docs calls per task**. If 2 \`library_docs\` calls have
  not surfaced the section you need, read the package source under
  \`node_modules\` instead of searching again.
- **Skip the docs tools** for language built-ins, stable well-known syntax, or
  an API already shown in the current context — they add nothing there.

## Keep it fresh

The map keeps itself fresh: \`vg ask\` and the MCP tools detect changed files
and rebuild it incrementally before answering — you can edit code and query
immediately. Running \`vg\` after a large pull still warms everything in one go.
The map lives at \`.vibgrate/graph.json\` and is deterministic (byte-identical
across machines).
`;
}

export function nudgeMarkdown(smallRepo: boolean, client?: string): string {
  const cf = clientFlag(client);
  if (smallRepo) {
    return `${NUDGE_BEGIN}
${versionMarker()}
## Code navigation (vg)

This repo is small enough that searching files directly is fine. Still, before a
change, the \`vg\` graph shows what breaks: use the \`vg\` MCP tools when the server
is registered (\`impact_of\`, \`query_graph\` — the warm server answers far faster
than spawning the CLI). Only without the server, fall back to the CLI and pass
\`${cf}\` so the call is counted: \`vg impact <name> ${cf}\`,
\`vg "<question>" ${cf}\`.
${NUDGE_END}`;
  }
  return `${NUDGE_BEGIN}
${versionMarker()}
## Code navigation (vg) — use the MCP tools first

A deterministic code graph is available. It is usually the faster, cheaper path
than reading or grepping many files. **When the \`vg\` MCP server is registered,
always use its tools** (\`query_graph\`, \`get_node\`, \`impact_of\`,
\`search_symbols\`, …) — the map, indexes, and embedding model stay warm across
calls, so they answer in milliseconds, while every CLI invocation pays Node
startup plus a fresh map parse. Fall back to the CLI only when the server is
unavailable, and then pass \`${cf}\` so the call is counted:

- \`vg "<question>" ${cf}\` — a compact, fact-annotated context block for a question.
- \`vg show <name> ${cf}\` — what a symbol is, its callers and callees.
- \`vg impact <name> ${cf}\` — what breaks if you change it.

This is advisory, not mandatory — remove it with \`vg uninstall\` (or delete this
block).
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
