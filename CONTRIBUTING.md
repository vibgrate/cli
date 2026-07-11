# Contributing to Vibgrate CLI

Thanks for your interest in improving the Vibgrate CLI (`vg`). This is the
public, Apache-2.0 home of the tool ([product overview](https://vibgrate.com/cli)).
Contributions of all sizes are welcome —
bug reports, documentation fixes, new language grammars, and new commands.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

Requirements:

- **Node.js >= 22**
- **pnpm** (the repo is a pnpm workspace; use Corepack or install pnpm globally)

```bash
git clone https://github.com/vibgrate/cli.git
cd cli
pnpm install
pnpm build       # bundles tree-sitter grammars, then builds with tsup
pnpm test        # vitest
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
```

To run the CLI from source without building:

```bash
pnpm dev build .        # tsx src/cli.ts build .
pnpm dev ask "where is auth handled?"
```

Both `vg` and `vibgrate` invoke the same binary. `vg` is the canonical command
in all docs; please prefer it in examples and tests.

## How the code is organized

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map. In short:

- `src/cli.ts` — entrypoint and bare-`vg` dispatch
- `src/commands/` — the graph verbs (`build`, `ask`, `show`, `impact`, `path`,
  `tree`, etc.) and the install/serve/drift command handlers
- `src/engine/` — the deterministic parse → resolve → analyze pipeline, the
  parse-worker pool, and tree-sitter WASM grammar loading
- `src/mcp/` — the local, read-only MCP server (`vg serve`)
- `src/install/` — the AI-assistant install registry
- `src/reporting/` — the drift-reporting commands (`scan`, `report`, `baseline`,
  `sbom`), built on `@vibgrate/core-open`
- `src/grounding/`, `src/util/` — context packing and shared helpers

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Prefix each
commit with a type:

- `feat:` — a new user-facing capability
- `fix:` — a bug fix
- `docs:` — documentation only
- `chore:` — tooling, deps, refactors with no behavior change
- `test:`, `refactor:`, `perf:`, `ci:` are also fine

Example: `feat(engine): add Rust trait resolution`

## Pull request expectations

Before opening a PR, make sure:

- [ ] `pnpm test` passes
- [ ] `pnpm lint` is green
- [ ] `pnpm typecheck` is green
- [ ] Docs are updated if behavior changed
- [ ] **Determinism is preserved** — the same input must always produce the same
  `graph.json`. Do not introduce wall-clock time, unordered map/set iteration,
  random IDs, or filesystem-order dependence into any output. Use the
  content-hashed IDs and stable sorts already in `src/engine/`. If you add a
  test that builds a graph, assert on stable output.

Keep PRs focused. Smaller, single-purpose PRs are reviewed faster.

## Adding a tree-sitter language grammar

Language support is driven by bundled tree-sitter WASM grammars plus a registry
entry:

1. Add the grammar dependency and wire it into
   [`scripts/bundle-grammars.mjs`](./scripts/bundle-grammars.mjs), which copies
   the compiled `*.wasm` files into `grammars/`.
2. Register the language in [`src/engine/languages.ts`](./src/engine/languages.ts):
   file extensions, the grammar name, and the node types the analyzer should
   extract.
3. If the language needs custom symbol/import resolution, extend the relevant
   resolver in `src/engine/` (e.g. `module-resolver.ts`, `resolve.ts`).
4. Add a small fixture under `test/` and assert deterministic graph output.

Run `pnpm build` to re-bundle grammars, then `pnpm test`.

## Adding a command

See the "How to add a command" section in [ARCHITECTURE.md](./ARCHITECTURE.md).
Briefly: add a handler in `src/commands/`, register it in `src/cli.ts`, keep all
output deterministic, and document it in the README/DOCS.

## Developer Certificate of Origin (sign-off)

We require a DCO sign-off on every commit. This certifies you have the right to
submit the contribution under the project's Apache-2.0 license (see
<https://developercertificate.org>). Add a sign-off line with:

```bash
git commit -s -m "feat: add area summaries"
```

This appends:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an email you can be reached at. PRs without a sign-off
will be asked to amend.
