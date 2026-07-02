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
