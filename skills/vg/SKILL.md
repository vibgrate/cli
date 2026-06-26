---
name: vg
description: Query the local code graph (vg) for structure, impact, and navigation instead of grepping/reading many files.
---

# vg — the code map

This repo has a deterministic code graph built by `vg`. Prefer it over reading or
grepping many files — it is smaller, more relevant context, and free.

## When to use it

- **Understand code:** `vg "<question>"` returns a budget-bounded, fact-annotated
  context block. Start here instead of opening files blindly.
- **Find a symbol:** `vg show <name>` — what it is, what it calls, what calls it.
- **Before changing something:** `vg impact <name>` — what breaks if you change it.
- **Navigate:** `vg path <A> <B>`, `vg tree <name>`, `vg hubs`, `vg areas`.

## Dependencies & library docs

- **Upgrade drift:** `vg drift` lists what is outdated across dependencies
  (offline; `--online` for currency). `vg scan` scores upgrade drift and
  `vg report` renders it (text | json | sarif | md).
- **Version-correct docs:** `vg lib <name>` returns drift-annotated, version-
  specific usage docs for a library — inject these instead of guessing an API.

## Via MCP

If the `vg` MCP server is registered, call its read-only tools directly:
`query_graph`, `get_node`, `impact_of`, `find_path`, `list_hubs`, `list_areas`,
`get_graph_summary`. They are side-effect-free and auto-approvable.

## Keep it fresh

Run `vg` after pulling or making structural changes. The map lives at
`.vibgrate/graph.json` and is deterministic (byte-identical across machines).

---

> This is the canonical reference copy. `vg install <assistant>` writes this skill
> into each assistant's expected location and registers the local MCP server. The
> source of truth is `src/install/content.ts`.
