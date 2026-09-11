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

- **Context compression reads its model facts from the scanning module.**
  Context windows, output caps, thinking/cache billing and per-1M-token list
  prices were a pair of hand-maintained tables inside the CLI, which meant a
  release every time a vendor shipped a model or changed a price — the pricing
  table still carried a "verified 2026-06" note that nothing enforced. They now
  live in one place, refreshed on a schedule, alongside the vendor catalog.

  Compression itself is unchanged and still needs no module: an id the catalog
  does not cover falls through to the same pattern inference and conservative
  128k default as before, and a price it does not carry falls to the blended
  rate. Those are the parts that stayed — they are logic, not data. The one
  rule the seam enforces is direction: a doubtful context limit is dropped
  rather than clamped, because reading a window too low only makes compression
  work harder, while reading it too high overflows the model and fails the
  request.

- **External Surface Inventory — every external service a repo talks to, in one
  place.** A scan now records the outbound APIs, AI models, MCP servers and SaaS
  it found — from dependency manifests, environment-variable *names*, config
  hosts and pinned API versions — grouped into eleven categories (AI &
  inference, MCP & agent tools, Payments, Auth / identity, Data stores,
  Messaging, Observability, Cloud / IaaS, Email / comms, Search / vectors, Other
  SaaS). `vg show surfaces` prints them from the stored scan artifact, with
  `--json`, `--category`, `--kind` and `--stale-only`; the same inventory drives
  the dashboard's tech-stack view and the External Surfaces tab in Vibgrate for
  VS Code.
- **Freshness verdicts for the models and API versions a repo pins.** A detected
  model or pinned API version is checked against the Vendor Surface Catalog and
  reads `current`, `behind`, `deprecated`, `retired` or `unverified`. Two rules
  hold everywhere: a `behind` is only ever claimed on a dated comparison against
  a vendor's current flagship, and anything the catalog does not cover reads
  `unverified` — never `current`. Retirements and deprecations come from vendor
  announcements read by a person, because a model roster cannot express one: a
  withdrawn model simply stops appearing in it, and an absence is not a
  statement. A deprecation carries the vendor's own shutdown date, so the answer
  is "stops working on 2026-10-23" rather than just "deprecated".
- **Surface scanning makes no network call.** The vendor catalog — the roster of
  what each vendor ships and the curated announcements — is compiled into the
  scanning module, so a scan returns identical verdicts online, offline and
  air-gapped, with no cache to go stale behind you and nothing to configure.
  There is no `--offline` switch for surfaces because there is nothing to turn
  off. The module's own version is the freshness signal, and a weekly job
  republishes it.
- **Detection never reads a secret.** URLs are reduced to their bare host,
  environment variables are matched on name only, and `.env` / `.env.local` are
  never opened. Nothing credential-shaped reaches the artifact.

- **Your own architecture rules: `[[overlay]]` tables in `.vibgrate/architecture.toml`
  (`vg.arch.policy.v1`).** An overlay attaches to the role and purpose the
  Architecture module discovered for a symbol, under an optional path prefix —
  never to a folder you drew. `deny` adds a finding named after your
  `team/…` or `org/…` id, `allow` drops a baked rule for one folder, `remap`
  changes a baked rule's severity. A `deny` with `severity = "hard"` fails
  `vg scan --fail-on architecture-finding` like a baked violation. An overlay
  that does not validate fails the build with every problem listed; the
  `policy` key keeps its warn-and-fall-back.
- **`vertical-v1`, a third policy pack** for vertical-slice code: a request
  handler owns its slice's reads and writes; the domain and the views must
  still stay pure. Needs an Architecture module published after the pack
  landed — an older module refuses the id and the map is judged under
  `hexagonal-v1`, which the `policy` line then says.
- **`vg build --init-policy`** writes a first draft of
  `.vibgrate/architecture.toml` from what the build classified (`layered-v1`
  when controllers, services and repositories dominate; `hexagonal-v1`
  otherwise; never `vertical-v1`), with the overlay tables as commented
  examples. It never overwrites an existing file.
- **`vg show <symbol>` prints `policy <pack>`** — plus the overlay ids, when
  any — as its own line above the boundary findings; `--json`, the LSP node
  payload and `vg show arch` carry the same `policy` and `overlays` fields.
  A reader no longer infers the pack from a rule id's prefix.

### Changed

- **`vg show chart` is now `vg show arch`.** The local interactive map of the
  code graph takes the Architecture module's public name — it is the map that
  paints roles, purposes and boundary-rule breaks from `graph.arch.json` when
  the module is loaded, and the raw graph when it is not. Same options
  (`--port`, `--host`, `--focus`, `--no-open`), same loopback server, same
  `/api/*` endpoints. `vg show chart` keeps working as a silent alias for one
  release and is no longer listed in `vg show --help`.

### Fixed

- **`vg show arch` clipped the map to a fixed viewport.** Columns that ran off the
  bottom of the window could not be scrolled or zoomed; the canvas is now a
  pannable, zoomable map (scroll or drag, pinch / Ctrl-scroll, + / −).

- **Context compression was a silent passthrough in the published build.** The
  listener, `vg savings --benchmark`, and the `vg code` tool-result compression
  bound their layers through a runtime-string dynamic import that the bundler
  could not follow, so the shipped `dist/` reported every layer as missing and
  forwarded requests untouched (0% saved) while the same code run from source
  compressed. The imports are now literal, the chunks ship, and a test keeps
  them that way.

### Added

- **`vg evidence push` sends the frozen manifests and the bundle's proof.**
  The push (`evidence-push-2`) now carries every frozen release — components,
  artefact digest, build id, and the `build` facts read from BuildKit — and,
  when `--result` points at a bundle directory, the DSSE envelope and RFC 3161
  token, so Vibgrate Cloud verifies the signature itself and records
  `intact` / `failed` / `absent` instead of trusting a flag. `--signed` is
  accepted and ignored. Bodies over the 10 MB limit drop component lists
  from the oldest releases first and say so; `--no-releases` omits the
  manifests. The terminal line reports what the server confirmed.

- **`vg evidence release` reads what BuildKit built.** A frozen release can now
  take its facts from the build rather than from typed-in values:
  `--buildkit-metadata <file>` reads the `docker buildx build --metadata-file`
  output for the image digest and build reference; `--provenance <file>` reads
  a SLSA provenance attestation (DSSE envelope, in-toto Statement, or bare
  predicate) for the source repository, commit, and base images; and
  `--image <ref>` asks Docker for the image digest, its
  `org.opencontainers.image.*` labels, and any attached provenance and SBOM
  attestations, using the attached SBOM as the manifest when `--from` is not
  given (`docker buildx imagetools inspect` contacts the registry when the
  reference is not present locally). `--from` also accepts SPDX documents and in-toto / DSSE SBOM
  attestations alongside CycloneDX and scan artifacts. The facts are stored
  under a new optional `build` block in the manifest; a `--digest` that
  contradicts the build is an error, and attestation signatures are recorded
  as `unverified` — vg carries no registry trust root.

- **Dockerfile `LABEL` instructions are in the code graph.** Each label becomes
  a `property` node (`dockerfile.label`) on the build stage that declares it,
  so `org.opencontainers.image.source`, `.revision`, `.version` and the like
  are facts on the stage rather than ignored text. Values are recorded as
  written; an unresolved `$ARG` stays an `$ARG`.

- **Context compression for AI coding agents — with no new commands.**
  `vg serve --compress` adds an Anthropic- and OpenAI-compatible listener
  (loopback by default, token-guarded off-loopback) to the local runtime you
  already start, shrinking tool output and older turns before they reach the
  model: a content router picks a compressor per block (JSON arrays, logs and
  build output, grep results, diffs, HTML, tables, config, AST-aware source
  code, extractive prose), byte-reversible folds run first, lossy compression
  only when it saves clearly more, and file reads and edits stay byte-exact.
  Every compressed block keeps its original in a short-TTL local store — the
  model can call `vg_retrieve`, and you can run `vg serve retrieve <hash>` with
  `--grep` / `--lines` / `--head` / `--tail` / `--json-path`. `cache` mode
  compresses only the newest turn so provider prompt caches keep hitting;
  `token` mode compresses everything eligible. Profiles `coding` (default),
  `balanced`, `aggressive`, `general`. Cross-turn dedup, stale-read lifecycle,
  optional thinking compaction, output-verbosity steering with a stratified
  holdout estimate, budget and rate limits, model routes, tool-schema
  compaction and deferral, and a Prometheus `/metrics` endpoint. Every knob is
  a documented `VG_*` variable (`vg serve config`; persisted with
  `vg serve config set`).
- **`vg install <agent> --compress` / `vg uninstall <agent>`** — route Claude
  Code, Codex, Cursor, Aider, Copilot (with `--login` device-flow sign-in),
  OpenCode, Cline, Continue, Goose, OpenHands, Gemini CLI, Kimi, Grok, Qwen,
  Crush, Amp, Droid, Kiro, Zed and VS Code through the listener: config edits
  with backups, per-process ownership so concurrent sessions never undo each
  other, and a byte-exact revert. `--compress-scope user` writes the home
  config instead of the repo. `vg serve --compress <agent>` is the
  per-session form — environment only, nothing written. `vg serve status`
  shows what is routed.
- **`vg code` compresses its own tool results** — bulky `run_command`,
  `search_code` and `web_fetch` output is compressed once on the way into the
  transcript instead of being re-billed on every later step. Reads an edit is
  computed from, and failed results, are never touched (`VG_CODE_COMPRESS=0`
  turns it off).
- **`vg savings`** now reports context-compression savings — requests, tokens
  and estimated dollars for today / 7 days / 30 days, by model, client and
  project — alongside the grep-baseline figures; `--reset` clears the ledger
  and `--benchmark` measures the compressors on built-in fixtures.
  `vg show savings` opens the same numbers as a live local page.
- **`vg serve memory`** — project-scoped memory shared across agents (`list`,
  `search`, `add`, `delete`, `stats`, `export`, `import`), injected by the
  listener and exposed as `memory_search` / `memory_save` with
  `vg serve --memory`.
- **`vg install <agent> --learn`** — scans your past agent sessions (Claude
  Code, Codex, Gemini CLI, Grok, OpenCode, Cursor, Copilot, Aider) for repeated
  failures, loops and missing context, and writes guardrails into the
  assistant's instructions file between `<!-- vg:learn:begin -->` /
  `<!-- vg:learn:end -->` markers. Preview by default; `--apply` writes, and
  also saves the learned output-verbosity profile.
- **`vg serve compress [file|-]`** — the same pipeline offline over a chat
  transcript or a single tool output, as a debug path (`--lossless`,
  `--profile`, `--mode`, `--dry-run`, `--stats`, `--json`).
- **Vibgrate AI Context tools** `compress_content`, `retrieve_original`,
  `compression_stats` — answered from the compression layer, not the code map,
  and listed only under `vg serve --compress` so a default server does not
  spend schema tokens on them. They stay callable either way.
- **SDK**: `compress()`, `CompressionStore`, `withCompression()` for the
  Anthropic / OpenAI SDK client shapes, `compressionMiddleware()` for the Vercel
  AI SDK, `SharedContext` for multi-agent hand-offs, model registry and pricing.
- **`vg doctor`** reports the compression listener, retrievable store, memory and agent routing.
- **`vg hcs` — Holistic Code Specification command group** — `extract`,
  `digest`, `map`, `gate`, and `validate` over deterministic NDJSON fact
  streams. All HCS computation runs in the optional, separately-licensed
  engine module (`@vibgrate/hcs-engine`), auto-provisioned on first use or via
  `vg module install hcs`, executing in a local WASM sandbox (no network, no
  process spawns). `vg module` now manages both `relevance` and `hcs`.
- **Exit code `6` (`ENGINE_UNAVAILABLE`)** — a required optional module is not
  installed and could not be fetched. Deliberately distinct from `2`
  (`GATE_FAILED`) so CI can never read "engine missing" as a gate verdict.
- **`vg hcs extract` is incremental by default** — a run that writes over an
  existing stream (`-o`) re-extracts only added and changed files and reuses
  every unchanged fact byte-for-byte, so repeat runs cost the delta rather than
  the repository. The engine plans from the previous stream's file-hash index
  and merges the result, and output stays identical to a full extraction. Point
  `--previous <file>` at a separate state stream, or pass `--full` to
  re-extract everything (the merged output still refreshes the index, so the
  next run stays incremental).
- **`vg code` session power features** — `--worktree [id]` runs a session in an
  isolated git worktree under `.vibgrate/worktrees`, with `--worktree-diff`,
  `--worktree-apply` (`git apply --3way`), and `--worktree-remove` to inspect,
  land, or drop the delta; `--continue <id>` resumes a named session, not just
  the latest; `--reasoning-effort low|medium|high` drives the thinking budget
  on models that expose the knob; `--security-tier` selects shell isolation
  (`L0` host, `L1` Seatbelt/bubblewrap where available); and
  `--stream-json --session` keeps one warm graph across turns for host UIs.

- **Change-scoped precise resolution (incremental tsc)** — the TypeScript
  checker rung now caches per-file results under a key covering the file's
  content, its transitive import closure, and the shard's ambient surface
  (`.d.ts` / `declare global` / tsconfig). A warm refresh re-runs the checker
  only for changed files and their reverse-dependency closure instead of the
  whole corpus: on a ~600-file repo, a single-file warm rebuild drops from
  ~6.0s to ~2.1s and a no-change rebuild to ~1.1s, with output byte-identical
  to a cold full rebuild (enforced by the mutation-corpus identity gate, which
  now also covers ambient-declaration edits). Disable with `--no-cache`.
- **ESM emitted-extension import resolution** — relative imports written
  against emitted files (`./x.js` for `x.ts`, `.mjs`→`.mts`, `.jsx`/`.cjs`
  likewise, the standard ESM-in-TypeScript style) now resolve to their source
  files in the heuristic rung. On ESM-style codebases this turns thousands of
  imports previously recorded as external into real file→file edges —
  sharper import graphs, and the dependency closures the incremental tsc
  cache keys on.

- **Global-store maps are now snapshot-only** — builds that write to the
  global application store (the default layout) skip the large pretty-JSON
  serialize entirely and write just the binary snapshot: ~1s faster XL builds
  and ~60% less disk per branch-keyed map. Everywhere a human or git can see
  the artifact — `vg share`, `VIBGRATE_GRAPH_IN_REPO=1`, an explicit
  `--graph` path — the canonical `graph.json` is still written exactly as
  before, and `vg bundle`/`vg export` materialize JSON from the snapshot on
  demand, so every sharing and interchange surface stays JSON. A stale
  `graph.json` left in the store by an older CLI is cleaned up so downgrades
  can never serve an outdated map.

- **Binary graph snapshot for fast loads** — builds now write a compact binary
  sidecar (`graph.snap`, MessagePack) beside `graph.json`, and every loader
  (`vg ask`/`show`/`impact`, `vg serve`, `vg code`) prefers it: ~2.6× faster
  cold graph loads and ~40% of the on-disk size on large maps, with a lower
  peak-memory load path. `graph.json` is unchanged and stays the canonical,
  committed, shareable artifact — the snapshot is a derived cache that is
  checksummed, invalidated automatically whenever `graph.json` changes (or the
  CLI version does), regenerated transparently on the next load (existing
  JSON-only map directories self-heal, no migration needed), and ignored by
  git alongside the other local artifacts.

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
- **The internal build suite now measures memory and throughput** — alongside
  the existing cold/incremental build times, determinism check, and token
  estimates, it reports peak RSS and peak heap sampled across the cold build,
  the heap retained by the loaded graph, serialized `graph.json` size and
  bytes-per-node, files/s and MB/s throughput, and the effective resource
  limits (`VG_MAX_FILE_BYTES` etc.) the run built under — all labelled
  approximate where GC timing makes them so. The graph artifact itself stays
  byte-deterministic; only the measurements of producing it vary. This is
  contributor tooling (`pnpm bench:suite`), not a `vg` subcommand — its
  figures are comparable before/after on one machine, never a public number.
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

### Fixed

- **`vg update` no longer hangs after "Re-published the code map into the
  restarted daemon."** — the post-update rewarm asked the freshly restarted
  daemon to build the repo's semantic index and *waited for it*, so on a large
  repo with a cold vector cache the command sat on the socket for minutes (up
  to the client's 10-minute timeout) with no output, and the only way out was
  Ctrl-C. The daemon does that work in its own process regardless, so the
  rewarm now just kicks the build (`wait: false`) and returns; it reports
  "Semantic index warm again" when the on-disk cache covered it, and says the
  index is rebuilding in the background otherwise.
- **`vg update` now verifies the daemon it restarts is actually on the new
  build** — while the install had the socket free, another client (typically a
  VS Code extension bundling an older engine, or a long-lived `vg serve`)
  could bind *its* older vgd first, and the update reported "Restarted the vgd
  daemon on the new version" against that stale process; the very next
  `vg update` then found a stale daemon again. Every background daemon start
  now checks the build on the socket after it answers ping, force-retires an
  older squatter and retries (bounded), and reports honestly when an old
  client keeps winning. On Windows the update also starts the daemon back up
  itself after having stopped it to free its files, instead of leaving the
  socket free for an older client to claim.
- **No more stray Node console windows on Windows** — children spawned by
  console-less processes (the vgd daemon's embedding worker and background
  rebuilds, plus the git/ripgrep/npm probes they run) each popped a visible
  blank `node.exe`/console window on the desktop; closing one killed the
  embedding worker with `STATUS_CONTROL_C_EXIT` (exit code 3221225786) and
  took semantic search down with it. All background child processes are now
  spawned with hidden consoles (`windowsHide`), and the daemon itself gets a
  windowless console its whole subtree inherits.
- **A failed semantic index heals itself** — a slot whose build died (for
  example the killed embedding worker above) stayed `failed` forever with
  `vg daemon status` repeating the same error, because nothing ever retried
  it. The daemon now schedules a bounded automatic rebuild while it still has
  crash budget, so one external kill no longer permanently degrades semantic
  search to lexical.
- **A plan limit no longer blocks the scan itself** — a limit reported by scan
  preflight (repository cap, scan credits, VM minutes) used to abort before the
  scan ran, so a workspace at its repository cap could not use `vg` at all. The
  limit only gates ingestion, so it now only gates the push: the CLI warns with
  the server's reason and the upgrade link, disables the upload, runs the full
  local scan, and repeats the warning after the results so it isn't lost in the
  output. `--strict` keeps the previous hard failure for CI. Removing the
  mid-run exit on this path also fixes a Windows libuv abort seen when exiting
  with the progress UI's handles still open.

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
