# Changelog

All notable changes to the Vibgrate CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This project versions its public releases using a date-based (CalVer)
`YYYY.MDD.PATCH` scheme for published builds, while honoring
[Semantic Versioning](https://semver.org/) intent for compatibility: breaking
changes are called out explicitly in release notes, and patch releases are
backward compatible.

## [Unreleased]

### Added

- **Vue/Svelte/Astro single-file components are now part of the code graph** —
  `.vue`, `.svelte`, and `.astro` files were previously invisible to the map,
  so `vg impact` (and every other navigation command) missed callers that live
  inside components. The script region of an SFC (`<script>`/`<script setup>`
  blocks, Astro frontmatter) is now extracted with a position-preserving mask
  and parsed with the JS/TS grammars, so defs, calls, and imports land on
  their true lines in the original file. Imports of `./Foo.vue`
  (extension-bearing or extensionless) resolve to the component, and imports
  from a component into plain `.ts`/`.js` modules resolve back — impact blast
  radius in Vue/Svelte/Astro apps now includes component usage sites.
- **Coverage expansion: Objective-C, OCaml, ReScript, Solidity, and template
  containers** — four more grammar-backed languages join the graph
  (`.m`/`.mm`, `.ml`/`.mli`, `.res`, `.sol`), with defs, calls (including ObjC
  message sends and Solidity `emit`s), imports, and inheritance extracted; and
  the SFC masking mechanism now also covers inline `<script>` blocks in plain
  HTML (`.html`/`.htm`), ERB templates (`.erb`, parsed as Ruby), and EJS
  templates (`.ejs`, parsed as JavaScript), all with true line numbers. Elm
  was evaluated but its prebuilt grammar predates the web-tree-sitter
  compatibility floor, so it is deliberately excluded for now.
- **Installed assistant instructions are versioned and self-updating** — the
  skill and nudge files `vg install` writes now carry a `vg:v<N>` marker, and
  every successful `vg` build brings previously-installed copies up to the
  current content version automatically (only files with vg's own marker or
  the exact legacy generated content are touched; removing the marker line
  opts a file out permanently, and nudge refreshes rewrite only the vg block
  inside CLAUDE.md/AGENTS.md). The instructions themselves now **strongly
  recommend the MCP tools over the CLI** — the warm server answers in
  milliseconds while each CLI call pays Node startup plus a fresh map parse —
  with the CLI positioned as the fallback when no server is available.
- **A terminal `vg serve` now shows the traffic of the assistant's own
  spawned server** — stdio MCP servers are launched by the client, so the
  serve process an operator watches in a terminal never receives the
  assistant's tool calls itself. Serve processes now share their live,
  counts-only session stats over an ephemeral per-process file under
  `.vibgrate/cache/serve-live/` (written by non-interactive serves, folded
  into the interactive display, swept on exit/staleness), and the dashboard
  notes how many assistant-spawned servers are online. Same privacy posture
  as the display itself: counts, tool names, and coarse client labels only —
  local, ephemeral, never uploaded.
- **The live `vg serve` status display now counts CLI calls too** — an agent
  that shells out to the CLI (`vg impact <name> --client=claude`) records into
  the local ledger from a separate process, which previously left the serve
  dashboard frozen at "waiting for your assistant's first tool call". The
  display now tails the ledger while serving and folds in CLI-sourced calls,
  with an mcp-vs-cli split in the header and honest avg-ms handling (CLI
  lines carry no wall time and are never counted as 0 ms). Counts only,
  in-process, nothing uploaded — same privacy posture as before.

- **Memory safeguards for the graph build** — a pathological corpus (a
  vendored 200 MB bundle, a million-file tree, a giant TypeScript program) can
  no longer OOM-kill `vg build` / `vg scan`. Files over a per-file size cap
  are skipped with a warning (they stay freshness-tracked, so auto-refresh
  never loops on them); a corpus file-count ceiling stops the build early with
  guidance instead of grinding toward a crash; the in-process TypeScript
  resolver — the largest single memory consumer — falls back to the heuristic
  rung past a TS/JS file cap; and a heap budget checked at phase boundaries
  turns an imminent, uncatchable V8 OOM into a catchable, actionable error
  (so a `scan --push` degrades to "map skipped" instead of dying). All limits
  are tunable via environment variables (`VG_MAX_FILE_BYTES`, `VG_MAX_FILES`,
  `VG_TSC_MAX_FILES`, `VG_MEMORY_BUDGET_MB`, `VG_JOBS`, `VG_WORKER_HEAP_MB`;
  `0` disables), documented under *Configuration → Resource safeguards* in
  DOCS.md. Skips are deterministic functions of the input, never of observed
  memory — identical input still yields a byte-identical `graph.json`.
- **Graph discovery now skips every package and lockfile surface the scanner
  skips** — the engine's walk previously pruned a much smaller directory set
  than the drift scanner, so dependency trees like `Pods/`, `deps/`,
  `bower_components/`, `.yarn/`, `DerivedData/` (and ~20 more) could be
  indexed as if they were first-party code. The graph's `SKIP_DIRS` is now a
  superset of the scanner's list, and a new `SKIP_FILES` set excludes
  lockfiles and generated dependency manifests (notably Yarn PnP's `.pnp.cjs`,
  which is JavaScript and could previously be parsed as a huge phantom
  module). A test asserts the graph's lists cover the scanner's, so the two
  walkers can never silently disagree about what is third-party.
- **`vg benchmark` now measures memory and throughput** — alongside the
  existing cold/incremental build times, determinism check, and token
  estimates, the benchmark reports peak RSS and peak heap sampled across the
  cold build, the heap retained by the loaded graph, serialized `graph.json`
  size and bytes-per-node, files/s and MB/s throughput, and the effective
  resource limits (`VG_MAX_FILE_BYTES` etc.) the run built under — all
  labelled approximate where GC timing makes them so. The graph artifact
  itself stays byte-deterministic; only the measurements of producing it vary.
- **The code map now keeps itself fresh** — `vg serve` (Vibgrate AI Context)
  and `vg ask` detect files that changed since the last build and rebuild the
  map incrementally before answering, so your AI always queries the code as it
  is now. The check is a cheap stat-only probe against a per-build freshness
  snapshot (no filesystem watcher, no daemon); touch-only changes such as a
  `git checkout` are recognized by content hash and never trigger a rebuild,
  and a rebuild whose corpus turns out unchanged leaves `graph.json`
  byte-identical (no git churn). Probes are debounced with a self-tuning
  cadence (2s floor, scaled to measured probe cost on large repos); rebuilds
  are single-flight and cross-process locked; `--no-refresh` (on `serve` and `ask`) opts out, and a
  custom `--graph` path implies it. `vg status` now reports exact per-file
  staleness (edits, adds, and removes) whenever a build has run on the machine,
  and `graph.json` is written atomically so a serving process can never read a
  half-written map.
- **Animated CLI demo in the README** — the "See it run" section now plays an
  animated terminal replay of `vg scan` (drift score, breakdown, and ranked
  priorities) directly on GitHub, so you can see the product before installing.
  The asset is a deterministic, regenerable SVG (`docs/demo/cli-demo.svg`,
  rebuilt with `pnpm demo:svg`).
- **`databaseSchema` extended scanner documented, capped, and now actually
  reaches Vibgrate Cloud** — the scanner (structural facts only, from Prisma/
  SQL migrations/`.sqlproj`/Drizzle/TypeORM; never a raw source line, query, or
  credential) is on by default and disabled per the [Database
  Schema](./DOCS.md#database-schema) docs via
  `scanners.databaseSchema.enabled: false`, same as any other extended
  scanner — it just wasn't written down before. Upload compaction now caps its
  models/fields/files (300 models, 100 fields/model, 5 files/model, 500
  scanned files) so a schema-heavy monorepo can't dominate the artifact
  payload the way uncapped scanners could. Separately, the server-side ingest
  schema was missing this field entirely, so `databaseSchema` was silently
  stripped on every `vg push` — the Cloud dashboard's database tab only ever
  had data for locally-viewed scans, never pushed ones. Both are fixed.

## [Initial public release] - 2026-06-25

The first public, Apache-2.0 release of the unified Vibgrate CLI. The command is
`vg`, with `vibgrate` as an alias — both run the same binary.

### Added

- **Deterministic code graph** — a no-API-key, fully local code graph with the
  `build`, `ask`, `show`, `impact`, `path`, `tree`, `hubs`, `areas`, and `map`
  verbs. The same input always produces the same `graph.json` via content-hashed
  IDs and stable sorting.
- **Vibgrate AI Context (local MCP server)** — `vg serve` exposes read-only
  tools so AI coding agents can query, over the Model Context Protocol, your code
  map, offline drift, local models, and version-correct library docs — all from
  your machine, reducing token cost versus dumping raw files.
- **Drift reporting** — `vg scan`, `vg report`, `vg baseline`, and `vg sbom` for
  tracking and reporting codebase and dependency drift.
- **Version-correct library documentation** — `vg lib` and `vg drift` inject
  documentation that matches the versions your project actually uses.
- **One-command agent install** — `vg install` sets up the CLI and MCP server
  across 21+ AI assistants.

[Unreleased]: https://github.com/vibgrate/cli/compare/v2026.625.0...HEAD
[Initial public release]: https://github.com/vibgrate/cli/releases/tag/v2026.625.0
