# Vibgrate CLI — Full Documentation

> [Code Drift Intelligence](https://vibgrate.com/code-drift-intelligence) across ~19 ecosystems — Node, .NET, Python, Java, Go, Rust, and more

For a quick overview, see the [README](./README.md). This document covers everything in detail.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Choosing a rollout model: one-off vs CI](#choosing-a-rollout-model-one-off-vs-ci)
- [Commands Reference](#commands-reference)
  - [vg baseline](#vg-baseline)
  - [vg bisect](#vg-bisect)
  - [vg drift](#vg-drift)
  - [vg dsn create](#vg-dsn-create)
  - [vg fix](#vg-fix)
  - [vg init](#vg-init)
  - [vg login](#vg-login)
  - [vg logout](#vg-logout)
  - [vg push](#vg-push)
  - [vg report](#vg-report)
  - [vg sbom](#vg-sbom)
  - [vg scan](#vg-scan)
    - [Vulnerabilities and exposure attribution](#vulnerabilities-and-exposure-attribution)
  - [vg update](#vg-update)
  - [vg why](#vg-why)
- [Code Graph Commands](#code-graph-commands)
  - [vg ask](#vg-ask)
  - [vg benchmark](#vg-benchmark)
  - [vg build](#vg-build)
  - [vg bundle](#vg-bundle)
  - [vg embed](#vg-embed)
  - [vg export](#vg-export)
  - [vg facts](#vg-facts)
  - [vg guide](#vg-guide)
  - [vg impact](#vg-impact)
  - [vg install](#vg-install)
  - [vg lib](#vg-lib)
  - [vg map / vg hubs / vg areas / vg oddities](#vg-map--vg-hubs--vg-areas--vg-oddities)
  - [vg models](#vg-models)
  - [vg path](#vg-path)
  - [vg savings](#vg-savings)
  - [vg serve](#vg-serve)
  - [vg share](#vg-share)
  - [vg show](#vg-show)
  - [vg status](#vg-status)
  - [vg tests](#vg-tests)
  - [vg tree](#vg-tree)
  - [vg unknowns](#vg-unknowns)
- [DriftScore](#driftscore)
- [Drift Baselines & Fitness Functions](#drift-baselines--fitness-functions)
  - [How the Score Is Calculated](#how-the-score-is-calculated)
  - [Risk Levels](#risk-levels)
  - [Score Components](#score-components)
- [Output Formats](#output-formats)
  - [Text](#text)
  - [JSON Artifact](#json-artifact)
  - [SARIF](#sarif)
  - [Markdown](#markdown)
- [Configuration](#configuration)
  - [vibgrate.config.ts](#vibgrateconfigts)
  - [Thresholds](#thresholds)
  - [Scanner Toggles](#scanner-toggles)
- [Extended Scanners](#extended-scanners)
  - [Platform Matrix](#platform-matrix)
  - [Dependency Risk](#dependency-risk)
  - [Dependency Graph & Duplication](#dependency-graph--duplication)
  - [SBOM-ready Supply Chain Inventory](#sbom-ready-supply-chain-inventory)
  - [Tooling Inventory](#tooling-inventory)
  - [Build & Deploy Surface Area](#build--deploy-surface-area)
  - [TypeScript Modernity](#typescript-modernity)
  - [Breaking Change Exposure](#breaking-change-exposure)
  - [File Hotspots](#file-hotspots)
  - [Security Posture](#security-posture)
  - [Security Scanners](#security-scanners)
  - [Service Dependencies](#service-dependencies)
  - [Database Schema](#database-schema)
  - [Architecture Layers](#architecture-layers)
  - [Code Quality Metrics](#code-quality-metrics)
  - [OWASP Category Mapping](#owasp-category-mapping)
- [CI Integration](#ci-integration)
  - [GitHub Actions](#github-actions)
  - [Azure DevOps](#azure-devops)
  - [GitLab CI](#gitlab-ci)
  - [Generic Pipelines](#generic-pipelines)
- [Vibgrate Cloud Upload](#vibgrate-cloud-upload)
  - [DSN Tokens](#dsn-tokens)
  - [Data Residency](#data-residency)
- [Privacy & Security](#privacy--security)
- [Exit Codes](#exit-codes)
- [Programmatic API](#programmatic-api)

---

## How It Works

Vibgrate recursively scans your repository for `package.json` (Node/TypeScript), `.sln`/`.csproj` (.NET), Python manifests, and Java build manifests. For each project it discovers, it:

1. **Detects** the runtime version, target framework, and all dependencies
2. **Queries** the npm/NuGet registry for latest stable versions (with built-in caching and concurrency control)
3. **Computes** how far behind each component is — major version lag, EOL proximity, dependency age distribution
4. **Generates** a deterministic [DriftScore](https://vibgrate.com/driftscore) (0–100)
5. **Produces** findings, a full JSON artifact, and optional SARIF output

Core drift analysis does not execute source code. Optional security scanners can run lightweight secret heuristics and local toolchain checks. [Vibgrate Cloud](https://vibgrate.com/cloud) upload remains optional.

---

## Choosing a rollout model: one-off vs CI

Most teams adopt Vibgrate in two steps:

1. **One-off scan** to establish a baseline and identify immediate upgrade priorities.
2. **CI integration** to continuously detect drift regression on every pull request/build.

| Mode               | Benefits                                                                    | Typical command                                           |
| ------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| One-off scan       | Fast snapshot of current upgrade debt, useful for audits and planning       | `npx @vibgrate/cli scan`                                |
| CI-integrated scan | Continuous governance with automated failure thresholds and SARIF surfacing | `npx @vibgrate/cli scan --format sarif --fail-on error` |

In practice, one-off scans tell you where you are today; CI keeps you from drifting back tomorrow.

---

## Feature coverage and practical usage guide

This section summarizes what the CLI supports today and how to use each capability effectively.

### Supported project ecosystems

Vibgrate evaluates **upgrade drift** in depth for:

- **Node.js / TypeScript** (`package.json`, lockfiles)
- **.NET** (`.sln`, `.csproj`)
- **Python** (`requirements.txt`, `pyproject.toml`-style manifests)
- **Java** (`pom.xml`, Gradle-style manifests)

**Known-vulnerability detection** (`--vulns`) and **dependency attribution** (`vg why`, exposure windows) additionally cover npm / pnpm / yarn, pip / poetry / pipenv, cargo, composer, bundler, go, pub, hex, NuGet, and Maven/Gradle — read from each project's lockfile.

### End-to-end workflow (recommended)

1. Run an initial scan.
2. Save a baseline on your main branch.
3. Enforce drift gates in CI.
4. Export/report artifacts for stakeholders.

Example:

```bash
# Step 1: first scan
vg scan

# Step 2: baseline
vg baseline

# Step 3: policy in CI
vg scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error

# Step 4: produce report
vg report --in .vibgrate/scan_result.json --format md
```

Expected results:

- Teams get a stable score trend instead of one-time snapshots.
- CI fails early when drift budgets are exceeded (exit code `2`).
- Markdown/JSON/SARIF outputs are ready for engineering and governance workflows.

## Commands Reference

### vg baseline

Create a drift baseline snapshot for delta comparison.

```bash
vg baseline [path]
```

Runs a full scan and saves the result to `.vibgrate/baseline.json`. Use this as the starting point for tracking drift over time.

---

### vg bisect

Pinpoint the commit where a dependency crossed a version line. Where `vg why` narrates every version change, `vg bisect` answers one targeted question: *when did we cross this line?* — for example, when a vulnerable dependency was finally patched past the fixed version, or when a major was adopted.

```bash
vg bisect <package> <constraint>
```

`<constraint>` is a version or a semver range. A bare version means "reached or surpassed" — `vg bisect lodash 4.17.21` is the same as `vg bisect lodash '>=4.17.21'`. It reads the same lockfile history `vg why` uses (npm / pnpm / yarn, pip / poetry, cargo, composer, bundler, go, pub, hex, NuGet, and Maven/Gradle), offline and without checking out any commit.

It reports the commit that first reached the constraint — author, date, and the version before and after — or tells you the line was never crossed and shows the latest version in history (so an unadopted fix is obvious). Later flips, such as a downgrade that re-introduced the old version, are listed too.

Add `--assert` to turn it into a CI gate: the command exits non-zero when the current version does not satisfy the constraint, so a pipeline step can block a merge until the fix is adopted.

```bash
vg bisect lodash 4.17.21 --assert    # fails the build until lodash is patched to >= 4.17.21
```

Exit codes: `0` when the query resolves, `2` when `--assert` finds the constraint unsatisfied, `3` when the package has no version history, `5` for an invalid version or range.

---

### vg drift

What is outdated across your dependencies — a fast, offline currency check.

```bash
vg drift
```

Reads each project's lockfile and reports which dependencies have drifted behind their latest known version. Offline by default (uses the last-known catalog); add `--online` to check live registries for current latest versions.

| Flag | Description |
|------|-------------|
| `--online` | Check live registries for the latest versions instead of the offline catalog |
| `--fail-on <level>` | CI gate: exit non-zero when drift is found at this level (`major`, `minor`, or `standards`) |

Add `--json` for machine-readable output.

---

### vg dsn create

Generate an HMAC-signed DSN token for API authentication.

```bash
vg dsn create --workspace <id|new> [--region <region>] [--ingest <url>] [--write <path>]
```

| Flag          | Default    | Description                                                                 |
| ------------- | ---------- | --------------------------------------------------------------------------- |
| `--workspace` | _required_ | Your workspace ID, or `new` to auto-generate a workspace                    |
| `--region`    | `us`       | Data residency region (`us`, `eu`)                                          |
| `--ingest`    | —          | Custom ingest API URL (overrides `--region`)                                |
| `--write`     | —          | Write DSN to a file (add to `.gitignore`!)                                  |

When using `--workspace new`, the CLI auto-generates a workspace ID and provisions the DSN
with the Vibgrate API. Rate limited to 1 new DSN per 5 minutes per IP address.

---

### vg fix

Turn a drift scan into ranked, risk-tiered upgrade plans and **apply** the one
you choose — bringing packages up to date with confidence.

`vg fix` uses the hosted Vibgrate planner, so it needs a login: run `vg login`
(or set `VIBGRATE_DSN`). The CLI only measures your project locally — your source
never leaves your machine; only dependency versions and the aggregate usage
signals the planner needs are sent.

```bash
vg login                     # once, to authenticate
vg fix                       # analyse, then choose/apply a plan
vg fix --dry-run             # show exactly what would change, apply nothing
vg fix --plan safe --yes     # apply a specific plan non-interactively (CI)
vg fix --no-apply            # only print the plans
vg fix --format json         # machine-readable report for CI or an agent (no apply)
```

**Applying.** When there's more than one plan, `vg fix` shows them and asks which
to apply; with a single plan it applies it directly. Applying runs your project's
own package manager (pnpm/npm/yarn/bun, pip, cargo, go, composer, dotnet, dart, …)
to pin each target version — editing the manifest and installing in one step.
Ecosystems without a clean one-shot pin (e.g. Maven/Gradle) are reported for a
manual edit rather than skipped silently. Changes are local and git-reversible;
use `--dry-run` to preview, `--no-apply` to never touch the project, `--yes`/
`--plan` for non-interactive runs. `--format json`/`md` are report-only.

It reads the last scan artifact (`.vibgrate/scan_result.json`); if there isn't
one it runs a drift scan first, skipping the code map. Every drifted dependency —
across all supported ecosystems (npm, PyPI, Go, Cargo, Maven/Gradle, NuGet,
Composer, RubyGems, pub, Hex, …) — is sent to the planner, which builds three
plans and names the categorical best one:

- **Low-risk** — patch and minor updates only, limited to lightly-used packages
  with no breaking-change signals and no dependency conflicts.
- **Balanced** — the low-risk set plus single, clean major upgrades.
- **Full** — everything to latest stable, except upgrades that are mutually
  incompatible at those versions.

The analysis runs in two phases. A fast pass classifies every upgrade
(patch / minor / major) and measures its blast radius from how heavily the
package is used in your source. When major upgrades are involved it goes deeper:
it checks npm peer dependencies to find packages that **cannot** upgrade together
(e.g. `react-dom@18` needs `react@18`), scans the intervening releases for
breaking-change signals, and considers the API surface — the classes and
functions your code imports — that a new version must preserve.

Security is folded in with **real-world exploitability**. Each upgrade is checked
against [OSV](https://vibgrate.com/glossary/osv) in both directions (advisories **remediated** vs. **introduced**), and
current-version advisories are cross-referenced with the [**CISA KEV**](https://vibgrate.com/glossary/kev) (known-
exploited) list and [**FIRST EPSS**](https://vibgrate.com/glossary/epss) (exploit-probability) scores. A package with a
known-exploited advisory is treated as must-fix, so the recommendation prioritises
"fix these few" over churning everything. Advisories with no upgrade path in any
plan are called out as unresolved.

Each plan also shows an **expected DriftScore** — the estimated score after the
plan lands — so you can weigh drift-reduction payoff against risk (e.g. *Low-risk:
58 → 54; Full: 58 → 31*). Where a package has a known upgrade **playbook**, the
plan surfaces its codemod (e.g. `ng update`).

The recommendation is deterministic. When known-exploited or high/critical
advisories are open, `vg fix` recommends the lowest-risk plan that clears them —
so if a patch closes a critical CVE, that's the plan it points you to rather than
a sweeping major bump. With nothing severe outstanding, it prefers the least
disruptive plan.

| Flag | Meaning |
|---|---|
| `--format <text\|json\|md>` | Output format (default `text`; `json`/`md` are report-only, no apply). |
| `--in <file>` | Scan artifact to read (default `.vibgrate/scan_result.json`, resolved against the analysed path). |
| `--dsn <dsn>` | DSN token (or use `VIBGRATE_DSN` / `vg login`). |
| `--region <region>` | Override data residency region (`us`, `eu`). |
| `--plan <tier>` | Apply a specific plan non-interactively (`safe`/`balanced`/`aggressive`). |
| `--yes` | Apply the recommended plan without prompting. |
| `--dry-run` | Show what would change without applying. |
| `--no-apply` | Only print the plans; never modify the project. |
| `--repository-name <name>` | Override the repository name recorded for this plan. |
| `--fail-on-vulns <severity>` | Exit non-zero if the recommended plan leaves an advisory at or above this severity unresolved. |

Exit codes: `0` on success, `2` when `--fail-on-vulns` finds an unresolved
advisory at or above the threshold or an apply step fails.

---

### vg init

Initialise Vibgrate in a project.

```bash
vg init [path] [--baseline] [--yes]
```

| Flag         | Description                                 |
| ------------ | ------------------------------------------- |
| `--baseline` | Create an initial drift baseline after init |
| `--yes`      | Skip confirmation prompts                   |

Creates:

- `.vibgrate/` directory
- `vibgrate.config.ts` with sensible defaults

---

### vg login

Authenticate the CLI with your Vibgrate workspace through the browser. Credentials are stored locally so `vg fix` and `vg push` can reach the hosted planner and Vibgrate Cloud.

```bash
vg login
```

| Flag | Default | Description |
|------|---------|-------------|
| `--region <region>` | `us` | Data-residency region (`us`, `eu`) |
| `--ingest <url>` | — | Custom ingest API URL (overrides `--region`) |
| `--no-browser` | — | Print the URL to open instead of launching a browser (headless / SSH) |

---

### vg logout

Clear stored Vibgrate login credentials from this machine.

```bash
vg logout
```

---

### vg push

Upload scan results to the Vibgrate Cloud API.

```bash
vg push [--dsn <dsn>] [--file <file>] [--region <region>] [--strict]
```

| Flag       | Default                      | Description                                 |
| ---------- | ---------------------------- | ------------------------------------------- |
| `--dsn`    | `VIBGRATE_DSN` env           | DSN token for authentication                |
| `--file`   | `.vibgrate/scan_result.json` | Scan artifact to upload                     |
| `--region` | —                            | Override data residency region (`us`, `eu`) |
| `--strict` | —                            | Fail hard on upload errors                  |

Upload is always optional. Best-effort by default — use `--strict` in CI if you want the pipeline to fail on upload errors.

---

### vg report

Generate a human-readable report from a scan artifact.

```bash
vg report [--in <file>] [--format md|text|json]
```

| Flag       | Default                      | Description                            |
| ---------- | ---------------------------- | -------------------------------------- |
| `--in`     | `.vibgrate/scan_result.json` | Input artifact file                    |
| `--format` | `text`                       | Output format: `md`, `text`, or `json` |

---

### vg sbom

Export [SBOMs](https://vibgrate.com/glossary/sbom) from an existing scan artifact or compare two artifacts.

```bash
vg sbom export [--in <file>] [--format cyclonedx|spdx] [--out <file>]
vg sbom delta --from <file> --to <file> [--out <file>]
vg sbom vex [--from <file>] [--statement <json>...] [--product <ref>] [--out <file>]
```

| Command | Description |
|---------|-------------|
| `vg sbom export` | Emit CycloneDX or SPDX JSON from a scan artifact |
| `vg sbom delta` | Compare dependencies between two artifacts (added/removed/changed + drift delta) |
| `vg sbom vex` | Emit a spec-compliant OpenVEX document (exploitability statements) for attestation |

Use this to treat SBOMs as operational intelligence instead of static compliance output.

`vg sbom vex` is input-agnostic: it assembles a complete OpenVEX document from the statements you supply (`--from <file>` and/or repeatable `--statement`), so it works regardless of which scanner flagged the components. A zero-statement document is valid and honest — it asserts no known affected components.

---

### vg scan

The primary command. Scans your project for upgrade drift.

```bash
vg scan [path] [--vulns] [--full] [--format text|json|sarif|md] [--out <file>] [--fail-on warn|error] [--offline] [--package-manifest <file>] [--no-local-artifacts] [--max-privacy] [--baseline <file>] [--drift-budget <score>] [--drift-worsening <percent>] [--changed-only] [--concurrency <n>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--vulns` | — | Also detect known vulnerabilities (OSV online; offline via `--package-manifest` advisories) |
| `--full` | — | Comprehensive scan: enables `--vulns` and reports banned dependencies when a standards policy exists |
| `--format` | `text` | Output format: `text`, `json`, `sarif`, or `md` |
| `--out <file>` | — | Write output to a file |
| `--fail-on <level>` | — | Exit with code 2 if findings at this level exist |
| `--baseline <file>` | — | Compare against a previous baseline |
| `--changed-only` | — | Only scan changed files |
| `--concurrency <n>` | `8` | Max concurrent npm registry calls |
| `--drift-budget <score>` | — | Fitness gate: fail if drift score is above this budget |
| `--drift-worsening <percent>` | — | Fitness gate: fail if drift worsens by more than % vs baseline |
| `--push` | — | Upload scan artifact to Vibgrate Cloud after a successful scan |
| `--dsn <dsn>` | `VIBGRATE_DSN` env | DSN used for `--push` authentication |
| `--region <region>` | — | Override data residency (`us`, `eu`) during push |
| `--strict` | — | Fail scan command if push fails |
| `--ui-purpose` | — | Enable optional UI-purpose evidence extraction |
| `--offline` | — | Disable network calls and disable upload/push behavior |
| `--package-manifest <file>` | — | JSON or ZIP package-version manifest used for offline/latest lookups (latest bundle: `https://github.com/vibgrate/manifests/latest-packages.zip`) |
| `--no-local-artifacts` | — | Do not write `.vibgrate/*.json` scan artifacts to disk |
| `--max-privacy` | — | Hardened privacy mode with minimal scanners and no local artifacts |

By default, the scan writes `.vibgrate/scan_result.json`. Use `--no-local-artifacts` or `--max-privacy` to suppress local JSON artifact files.

For offline drift scoring, pass `--package-manifest <file>` with a downloaded manifest bundle such as `https://github.com/vibgrate/manifests/latest-packages.zip`.

Examples:

```bash
# Standard text scan
vg scan

# JSON output for automation
vg scan --format json --out scan.json

# CI gate with baseline regression protection
vg scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error

# Upload result in the same command
vg scan --push --strict
```

Expected results:

- Clear score/risk output in terminal (or JSON/SARIF when selected).
- Exit code `2` when configured quality gates are exceeded.
- When `--push` is enabled, artifact upload is attempted after scan completion.

---

### Vulnerabilities and exposure attribution

`vg scan --vulns` matches your installed dependencies against the public OSV database and records each known vulnerability — advisory id and CVE, severity, CVSS, and the fixing version — in the scan artifact, as findings, and in SARIF. Supply advisories in a `--package-manifest` bundle to run it offline.

In a git repository the scan also attributes each finding: the commit, author, and date that introduced the vulnerable version, and how long you have been exposed. These exposure windows aggregate into remediation metrics framed around the [EU Cyber Resilience Act (CRA)](https://vibgrate.com/compliance/cra): open counts by severity, mean and maximum time exposed, and per-severity SLA breaches (defaults: critical 7 days, high 30, moderate 90, low 180). The metrics are descriptive — they show whether remediation keeps pace; they are not a compliance certification.

The scan also reconstructs **closed** exposure windows from history — a vulnerable version that was later bumped out of the affected range or removed from the lockfile entirely — and reports real remediation time (MTTR) from them: measured, not estimated. Offline, a package-version manifest extends this to advisories that are fully fixed today, so a dependency that is clean now but was once vulnerable still counts toward your remediation record.

Detection and attribution read each project's lockfile, so they cover npm / pnpm / yarn, pip / poetry / pipenv, cargo, composer, bundler, go, pub, hex, NuGet, and Maven/Gradle.

```bash
# Online detection against OSV
vg scan --vulns

# Air-gapped: advisories supplied in the manifest bundle
vg scan --vulns --offline --package-manifest ./package-versions.zip

# Everything in one run: drift + vulnerabilities + a banned-dependency report
vg scan --full
```

---

### vg update

Check for and install updates.

```bash
vg update [--check] [--pm <manager>]
```

| Flag      | Description                                            |
| --------- | ------------------------------------------------------ |
| `--check` | Only check for updates, don't install                  |
| `--pm`    | Force a package manager (`npm`, `pnpm`, `yarn`, `bun`) |

---

### vg why

Explain a dependency from git history: who added it, every version since, and any open vulnerabilities it carries.

```bash
vg why <package>
```

`vg why` reads your lockfile's history, so it works across npm / pnpm / yarn, pip / poetry, cargo, composer, bundler, go, pub, hex, NuGet, and Maven/Gradle projects. For Maven/Gradle the history comes from a resolved `gradle.lockfile`, or a `pom.xml`'s pinned direct-dependency versions (versions managed by a BOM/`dependencyManagement` aren't resolved). Open vulnerabilities and their introduction attribution come from your most recent `vg scan --vulns`.

---

## Code Graph Commands

Vibgrate includes a full code graph engine — call trees, impact surfaces, semantic search, and AI Context serving. All graph commands read from (or write to) a local graph artifact at `.vibgrate/graph.json`. Build the map once with `vg build`, then query it offline indefinitely.

**Global options available on every graph command:**

| Flag | Description |
|------|-------------|
| `--cwd <dir>` | Working directory (default: current) |
| `--graph <file>` | Path to graph file (default: `.vibgrate/graph.json`) |
| `--json` | Machine-readable JSON output |
| `--quiet` | Suppress non-error output |
| `--local` | Offline mode — no network calls or downloads |
| `--client <name>` | Identify the AI client (e.g. `claude`) so navigation calls are counted in `vg savings` |
| `--deep` | Enable deep derivation (for `vg facts`, `vg build`) |
| `--no-cache` | Skip and clear cached data |

---

### vg ask

Ask the code map a question using hybrid lexical + structural + semantic search.

```bash
vg ask "<question>"
```

A local ONNX embedding model is downloaded once on first use, then cached and fully offline. Degrades gracefully to lexical-only under `--local` or `--no-semantic`.

> **Semantic search is opt-in.** The embedding backend (`fastembed`, which pulls a native ONNX runtime) is declared as an **optional dependency**: package managers install it by default, but if it's absent — e.g. you installed with `--omit=optional`, or it failed to build on your platform — `vg ask` and `vg embed` transparently fall back to lexical + structural search. Nothing else in the CLI needs it, so `vg build`, `vg show`, `vg impact`, drift reporting, and MCP serving all run without it. If you never use semantic `ask`, you can install lean: `npm i @vibgrate/cli --omit=optional`. A host application that bundles the CLI without optional dependencies (Vibgrate for VS Code does this) can supply the backend from its own directory by setting `VIBGRATE_EMBEDDER_PATH` to a folder whose `node_modules` contains `fastembed`; when set, that copy is used first.

Before answering, `ask` checks whether files changed since the map was last built and, if so, rebuilds it incrementally first (only the changed files re-parse) — so answers always reflect the code as it is now. The check is stat-based and costs almost nothing when nothing changed; `--no-refresh` opts out.

| Flag | Default | Description |
|------|---------|-------------|
| `<question...>` | — | Your question |
| `-b, --budget <n>` | `2000` | Approx token budget for returned context |
| `--no-semantic` | — | Lexical only; skip the local embedding pass |
| `--no-refresh` | — | Answer from the map as built; skip the auto-rebuild when files changed |

---

### vg benchmark

A reproducible build + memory + token-reduction benchmark for this repository — honest, self-measured estimates you can re-run.

```bash
vg benchmark
```

| Flag | Default | Description |
|------|---------|-------------|
| `--budget <n>` | `2000` | Approx token budget used when estimating context savings |

Add `--json` for machine-readable output.

---

### vg build

Build or update the code map incrementally.

```bash
vg build [paths...]
```

Maps source code into a graph artifact, enabling all downstream queries (`vg show`, `vg ask`, `vg impact`, etc.).

| Flag | Default | Description |
|------|---------|-------------|
| `[paths...]` | `.` | Folders or files to map |
| `--only <langs>` | — | Restrict to languages (e.g. `ts,py,go`) |
| `--exclude <glob>` | — | Extra ignore glob (repeatable) |
| `--jobs <n>` | auto | Worker count (`1` = single-threaded) |
| `--scip <file>` | auto-detect | Ingest a SCIP index for precise resolution |
| `--no-scip` | — | Ignore any SCIP index |
| `--no-tsc` | — | Skip the TypeScript resolver (heuristic floor only) |
| `--no-html` | — | Do not write `graph.html` |
| `--no-report` | — | Do not write `GRAPH_REPORT.md` |
| `--no-warm` | — | Do not warm the semantic index after building |
| `--grammars <dir>` | — | Grammar `.wasm` directory for offline/air-gapped use |
| `-o, --export <file>` | — | Also write the map to a file (format from extension) |

**Local by default — no git churn.** The first time vg writes into `.vibgrate/` it also creates `.vibgrate/.gitignore`, keeping the graph artifacts (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `facts.jsonl`, `mcp-navigation.json`) and the cache out of git — so builds, auto-refreshes, and MCP use never leave your branch dirty. Run `vg share` when you want the map committed for your team (it rewrites that ignore file). vg never touches an existing `.vibgrate/.gitignore`, so edit it (or leave it empty) to manage the ignores yourself.

---

### vg bundle

Build an air-gapped bundle — grammars, the code graph, and the library catalog — for use on a machine with no network.

```bash
vg bundle
```

| Flag | Default | Description |
|------|---------|-------------|
| `--offline` | — | Build using only locally-available assets |
| `-o, --out <dir>` | `vg-bundle` | Output directory for the bundle |

Add `--json` for machine-readable output.

---

### vg embed

Precompute the semantic index so the next `vg ask` is instant.

```bash
vg embed
```

Local ONNX model downloaded once into a shared cache (`~/.cache/vibgrate/models`). Per-repo vectors stored in `.vibgrate/cache/`.

| Flag | Description |
|------|-------------|
| `--where` | Show where the model is cached and its size |
| `--clear` | Remove the downloaded model from shared cache |

---

### vg export

Export the code map in various formats.

```bash
vg export [file]
```

Format is inferred from the file extension. Use `-` for stdout.

| Extension | Format |
|-----------|--------|
| `.json` | JSON |
| `.ndjson` | Newline-delimited JSON |
| `.graphml` | GraphML |
| `.dot` | Graphviz DOT |
| `.cypher` | Neo4j Cypher |
| `.md` | Markdown |
| `.html` | HTML visualization |
| `.cdx.json` | CycloneDX SBOM / AI-BOM |
| `.spdx.json` | SPDX |

---

### vg facts

Deterministic open facts for a node (contract, invariant, characterization).

```bash
vg facts <name>
```

Epistemic-typed: declared/static → observed/derived. Requires `--deep` for derived facts beyond basic declarations.

| Flag | Description |
|------|-------------|
| `<name>` | Node to inspect |
| `--pick <n>` | Pick the nth candidate when ambiguous |

---

### vg guide

Cited, relevant standards and practices for a node — the free standards pack.

```bash
vg guide <name>
```

| Flag | Description |
|------|-------------|
| `<name>` | Node to inspect |
| `--pick <n>` | Pick the nth candidate when ambiguous |

---

### vg impact

What breaks if you change it — deterministic structural blast radius.

```bash
vg impact <name>
```

Reverse reachability with decay confidence. With `--tests`, returns exactly the tests to run before shipping.

| Flag | Default | Description |
|------|---------|-------------|
| `<name>` | — | Node to assess |
| `--depth <n>` | `4` | Max traversal depth |
| `--tests` | — | Also surface the tests covering the affected set |
| `--fail-on-untested` | — | Exit 2 if any affected node is untested (CI gate) |
| `--pick <n>` | — | Pick the nth candidate when ambiguous |

---

### vg install

Add Vibgrate AI Context to your AI assistant(s) — skill, MCP wiring, and advisory nudge.

```bash
vg install [tools...]
vg uninstall <tools...>
```

Idempotent and repo-local (changes can be committed and shared with your team).

**Supported assistants:** `claude`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini`

| Flag | Description |
|------|-------------|
| `[tools...]` | Assistant ids to install for |
| `--all` | Install for every supported assistant |
| `--list` | Show the support matrix and exit |
| `--no-hook` | Skip the advisory nudge |

**`vg uninstall` flags:**

| Flag | Description |
|------|-------------|
| `<tools...>` | Assistant ids to remove (required) |
| `--purge` | Also delete the skill file |

---

### vg lib

Version-correct library docs — from the hosted catalog or local ingestion.

```bash
vg lib                  # List the catalog
vg lib <name>           # Show docs for a library (pinned to your lockfile version)
vg lib add <source>     # Ingest docs from a local source
vg lib publish <name>   # Upload private library docs to the hosted catalog
vg lib resolve <name>   # Resolve name → catalog id + version
vg lib refresh          # Re-ingest all local sources
```

| Flag | Default | Description |
|------|---------|-------------|
| `--name <name>` | — | Library name (for `add`) |
| `--version <v>` | — | Pin the doc version (for `add`/`publish`) |
| `-b, --budget <n>` | — | Trim docs to ~N tokens |
| `--readme <path>` | `./README.md` | README path (for `publish`) |
| `--dts <path>` | — | TypeScript declaration path (for `publish`) |
| `--language <lang>` | — | Primary language (for `publish`) |
| `--region <region>` | `us` | Data-residency region for the hosted catalog |
| `--ingest <url>` | — | Hosted catalog URL override (wins over `--region`) |

---

### vg map / vg hubs / vg areas / vg oddities

Map-level insights — read-only views over the committed graph.

```bash
vg map      # Overview: areas, hubs, untested hotspots
vg hubs     # Most-depended-on code (centrality outliers)
vg areas    # Natural groupings (communities), each labelled and sized
vg oddities # Surprising cross-area links (architectural smells)
```

| Command | Flag | Default | Description |
|---------|------|---------|-------------|
| `vg hubs` | `-n, --limit <n>` | `20` | How many hubs to show |
| `vg areas` | `-n, --limit <n>` | `30` | How many areas to show |
| `vg oddities` | `-n, --limit <n>` | `20` | How many oddities to show |

---

### vg models

The local model fleet — Ollama, LM Studio, and on-disk `gguf` models — discovered entirely offline.

```bash
vg models
```

Lists the local inference backends and models Vibgrate can see, so you know what is available without any network calls. Add `--json` for machine-readable output.

---

### vg path

Show how A connects to B — shortest path in the call graph.

```bash
vg path <a> <b>
```

| Flag | Description |
|------|-------------|
| `<a>` | Source node |
| `<b>` | Target node |
| `--pick-a <n>` | Pick the nth candidate for A |
| `--pick-b <n>` | Pick the nth candidate for B |

---

### vg savings

A local, privacy-safe report of the tokens and dollars saved by querying the map instead of grepping and reading whole files.

```bash
vg savings
```

Reads the counts-only usage ledger recorded when you run `vg serve --savings` (or pass `--client` on CLI navigation calls). Nothing leaves your machine — the figures are estimates.

| Flag | Default | Description |
|------|---------|-------------|
| `--days <n>` | `30` | Reporting window in days |
| `--clear` | — | Delete the recorded usage data for this repo (the ledger under `.vibgrate/cache/`, plus the opt-in stats-share upload state and per-install id) |

Add `--json` for machine-readable output.

---

### vg serve

Start [Vibgrate AI Context](https://vibgrate.com/library) — a local-first [MCP](https://vibgrate.com/glossary/model-context-protocol) serving your code map, drift, and version-correct docs to your AI assistant (fully offline under `--local`).

```bash
vg serve
```

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | — | Serve over streamable HTTP instead of stdio |
| `--port <n>` | `7437` | Port for `--http` |
| `--host <h>` | `127.0.0.1` | Host for `--http` |
| `--savings` | — | Record local, counts-only usage savings (opt-in) |
| `--share-stats` | — | Also upload the counts-only usage ledger to Vibgrate to improve the local MCP (opt-in; off by default; implies `--savings`; disabled under `--local`) |
| `--dedup` | — | Collapse a node's heavy relation lists on repeat reads within a session, to save tokens (opt-in) |
| `--no-refresh` | — | Serve the map as built; skip the auto-rebuild when files change |

Via stdio (default), your AI assistant spawns the server. Via `--http`, it runs as a local HTTP endpoint for browser or shared access.

**A live status display shows what the server is doing for you.** While `vg serve` runs in a terminal, a status block on stderr updates in place: uptime, which AI clients are connected (detected from the MCP handshake), calls and average response time per tool, and — for the navigation tools with a grep/read baseline — the context tokens served vs the estimated tokens a grep-and-read agent would have burned instead, with the estimated saving labelled as such. Outside a terminal (when your assistant spawns the server) it degrades to a quiet one-line heartbeat in the server logs every 15 minutes, and only when there has been activity. The display is in-memory only and always on — nothing is written to disk or uploaded (recording and sharing below stay opt-in) — and `--quiet` turns it off.

**Usage stats — local by default, sharing is opt-in.** `--savings` records a *counts-only* ledger under `.vibgrate/` — per navigation call: which tool, how it resolved (complete/partial/miss), the vg-vs-grep token figures, whether it came over the MCP (`mcp`) or the `vg` CLI (`cli`), and a coarse client label (which AI). `vg savings` reports it locally; nothing leaves your machine. `--share-stats` additionally uploads that same counts-only ledger to Vibgrate periodically, so we can see how the local MCP is used and improve it. It **never** sends code, file paths, question text, repo identity, or any credential — only counts, outcomes, token figures, the vg version, your OS/arch, and a random per-install id. It's off unless you pass the flag, is disabled entirely under `--local`, and the endpoint can be overridden with `VIBGRATE_STATS_ENDPOINT`.

**Attributing CLI calls.** The MCP path detects the calling client automatically from the connection handshake. For CLI calls, pass `--client=<ai>` (e.g. `vg "how does auth work" --client=claude`) so the call is attributed in `vg savings` and any shared stats — this is what `vg install` writes into each assistant's skill. Without `--client`, a bare `vg ask` records nothing.

**The map stays fresh while you (or your AI) edit code.** Each tool call runs a cheap stat-only freshness check against the last build; when files really changed, the server rebuilds the map incrementally in-process — only changed files re-parse — and answers from the updated graph. Probes are debounced with a self-tuning cadence (2s floor, scaling with measured probe cost so probing never exceeds a few percent of serve time even on very large repos), rebuilds are single-flight and cross-process locked, and touch-only changes (a `git checkout`, a re-save with identical content) are recognized by content hash and never trigger a rebuild. There is no filesystem watcher and no daemon: freshness is checked exactly when it matters — at query time. The server also hot-reloads `graph.json` whenever it changes on disk, so an external `vg` build is picked up on the next call too.

The server exposes read-only tools your assistant can call over the code map and dependency data, including:

- `query_graph`, `get_node`, `find_path`, `impact_of`, `tests_for` — navigate and reason about the code map.
- `check_drift` — offline dependency inventory; pass `attribute: true` to add git "who added this / who set the version" attribution.
- `list_vulnerabilities`, `vuln_attribution` — known vulnerabilities and their exposure attribution from the last `vg scan --vulns`.
- `upgrade_impact` — what an upgrade will cost: version distance, how many files import the package, the vulnerabilities it fixes, and — with `changelog: true` — online breaking-change notes between your version and the latest.
- `resolve_library`, `library_docs` — version-correct, drift-annotated library docs.

All tools are read-only. The server is local-first: it always answers from your machine when it can, and its only network touches are the embedder's one-time model fetch, `upgrade_impact`'s `changelog`, and `library_docs`' fall-through to the hosted catalog when the local docs for a library are thin or missing. `--local` is the hard airgap — it disables all three.

---

### vg share

Make the code map committable and auto-updating for your team.

```bash
vg share
```

Installs a pre-commit hook, deterministic merge driver, and `.gitignore` so the map stays fresh without any manual steps. This rewrites the default `.vibgrate/.gitignore` (which ignores the graph artifacts, `graph.json` included) so `graph.json` is committed while the cache and volatile reports stay ignored.

| Flag | Description |
|------|-------------|
| `--undo` | Reverse what `vg share` installed |
| `--reports` | Also commit `graph.html` / `GRAPH_REPORT.md` (default: gitignored) |

---

### vg show

Explain a single node: what it is, what it calls, what calls it.

```bash
vg show <name>
```

| Flag | Description |
|------|-------------|
| `<name>` | Qualified name, short name, `file:line`, glob, or id |
| `--pick <n>` | Pick the nth candidate when ambiguous |

Outputs the qualified name, kind, file location, signature, importance score, area, extends relationships, callees, and callers.

---

### vg status

Graph freshness, counts, and staleness — compared against the working tree.

```bash
vg status
```

Outputs: map path, generation timestamp, node/edge/area counts, languages, cluster method, resolver rungs used, cache status, and stale file count. When a build has run on this machine, staleness is exact (per-file stat + content hash against the last build's snapshot — edits, adds, and removes); otherwise it falls back to comparing the file set.

---

### vg tests

Which tests cover a node (call/coverage linkage).

```bash
vg tests <name>
```

`--missing` flips to show untested nodes nearby. `--run` prints (or `--exec` runs) the minimal command to exercise exactly those tests.

| Flag | Description |
|------|-------------|
| `<name>` | Node to inspect |
| `--missing` | Show untested nodes nearby instead |
| `--run` | Print the command to run exactly these tests |
| `--exec` | Run that command |
| `--pick <n>` | Pick the nth candidate when ambiguous |

---

### vg tree

The call tree rooted at a node.

```bash
vg tree <name>
```

Callees by default; `--callers` to invert. Depth-bounded and cycle-safe.

| Flag | Default | Description |
|------|---------|-------------|
| `<name>` | — | Root node |
| `--callers` | — | Show callers instead of callees |
| `--depth <n>` | `3` | Max depth |
| `--pick <n>` | — | Pick the nth candidate when ambiguous |

---

### vg unknowns

What the graph cannot resolve, ranked by blast radius — the unresolved references most worth teaching the map about.

```bash
vg unknowns
```

Surfaces the symbols and imports the resolver could not tie to a definition, ordered by how much depends on them, so you can see where a SCIP index or a targeted `--only` language pass would most improve resolution.

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | `20` | How many to show |

Add `--json` for machine-readable output.

---

## Drift Baselines & Fitness Functions

Vibgrate stores scan state under `.vibgrate/`:

- `.vibgrate/scan_result.json`: latest scan artifact
- `.vibgrate/baseline.json`: explicit baseline snapshot (`vg baseline`)
- `<project>/.vibgrate/project_score.json`: per-project score snapshots

Recommended workflow:

1. Create baseline once on main branch:
   ```bash
   vg baseline
   ```
2. In CI, run scan with comparison and gates:
   ```bash
   vg scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5
   ```
3. When planned upgrades land, refresh baseline:
   ```bash
   vg baseline
   ```

This makes drift a formal quality gate (fitness function), not just reporting.

## DriftScore

### How the Score Is Calculated

The DriftScore is a deterministic, versioned metric (0–100) that represents how far behind your codebase is relative to the current stable ecosystem baseline.

**Lower score = healthier upgrade posture.** 0 means no drift (fully current); 100 means maximum drift. Higher is worse.

The methodology is published: see the [public scoring specification](./docs/public/SCORING-METHODOLOGY-PUBLIC.md) in this repository and the overview at [vibgrate.com/driftscore](https://vibgrate.com/driftscore).

### Risk Levels

| Score  | Risk Level                           |
| ------ | ------------------------------------ |
| 0–30   | **Low** — You're in good shape       |
| 31–60  | **Moderate** — Some attention needed |
| 61–100 | **High** — Significant upgrade debt  |

### Score Components

The overall score is a weighted combination of four components:

| Component        | What It Measures                                                                  |
| ---------------- | --------------------------------------------------------------------------------- |
| **Runtime**      | Node.js or .NET runtime major version lag                                         |
| **Frameworks**   | Major version distance for core frameworks (React, Next, NestJS, ASP.NET, etc.)   |
| **Dependencies** | Age distribution across all dependencies (current vs 1 major behind vs 2+ behind) |
| **EOL Risk**     | Proximity to end-of-life for runtimes and frameworks                              |

---

## Output Formats

### Text

The default output. A coloured, human-readable report showing:

- Overall drift score and risk level
- Score component breakdown with visual bars
- Per-project details: runtime lag, framework versions, dependency distribution
- Findings with severity icons

### JSON Artifact

The full scan artifact in JSON format. Contains all raw data, scores, findings, and VCS metadata. Stable schema (`schemaVersion: "1.0"`). This is the same artifact saved to `.vibgrate/scan_result.json`.

### SARIF

[Static Analysis Results Interchange Format](https://sarifweb.azurewebsites.net/) — compatible with GitHub Code Scanning and Azure DevOps. Contains findings only (not all metrics). Ideal for integrating drift findings directly into your PR review workflow.

### Markdown

A clean Markdown report suitable for PRs, wikis, or documentation.

---

## Configuration

### vibgrate.config.ts

Run `vg init` to generate the config file, or create one manually:

```typescript
import type { VibgrateConfig } from "@vibgrate/cli";

const config: VibgrateConfig = {
  exclude: ["legacy/**"],
  thresholds: {
    failOnError: {
      eolDays: 180,
      frameworkMajorLag: 3,
      dependencyTwoPlusPercent: 50,
    },
    warn: {
      frameworkMajorLag: 2,
      dependencyTwoPlusPercent: 30,
    },
  },
  scanners: {
    platformMatrix: { enabled: true },
    dependencyRisk: { enabled: true },
    dependencyGraph: { enabled: true },
    toolingInventory: { enabled: true },
    buildDeploy: { enabled: true },
    tsModernity: { enabled: true },
    breakingChangeExposure: { enabled: true },
    fileHotspots: { enabled: true },
    securityPosture: { enabled: true },
    securityScanners: { enabled: true },
    serviceDependencies: { enabled: true },
    databaseSchema: { enabled: true },
  },
};

export default config;
```

Also supports `vibgrate.config.js` and `vibgrate.config.json`.

### Thresholds

Control when findings are raised and when the CLI should fail.

| Threshold                              | Default | Triggers                                                      |
| -------------------------------------- | ------- | ------------------------------------------------------------- |
| `failOnError.eolDays`                  | 180     | Error finding when runtime EOL is within N days               |
| `failOnError.frameworkMajorLag`        | 3       | Error finding when any framework is N+ majors behind          |
| `failOnError.dependencyTwoPlusPercent` | 50      | Error finding when N+% of dependencies are 2+ majors behind   |
| `warn.frameworkMajorLag`               | 2       | Warning finding when any framework is N+ majors behind        |
| `warn.dependencyTwoPlusPercent`        | 30      | Warning finding when N+% of dependencies are 2+ majors behind |

### Scanner Toggles

Each extended scanner can be individually disabled. Set `scanners: false` to disable all extended scanners (the core drift scan always runs).

### Resource safeguards (environment variables)

Building the code map holds every parse table, node, and edge in memory, so on
a pathological corpus (a vendored 200 MB bundle, a million-file tree) an
unguarded build could exhaust memory and crash the process. The build ships
with safeguards on by default; each is tunable via an environment variable,
and `0` always means "disabled".

| Variable              | Default                     | What it does                                                                                                                          |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VG_MAX_FILE_BYTES`   | `2097152` (2 MiB)           | Per-file source cap. Larger files (almost always generated/minified) are skipped with a warning; they stay freshness-tracked.          |
| `VG_MAX_FILES`        | `100000`                    | Corpus file-count ceiling. Exceeding it stops the build with guidance (scope with paths, `--exclude`, or `--only`) instead of an OOM.   |
| `VG_TSC_MAX_FILES`    | `10000`                     | Max TS/JS files handed to the in-process TypeScript resolver (the largest single memory consumer). Above it, the heuristic rung is used. |
| `VG_MEMORY_BUDGET_MB` | 90% of the Node heap ceiling | Heap budget checked at phase boundaries. Exceeding it stops the build with a clear, catchable error before V8 hard-crashes.             |
| `VG_JOBS`             | CPU cores − 1               | Default parse worker count when `--jobs` isn't passed. Fewer workers = lower peak memory (each worker loads its own grammar set).       |
| `VG_WORKER_HEAP_MB`   | platform default            | Per-worker old-generation heap cap, so one runaway parse can't take the whole machine.                                                  |

Skips are deterministic functions of the input (file size, file count) — never
of observed memory — so identical input still produces an identical
`graph.json`. To give the build more room instead of limiting it, raise the
Node heap: `NODE_OPTIONS=--max-old-space-size=8192`.

---

## Extended Scanners

Beyond the core drift score, Vibgrate runs a suite of extended scanners that collect high-value migration intelligence. All scanners:

- Are **read-only** — they never write files or execute project code
- Run **in parallel** — failures in one scanner never affect the others
- Can be **individually toggled** in the config
- Collect **zero sensitive data** — no secrets, no PII, and no credentials, even the ones that do open source files (below)

The core drift score is manifest/lockfile-only. Several extended scanners, and
the code graph (`vg build`/`vg map`/`vg share`/`vg serve`), go further and open
your source files locally — that is how they work, not an accident:

| Reads source locally | What it extracts | Keeps raw text? |
|---|---|---|
| **Code graph** (`vg build`/`vg map`) | Symbol names, call edges, file paths, hubs/areas — the graph itself | No — never a source line, only structural graph facts |
| **Code Quality** (`codeQuality`) | Cyclomatic complexity, function length, nesting depth, dead code, "god files" | No — computed metrics only |
| **Breaking Change Exposure** (`breakingChangeExposure`) | Import/usage-pattern hit counts for majorly-outdated packages | No — counts only |
| **Database Schema** (`databaseSchema`) | Table/model names, column names and types, relation/key flags from SQL/Prisma/Drizzle/TypeORM files | No — never a query, row, or credential |
| **UI Purpose** (`uiPurpose`) | Route/nav/title/CTA copy, for feature detection | **Yes** — short evidence samples of the literal UI text are kept locally (never business logic, never a full file) |

None of this is executed, and **nothing above leaves your machine** unless you
run `vg share`/`vg push` or scan with a DSN configured — and even then, what
uploads is the computed/structural output in the table above, never a raw
source file. Each of these is individually toggleable; set the matching
`scanners.<name>.enabled` to `false` (or `scanners: false` for all extended
scanners, which does not affect the code graph) if you don't want the read to
happen at all. See [Scanner Toggles](#scanner-toggles) above and each
scanner's own section below.

The one exception where code truly leaves your machine is the **remediation
agent**: when you ask it to write a fix, it clones your repository into an
isolated virtual machine Vibgrate controls, makes the change, and hands you a
pull request. That only happens when you ask for it. See
[vibgrate.com/subprocessors](https://vibgrate.com/subprocessors) for who processes what.

### Platform Matrix

Collects platform and architecture signals that predict where builds will break when moving CI runners, containers, or CPU architectures.

- `engines.node` and `engines.npm`/`engines.pnpm` ranges
- `.nvmrc` / `.node-version` files
- .NET `TargetFramework` and SDK versions
- Native module risk packages (`sharp`, `bcrypt`, `node-gyp`, etc.)
- OS-assumption scripts in `package.json`
- Dockerfile base images (FROM lines only)

### Dependency Risk

Extends dependency analysis with risk classification signals:

- Deprecated packages (npm `deprecated` field)
- Native module detection
- Platform-specific package flags

### Dependency Graph & Duplication

Parses lockfiles (pnpm, npm, yarn, .NET) to build a workspace-wide dependency graph:

- Total unique vs. installed dependency counts
- Duplicated packages (multiple versions of the same package)
- Phantom dependencies (used but not declared)

### SBOM-ready Supply Chain Inventory

Vibgrate artifacts include dependency graph and package inventory data that can be used for supply-chain governance workflows:

- Lockfile-derived package counts (`totalUnique`, `totalInstalled`)
- Duplicate-version hotspots to prioritize remediation
- Phantom dependency evidence (`phantomDependencies` + details)
- Inventory metadata that pairs well with internal SBOM pipelines

Vibgrate supports both direct SBOM export (`vg sbom export`) and raw inventory consumption from `scan_result.json`, so teams can choose either built-in output or custom SBOM pipelines.

Example:

```bash
vg sbom export --in .vibgrate/scan_result.json --format spdx --out sbom.spdx.json
```

Expected result:

- A standards-based SBOM file (`spdx` or `cyclonedx`) is written for downstream governance tooling.

### Tooling Inventory

Maps the full technology stack across your workspace by detecting package names in dependencies:

| Category        | Examples                             |
| --------------- | ------------------------------------ |
| Frontend        | React, Vue, Angular, Svelte, Solid   |
| Meta-frameworks | Next.js, Nuxt, Astro, Remix          |
| Bundlers        | Vite, webpack, esbuild, Rollup       |
| Backend         | Express, Fastify, NestJS, Hono       |
| ORM / DB        | Prisma, Drizzle, TypeORM, EF Core    |
| Testing         | Vitest, Jest, Playwright, xUnit      |
| Observability   | Sentry, OpenTelemetry, Pino, Winston |

### Build & Deploy Surface Area

Detects CI/CD, containerisation, and infrastructure-as-code:

- CI systems (GitHub Actions, GitLab CI, Azure DevOps, Jenkins, CircleCI)
- Docker and Docker Compose
- IaC (Terraform, Bicep, CloudFormation, Pulumi)
- Release tooling (Changesets, semantic-release, GitVersion)
- Package managers and monorepo tools

### TypeScript Modernity

Reads `tsconfig.json` compiler options to assess strictness and modernity:

- TypeScript version
- `strict`, `noImplicitAny`, `strictNullChecks` flags
- Module system (`module`, `moduleResolution`, `target`)
- ESM vs CJS classification
- `exports` field presence

### Breaking Change Exposure

Flags packages and patterns known to cause upgrade pain:

- Deprecated packages (e.g. `request`, `node-sass`, `tslint`, `moment`)
- Legacy Node API polyfills no longer needed on Node 18+ (e.g. `node-fetch`, `abort-controller`)
- Peer dependency conflicts
- Exposure score (0–100)

### File Hotspots

Lightweight complexity analysis using filesystem metadata only (never reads file contents):

- File counts by extension
- Largest files by size (path + bytes)
- Directory depth distribution
- Most-used packages across the workspace

### Security Posture

Structural security hygiene indicators (not a secret scanner):

- Lockfile presence and consistency
- `.gitignore` coverage for `.env` files and `node_modules`
- `.env` files tracked outside `.gitignore`
- Audit severity counts (via `npm audit --json`)

### Security Scanners

Security scanner orchestration and readiness analysis for local policy and secret-scanning workflows:

- Scanner engine discovery (installed vs missing)
- Version freshness checks to flag stale scanner engines/signatures
- Local config discovery for scanner policy files
- Cache-backed heuristic secret signals to add value even when binaries are unavailable

> This scanner does not guarantee full secret detection or rule coverage by itself; it reports toolchain status and lightweight in-repo indicators so teams can decide how to harden CI enforcement.

### Service Dependencies

Maps external service and platform dependencies by detecting SDK packages:

| Category      | Examples                         |
| ------------- | -------------------------------- |
| Payment       | Stripe, Braintree, PayPal        |
| Auth          | Auth0, Clerk, Firebase, Passport |
| Cloud SDKs    | AWS, Azure, Google Cloud         |
| Databases     | PostgreSQL, MongoDB, Redis       |
| Messaging     | SQS, SNS, Kafka, BullMQ          |
| Observability | Sentry, DataDog, New Relic       |

### Database Schema

Extracts structural database-schema facts across five sources — Prisma
(`schema.prisma`), raw SQL migrations (`.sql` files), SQL Server database
projects (`.sqlproj`), Drizzle (`pgTable`/`mysqlTable`/`sqliteTable`), and
TypeORM (`@Entity()` classes) — merged into one report:

- Table/model names, per-field name and type, and relation/list/optional/id/unique flags
- Enum names and values (Prisma)
- Datasource providers (e.g. `postgresql`, `mysql`) — never the connection-string `url`
- Files scanned, with a per-project breakdown

Only structural facts are ever extracted — never a raw source line, a query,
or a connection string/credential (any `scheme://user:pass@host` line is
stripped as defense in depth even though hand-written SQL rarely embeds one).
Reading these facts means opening `.sql`/`.prisma`/ORM source files locally —
see the table at the top of this section for how this compares to the code
graph and the other scanners that also read source. It's on by default; disable it with
`scanners.databaseSchema.enabled: false` in `vibgrate.config.ts` (see
[Scanner Toggles](#scanner-toggles)). Like every extended scanner, results
only leave your machine when you run `vg push` or scan with a DSN configured
— and the models/fields/files arrays are capped before upload so a
large-monorepo schema can't balloon the payload.

### Architecture Layers

Classifies source files into architectural layers and reports drift by layer to make refactors more predictable:

- Archetype detection (e.g. Next.js, NestJS, Express, serverless, monorepo, CLI)
- Layer-level file counts and confidence scoring
- Per-layer package drift scores and risk levels
- Layer-specific tech stack and service dependency attribution

### Code Quality Metrics

Fast AST-based quality checks to identify upgrade friction hotspots:

- Files/functions analyzed
- Cyclomatic complexity averages
- Function length and nesting depth signals
- Circular dependencies and dead-code estimate
- "God file" detection for oversized high-complexity modules

### OWASP Category Mapping

Maps security findings into OWASP Top 10 categories for security triage inside existing drift reports:

- Supports `fast` and `cache-input` modes
- Categorizes findings with severity and CWE metadata
- Emits per-category counts in JSON output
- Designed for CI visibility without requiring a separate report format

---

## CI Integration

### GitHub Actions

Use the maintained templates in this package for copy-paste setup:

- `examples/github-actions/driftscore-ci.yml` (JSON artifact + drift gate)
- `examples/github-actions/driftscore-sarif.yml` (SARIF upload to code scanning)
- `examples/github-actions/vulnerabilities-sarif.yml` (vulnerability gate + SARIF upload)
- `docs/ci/github-actions.md` (integration notes)

```yaml
steps:
  - name: Vibgrate Scan
    run: npx @vibgrate/cli scan --format sarif --out vibgrate.sarif --fail-on error

  - name: Upload SARIF
    uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: vibgrate.sarif

  # Optional: push metrics to Vibgrate Cloud
  - name: Push Vibgrate Metrics
    env:
      VIBGRATE_DSN: ${{ secrets.VIBGRATE_DSN }}
    run: npx @vibgrate/cli push --file .vibgrate/scan_result.json
```

To gate pull requests on **known vulnerabilities** and surface them in the
Security tab, the maintained `vibgrate/cli` Action does the scan, gate, and SARIF
upload in one step (needs `permissions: security-events: write`):

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0          # full history → exposure attribution + remediation MTTR
  - uses: vibgrate/cli@v1
    with:
      vulns: true
      fail-on: error          # critical/high block the merge
      upload-sarif: true
      category: vibgrate-vulns
```

### Azure DevOps

```yaml
steps:
  - script: npx @vibgrate/cli scan --format sarif --out vibgrate.sarif --fail-on error
    displayName: Vibgrate Scan

  - task: PublishBuildArtifacts@1
    inputs:
      PathtoPublish: vibgrate.sarif
      ArtifactName: VibgrateSARIF
```

### GitLab CI

```yaml
vibgrate:
  script:
    - npx @vibgrate/cli scan --format sarif --out vibgrate.sarif --fail-on error
  artifacts:
    reports:
      sast: vibgrate.sarif
```

### Generic Pipelines

Vibgrate works in any CI environment. The CLI:

- Requires no login or authentication
- Returns meaningful exit codes (see below)
- Produces standard SARIF output
- Works entirely offline (push is opt-in)

---

## Vibgrate Cloud Upload

### DSN Tokens

Vibgrate uses HMAC-signed DSN tokens for authenticated uploads. The DSN format:

```
vibgrate+https://<key_id>:<secret>@<ingest_host>/<workspace_id>
```

Set `VIBGRATE_DSN` as a secret in your CI environment. Uploads are always optional — the CLI provides full value locally without any server connection.

### Data Residency

Vibgrate supports region-specific ingest endpoints:

| Region       | Endpoint                 |
| ------------ | ------------------------ |
| US (default) | `us.ingest.vibgrate.com` |
| EU           | `eu.ingest.vibgrate.com` |

Use `--region eu` on `push` or `dsn create` to route data to the EU endpoint.

---

## Privacy & Security

Vibgrate is built with a privacy-first architecture. Here's what it **never** does:

| Category           | Hard guarantee                                     |
| ------------------ | -------------------------------------------------- |
| Source code        | Never read beyond config/manifest files            |
| Secrets            | Never scanned for, never extracted                 |
| Environment values | Never read — only `.env` file existence is flagged |
| Git identity data  | Never accessed — `git log` is never invoked        |
| File contents      | Only structured config fields are extracted        |
| Network endpoints  | Never parsed from config files                     |

What it **does** collect:

- Package names and version numbers (from `package.json`, `.csproj`, lockfiles)
- Config structure flags (e.g. `strict: true` from `tsconfig.json`)
- File names and sizes (paths and metadata, never contents)
- Public npm/NuGet registry metadata (latest versions, deprecation flags)
- CI/Docker/IaC file presence and structural counts

---

## Exit Codes

| Code | Meaning                        |
| ---- | ------------------------------ |
| `0`  | Success                        |
| `1`  | Runtime error                  |
| `2`  | `--fail-on` threshold exceeded |

---

## Programmatic API

The package exports its core types for programmatic use:

```typescript
import type {
  VibgrateConfig,
  ScanArtifact,
  DriftScore,
  Finding,
} from "@vibgrate/cli";
```

---

## Requirements

- **Node.js** >= 22.0.0
- Works on macOS, Linux, and Windows

---

## Links

- [Website](https://vibgrate.com)
- [Vibgrate CLI — live demo and simulator](https://vibgrate.com/cli)
- [CLI benchmarks](https://vibgrate.com/cli/benchmarks) · [methodology](https://vibgrate.com/cli/benchmarks/methodology) · [token savings](https://vibgrate.com/cli/benchmarks/token-savings)
- [DriftScore](https://vibgrate.com/driftscore)
- [Vibgrate AI Context (local-first MCP)](https://vibgrate.com/library)
- [Vibgrate Graph](https://vibgrate.com/graph)
- [Vibgrate Cloud](https://vibgrate.com/cloud) · [create a free workspace](https://dash.vibgrate.com)
- [Vibgrate MCP (hosted)](https://vibgrate.com/mcp)
- [AI agent skills](https://vibgrate.com/skills)
- [Glossary](https://vibgrate.com/glossary)
- [Help center](https://vibgrate.com/help)
- [Changelog](https://vibgrate.com/changelog)
- [npm](https://www.npmjs.com/package/@vibgrate/cli)

---

Copyright © 2026 Vibgrate. All rights reserved. See [LICENSE](https://vibgrate.com/license) for terms.
