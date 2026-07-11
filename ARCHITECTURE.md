# Architecture

This document maps the `src/` tree, explains how data flows through the tool,
and describes how contributors add a language or a command. The guiding
principle throughout is **determinism**: identical input must always produce
identical output.

## Overview

The Vibgrate CLI (`vg`, alias `vibgrate`) turns a codebase into a deterministic
**code graph** and serves that graph to humans and AI coding agents. There are
five surfaces:

1. A deterministic, no-API-key **[code graph](https://vibgrate.com/graph)** (`build`/`ask`/`show`/`impact`/
   `path`/`tree`/`hubs`/`areas`/`map`).
2. A local, read-only **MCP server** (`vg serve`, [Vibgrate AI Context](https://vibgrate.com/library)).
3. **Drift reporting** (`vg scan`/`report`/`baseline`/`sbom`) — see [DriftScore](https://vibgrate.com/driftscore).
4. Version-correct **library documentation** injection (`vg lib`/`vg drift`).
5. One-command **install** into 21+ AI assistants (`vg install`).

## Module map (`src/`)

```
src/
├── cli.ts            Entrypoint + bare-`vg` dispatch and argument parsing
├── cli-options.ts    Shared option/flag definitions
├── index.ts          Programmatic/library entrypoint (exported API)
├── schema.ts         Public types for the serialized graph and reports
├── version.ts        Version string
│
├── commands/         One handler per CLI verb
│   ├── build.ts          Build the code graph from a directory
│   ├── ask.ts            Natural-language query over the graph
│   ├── show.ts           Show a node and its relations
│   ├── impact.ts         Blast-radius / impact analysis
│   ├── path.ts           Shortest path between two symbols
│   ├── tree.ts           Hierarchical view (modules/areas)
│   ├── serve.ts          Start the local MCP server
│   ├── install.ts        Install into AI assistants
│   ├── lib.ts, drift.ts  Version-correct library docs + drift
│   ├── export.ts, bundle.ts, share.ts, push.ts, embed.ts
│   ├── facts.ts, insights.ts, status.ts, verify.ts, tests.ts
│   └── ...
│
├── engine/           The deterministic parse → resolve → analyze pipeline
│   ├── discover.ts       Walk the project, select files (stable order)
│   ├── languages.ts      Language registry: extensions → grammar → node types
│   ├── grammars.ts       Load tree-sitter WASM grammars from grammars/
│   ├── parse.ts          Parse a file into an AST
│   ├── parse-worker.ts   Worker entry: parse files off the main thread
│   ├── pool.ts           Worker pool that drives parse-worker.ts
│   ├── resolve.ts        Resolve symbols/imports into graph edges
│   ├── module-resolver.ts, ts-resolver.ts   Module resolution
│   ├── relations.ts      Build typed relations between nodes
│   ├── analyze.ts        Higher-level analysis (hubs, areas, etc.)
│   ├── hash.ts, ids.ts   Content hashing and stable, content-derived IDs
│   ├── rng.ts            Seeded RNG (no nondeterministic randomness)
│   ├── serialize.ts      Stable serialization to graph.json
│   ├── load.ts           Load graph.json back into memory
│   ├── query.ts, queries.ts, lookup.ts, test-query.ts   Query layer
│   ├── impact.ts, paths.ts                              Graph algorithms
│   ├── cache.ts, artifacts.ts                           On-disk artifacts
│   ├── graph-model.ts, types.ts                         Core data model
│   └── lib.ts, drift.ts, report.ts, coverage.ts, scip.ts, ...
│
├── mcp/              Local MCP server
│   ├── server.ts         Server wiring (stdio transport)
│   └── tools.ts          Read-only tool definitions over the graph
│
├── install/          AI-assistant install registry
│   ├── registry.ts       The 21+ supported assistants and their config shapes
│   └── content.ts        Generated config/snippets written during install
│
├── grounding/        Context packing for agents
│   └── pack.ts           Assemble compact, token-efficient context
│
├── reporting/        Drift-reporting commands (on @vibgrate/core-open)
│   ├── commands/         scan / report / baseline / sbom handlers
│   ├── scoring/          Drift scoring
│   ├── formatters/, ui/  Output rendering
│   ├── package-version-manifest.ts   Resolved dependency versions
│   ├── config.ts, credentials.ts, regions.ts, version.ts
│   └── utils/
│
└── util/             Shared helpers
    ├── output.ts, progress.ts, logo.ts, exit.ts
```

## Determinism

Determinism is a hard requirement, not a nice-to-have. The same source tree must
always yield byte-identical artifacts so that diffs, baselines, and caches are
meaningful.

- **Content-hashed IDs** — node and edge identifiers are derived from content via
  `engine/hash.ts` and `engine/ids.ts`, never from insertion order, memory
  addresses, or wall-clock time.
- **Stable sort everywhere** — files, nodes, edges, and report rows are sorted by
  stable keys before serialization (`engine/serialize.ts`). Never serialize
  unordered `Map`/`Set` iteration directly.
- **No ambient nondeterminism** — no `Date.now()`, no unseeded `Math.random()`
  (use `engine/rng.ts`), and no reliance on filesystem enumeration order
  (`engine/discover.ts` sorts).
- **Parallel but ordered** — the worker pool (`engine/pool.ts` +
  `engine/parse-worker.ts`) parses files concurrently for speed, then results are
  re-ordered deterministically before they enter the graph.

If you touch anything that ends up in `graph.json` or a report, add a test that
asserts stable output.

## Data flow

```
  vg build <dir>
      │
      ▼
  discover  ──►  parse (worker pool, tree-sitter WASM)  ──►  resolve  ──►  analyze
      │                                                                       │
      └──────────────────────────► stable serialize ◄────────────────────────┘
                                         │
                                         ▼
                                    graph.json
                                    /        \
                              query/CLI     MCP server (vg serve)
                          (ask/show/impact/   (read-only tools for
                           path/tree/...)      AI coding agents)
```

1. **build** discovers files, parses them via the worker pool using bundled
   tree-sitter WASM grammars, resolves symbols/imports into typed relations,
   runs analysis, and writes a stable `graph.json`.
2. **query** commands and the **MCP server** both load `graph.json` and answer
   questions against it — they do not re-parse the source.
3. **drift reporting** runs on top of `@vibgrate/core-open` and the resolved
   package-version manifest.

## How to add a language

1. Add the tree-sitter grammar and wire it into
   [`scripts/bundle-grammars.mjs`](./scripts/bundle-grammars.mjs) so the compiled
   `*.wasm` is copied into `grammars/` during `pnpm build`.
2. Register the language in [`src/engine/languages.ts`](./src/engine/languages.ts):
   map file extensions to the grammar, and declare which AST node types the
   analyzer should extract (definitions, references, imports).
3. If the language needs special module/symbol resolution, extend
   `src/engine/resolve.ts` / `src/engine/module-resolver.ts` (see
   `ts-resolver.ts` as a reference).
4. Add a fixture under `test/` and assert deterministic graph output.
5. Run `pnpm build && pnpm test`.

## How to add a command

1. Create a handler in `src/commands/<verb>.ts`. Keep it pure with respect to
   output: given the same graph it must print the same thing.
2. Register the verb and its flags in `src/cli.ts` (and
   `src/cli-options.ts` for shared options). The bare-`vg` dispatch lives in
   `cli.ts`.
3. Read from `graph.json` via the `engine/` query layer rather than re-parsing.
4. If the command produces machine output, route it through `src/util/output.ts`
   and keep the format stable and sorted.
5. To expose the command to agents, add a corresponding read-only tool in
   `src/mcp/tools.ts`.
6. Document the command in `README.md` / `DOCS.md`, add tests, and update
   `CHANGELOG.md`.
