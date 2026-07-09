---
name: vg
description: Query the local code graph (vg) for structure, impact, and navigation instead of grepping/reading many files.
---

# vg — the code map

This repo has a deterministic code graph built by `vg`. Prefer it over reading or
grepping many files — it is smaller, more relevant context, and free.

## Prefer the MCP tools

If the `vg` MCP server is registered (it is after `vg install`), call its
read-only tools directly — they are the **fastest** path. The server keeps the
map parsed, the relation index warm, and the embedding model loaded across calls,
so each query is cheaper than spawning the CLI fresh. Use:
`query_graph`, `get_node`, `impact_of`, `find_path`, `list_hubs`, `list_areas`,
`get_graph_summary`, `search_symbols`. They are side-effect-free and
auto-approvable, and the server records which client is calling automatically.

## If you use the `vg` CLI instead

When the MCP server isn't available, use the CLI — and **always pass
`--client=<your-ai>`** so your calls are counted (that's how the CLI-vs-MCP split
is measured and the tools improved):

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
