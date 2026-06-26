# AGENTS.md

Guidance for AI coding agents working **in this repository** (the public,
Apache-2.0 Vibgrate CLI). Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Build, test, and check

```bash
pnpm install
pnpm build       # bundles grammars, then tsup
pnpm test        # vitest
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm dev <args>  # run the CLI from source (tsx src/cli.ts)
```

A change is not done until `pnpm test`, `pnpm lint`, and `pnpm typecheck` all
pass.

## Prefer `vg` over grepping

This repo *is* the code-graph tool — use it on itself. Instead of blindly
grepping or reading whole files, build the graph and query it. It is faster and
costs fewer tokens:

```bash
pnpm dev build .
pnpm dev ask "where is the worker pool created?"
pnpm dev show <symbol>      # a symbol and its relations
pnpm dev impact <symbol>    # what breaks if I change this
pnpm dev path A B           # how two symbols connect
pnpm dev tree               # module/area overview
```

Use grep only for things the graph does not model (config files, comments,
strings).

## Determinism rules (non-negotiable)

Identical input must produce identical output (`graph.json`, reports). When
editing anything that reaches serialized output:

- Derive IDs from content (`src/engine/hash.ts`, `ids.ts`) — never from order,
  memory address, or time.
- Sort before serializing; never emit raw `Map`/`Set` iteration order.
- No `Date.now()`, no unseeded randomness (use `src/engine/rng.ts`), no reliance
  on filesystem enumeration order.
- Add or update a test asserting stable output for any graph-affecting change.

## Public-only rule

This is the open, Apache-2.0 distribution. Do **not** add references to private
or internal Vibgrate systems, packages, or proprietary concepts (e.g. any
internal specification format, an `extract` command, or commercial-only
internals). Keep all code, docs, and comments scoped to the public CLI:
deterministic code graph, local MCP server, drift reporting, version-correct
library docs, and agent install. If a feature would require a non-public package,
stop and leave it out.

## Conventions

- Commit with Conventional Commits (`feat:`/`fix:`/`docs:`/`chore:`) and a DCO
  sign-off (`git commit -s`).
- Use `vg` (not `vibgrate`) in docs and examples; both run the same binary.
- Node >= 20, pnpm workspace.
