---
name: vg
description: Query the local code graph (vg) for structure, impact, and navigation instead of grepping/reading many files.
---

<!-- vg:v2 · managed by `vg install` — auto-refreshed when these instructions evolve; remove this line to opt out -->

# vg — the code map

This repo has a deterministic code graph built by `vg`. Prefer it over reading or
grepping many files — it is smaller, more relevant context, and free.

## Use the MCP tools — not the CLI

When the `vg` MCP server is registered (it is after `vg install`), **always call
its read-only tools instead of shelling out to the CLI.** The server keeps the
map parsed, the relation index warm, and the embedding model loaded across
calls, so an MCP call answers in milliseconds — while every CLI invocation pays
Node startup plus a fresh map parse, hundreds of times more. Tools:
`query_graph`, `get_node`, `impact_of`, `find_path`, `list_hubs`, `list_areas`,
`get_graph_summary`, `search_symbols`. They are side-effect-free and
auto-approvable, and the server records which client is calling automatically.
Reach for the CLI only when the MCP server is genuinely unavailable — never as
the first resort.

## CLI fallback — only when the MCP server is unavailable

If (and only if) no `vg` MCP server is available, use the CLI — and **always
pass `--client=<your-ai>`** so your calls are counted (that's how the CLI-vs-MCP split is
measured and the tools improved):

- **Understand code:** `vg "<question>" --client=<your-ai>` — a budget-bounded, fact-annotated context block.
- **Find a symbol:** `vg show <name> --client=<your-ai>` — what it is, what it calls, what calls it.
- **Before changing something:** `vg impact <name> --client=<your-ai>` — what breaks if you change it.
- **Navigate:** `vg path <A> <B> --client=<your-ai>`, `vg tree <name> --client=<your-ai>`.

## Dependencies & library docs

- **Upgrade drift:** `vg drift` lists what is outdated across dependencies
  (offline; `--online` for currency). `vg scan` scores upgrade drift and
  `vg report` renders it (text | json | sarif | md).
- **Version-correct docs:** `vg lib <name>` returns drift-annotated, version-
  specific usage docs for a library — inject these instead of guessing an API.

### Library-docs discipline

When a task needs a library's API, use the docs tools before web search or
training-data recall — they are official content matched to the version **this
project has installed**, and they win when the two conflict.

- **Workflow:** `resolve_library` once per library, then `library_docs` with the
  returned `targetId` and a focused query (good: "zod refine custom error
  message"; bad: "zod"). Never guess a targetId.
- **Budget:** at most **3 docs calls per task**. If 2 `library_docs` calls have
  not surfaced the section you need, read the package source under
  `node_modules` instead of searching again.
- **Skip the docs tools** for language built-ins, stable well-known syntax, or
  an API already shown in the current context — they add nothing there.

## Keep it fresh

The map keeps itself fresh: `vg ask` and the MCP tools detect changed files
and rebuild it incrementally before answering — you can edit code and query
immediately. Running `vg` after a large pull still warms everything in one go.
The map lives at `.vibgrate/graph.json` and is deterministic (byte-identical
across machines).

---

> This is the canonical reference copy. `vg install <assistant>` writes this skill
> into each assistant's expected location (substituting the assistant's own name
> for `<your-ai>` in the `--client` flag) and registers the local MCP server. The
> source of truth is `src/install/content.ts`.
