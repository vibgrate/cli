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
