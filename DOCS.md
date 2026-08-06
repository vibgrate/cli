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
  - [vg evidence](#vg-evidence)
  - [vg fix](#vg-fix)
  - [vg init](#vg-init)
  - [vg report](#vg-report)
  - [vg sbom](#vg-sbom)
  - [vg scan](#vg-scan)
    - [Vulnerabilities and exposure attribution](#vulnerabilities-and-exposure-attribution)
  - [vg update](#vg-update)
  - [vg why](#vg-why)
- [Workspace auth & cloud upload](#workspace-auth--cloud-upload)
  - [vg dsn create](#vg-dsn-create)
  - [vg login](#vg-login)
  - [vg logout](#vg-logout)
  - [vg push](#vg-push)
- [Code Graph Commands](#code-graph-commands)
  - [vg ask](#vg-ask)
  - [vg build](#vg-build)
  - [vg watch](#vg-watch)
  - [vg bundle](#vg-bundle)
  - [vg code](#vg-code)
  - [vg embed](#vg-embed)
  - [vg export](#vg-export)
  - [vg facts](#vg-facts)
  - [vg guide](#vg-guide)
  - [vg impact](#vg-impact)
  - [vg install / vg uninstall](#vg-install)
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
- [Diagnostics, IDE & runtime](#diagnostics-ide--runtime)
  - [vg daemon](#vg-daemon)
  - [vg doctor](#vg-doctor)
  - [vg lsp](#vg-lsp)
  - [vg policy](#vg-policy)
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

Drift scoring, baselines, reports, supply-chain evidence, and related local tooling.

**Typical path:** `vg init` → `vg scan` → `vg baseline` → `vg report` → `vg fix`

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


### vg evidence

Vibgrate Evidence — signed, reproducible regulatory evidence. Register products with digital elements, freeze a shipped release into an immutable component manifest, then answer "which shipped products contain this vulnerability, at which versions, in which markets, still in support?" as evidence a third party can verify offline.

Reporting duties are modelled as **regimes** (jurisdiction-neutral): the EU Cyber Resilience Act (`--regime cra`) is the first; DORA incident reporting (`--regime dora-incident`) ships too. A new jurisdiction is a regime profile, not a new command.

```bash
vg evidence init [--regime <id>] [--coordinator <csirt>] [--responsible <name>] [--filing-authority] [--ooo <contact>]
vg evidence regimes
vg evidence product add <name> [--markets DE,FR] [--classification <id>] [--in-scope] [--rationale <text>] [--bind <ref>] [--until <date>]
vg evidence product list
vg evidence product show <id>
vg evidence release <product> <version> --from <sbom-or-scan> [--ship-date <date>] [--build-id <id>] [--digest <sha256>] [--markets DE,FR]
vg evidence exposure <vuln> [--regime <id>] [--advisory <file>] [--offline] [--as-of <date>] [--products <substr>] [--include-eol] [--format table|json] [--pack --stage <stage>] [--bundle <dir>] [--tsa <url>]
vg evidence readiness [--regime <id>] [--format table|json]
vg evidence support-period <product> [--from <date>] [--until <date>]
vg evidence pack <vuln> [--regime <id>] [--stage <stage>] [--advisory <file>] [--offline] [--out <file>]
vg evidence drill [--regime <id>] [--scenario <name>] [--elapsed <seconds>]
vg evidence watch [--regime <id>] [--since <date>] [--webhook <url>] [--format table|json]
vg evidence verify <bundle> [--pub <file>]
vg evidence push [--result <bundle-or-file>] [--regime <id>] [--dsn <dsn>] [--signed]
vg evidence export [--out <dir>] [--regime <id>]
```

| Command | Description |
|---------|-------------|
| `vg evidence init` | Set org, coordinator CSIRT, and the person with filing authority |
| `vg evidence regimes` | List available reporting regimes and their clocks |
| `vg evidence product add` | Register a product with digital elements (PDE) |
| `vg evidence release` | Freeze a shipped release into an immutable component manifest |
| `vg evidence exposure` | Which shipped products contain a vulnerability — with signed evidence |
| `vg evidence readiness` | Deterministic gap report against the regime's obligations |
| `vg evidence drill` | Timed dry-run of the determination against a simulated advisory |
| `vg evidence pack` | Build the submission pack a human pastes into the reporting platform |
| `vg evidence watch` | Check CISA KEV for new exposure against your shipped components |
| `vg evidence verify` | Verify an evidence bundle offline — no account, no network |
| `vg evidence push` | Push the product registry (and an optional exposure result) to Vibgrate Cloud |
| `vg evidence export` | Air-gap bundle of all evidence state |

`exposure` matches against manifests **frozen at ship time**, not the current tree, and never guesses: a bound product with no frozen manifest returns `undetermined` with a reason. It runs fully `--offline` against a local advisory file, and can emit a signed evidence bundle (`--bundle <dir>`) that `vg evidence verify` checks offline with honest `verified` / `unverified` / `failed` states. Pass `--tsa <url>` to anchor the bundle to a trusted **RFC 3161** timestamp (`timestamp.tsr`), fully verifiable with `openssl ts -verify`.

`watch` joins the CISA **Known Exploited Vulnerabilities (KEV)** catalog to the components in your frozen manifests (via OSV) and reports any KEV-listed vulnerability that affects a shipped release — alerting via stdout or `--webhook`. It **surfaces the KEV listing**; whether a vulnerability is "actively exploited" for a filing is your determination, not the tool's.

**Exit codes** (CI-usable): `0` no exposure · `2` exposure found · `3` undetermined (manual review) · `1` operational error.

No language model touches any figure in the evidence path, and every determination carries an evidence-not-compliance disclaimer. Vibgrate Evidence produces evidence to support your obligations under a regime; it does not determine compliance and is not legal advice.

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

| Flag        | Description                                            |
| ----------- | ------------------------------------------------------ |
| `--check`   | Only check for updates, don't install                  |
| `--pm`      | Force a package manager (`npm`, `pnpm`, `yarn`, `bun`) |
| `--global`  | Update the global installation                         |
| `-y, --yes` | Skip confirmation prompts                              |

**On Windows**, updating a global install replaces files the running `vg` process has open — Windows locks loaded native modules (`.node`), so npm fails with `EBUSY: resource busy or locked`. `vg update` handles this: it stops the vgd daemon and any older `vg serve` first, and if the install still hits a locked file it offers to finish the update from a detached script that waits for `vg` to exit. Pass `-y` to accept that without a prompt. The script writes a transcript whose path is printed; check the result with `vg --version`.

---


### vg why

Explain a dependency from git history: who added it, every version since, and any open vulnerabilities it carries.

```bash
vg why <package>
```

`vg why` reads your lockfile's history, so it works across npm / pnpm / yarn, pip / poetry, cargo, composer, bundler, go, pub, hex, NuGet, and Maven/Gradle projects. For Maven/Gradle the history comes from a resolved `gradle.lockfile`, or a `pom.xml`'s pinned direct-dependency versions (versions managed by a BOM/`dependencyManagement` aren't resolved). Open vulnerabilities and their introduction attribution come from your most recent `vg scan --vulns`.

---


## Workspace auth & cloud upload

Sign in to Vibgrate Cloud, manage DSN tokens for CI, and push scan results. Local drift scoring does not require this — nothing leaves your machine until you push.

**Typical path:** `vg login` → `vg dsn create` → `vg push` → `vg logout`

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


## Code Graph Commands

Build and query the deterministic code map.

**Typical path:** `vg build` → `vg status` → `vg ask` → `vg impact` → `vg share`

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


### vg watch

Rebuild the code map when source files change (debounced). Useful for long agent sessions.

```bash
vg watch
vg watch src/ --fast
```

| Flag | Default | Description |
|------|---------|-------------|
| `[paths...]` | `.` | Folders to watch |
| `--debounce <ms>` | `400` | Settle time after a change before rebuild |
| `--fast` | — | Skip precise TypeScript resolve on rebuilds |
| `--no-html` | — | Do not rewrite `graph.html` |
| `--no-report` | — | Do not rewrite `GRAPH_REPORT.md` |


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

### vg code

Propose a code edit for a plain-language instruction, grounded in the deterministic code graph. `vg code` is **dry-run by default**: it prints the proposed diff and writes nothing.

```bash
vg code "add a --timeout flag to the scan command"
```

**Agentic sessions.** With a real model, `vg code` is a coding *agent*, not just a one-shot editor: the model is given tools and works in steps — **search the code graph**, read files, check a symbol's blast radius, edit, create/delete files, and run your tests or build — until the task is done. Every mutating step (an edit or a command) is **governed**: you approve it, or run autonomously with `--auto`. Read-only steps (search/read/list/impact) run without prompting. `--single` forces the old one-shot diff; `--max-steps <n>` caps the loop.

**Guided mode.** Run `vg code` with no instruction at an interactive terminal and it walks you through everything: it builds the code map, then asks where the model should run — a local model, or one of the current top providers (Claude, GPT, Grok, Gemini, …) surfaced live from the catalog — and which model, with an "enter a slug myself" option at every step. Before pulling any local model it runs a memory pre-flight (estimated footprint vs free RAM/VRAM and already-loaded models) and won't pull a model your machine can't run; then it drops into an agent session where you describe tasks and approve each change. For scripts and CI, pass an instruction with `--auto` (or `--mock`) — the agent only prompts at a TTY, so automation never blocks.

While a session is active, Vibgrate Graph (`vg serve`) runs as a separate process for the life of the session and is stopped when you exit. Every graph-backed call is attributed to VG Code and the model in use, so `vg savings` reports token/$ savings **per model**.

**A full local session (no cloud):**

```bash
# one-time: a local coding model (or: vg models install)
vg models pull qwen2.5-coder:7b

# start a guided agent session — pick "Local model" → qwen2.5-coder:7b
vg code
```

```text
  VG Code  · graph-grounded coding · v2026.x

  ✔ Code map built
  ✔ Model catalog loaded
  ? Where should the model run?
  ❯ Local model (on your machine)   1 found
    Anthropic (Claude)              via OpenRouter
    …
  ✔ qwen2.5-coder:7b
  ◆ Ready — ollama/qwen2.5-coder:7b · graph 48213. Describe a task; empty line to exit.

  code › add a --timeout flag to the scan command and use it

    → search_code(query: --timeout flag scan command)
      scanCommand (function) src/commands/scan.ts:12
    → read_file(path: src/commands/scan.ts)
      src/commands/scan.ts (40 lines): …
    → graph_impact(symbol: runScan)
      3 symbol(s) depend on runScan: …
  I'll add the option and thread it through.
    → edit_file(path: src/commands/scan.ts, …)
--- a/src/commands/scan.ts
+++ b/src/commands/scan.ts
@@ …
+  .option('--timeout <ms>', 'abort the scan after <ms> milliseconds')
  ? Apply edit to src/commands/scan.ts? [Y/n] y
      ✔ edited src/commands/scan.ts
    → run_command(command: npm test -- scan)
  ? Run `npm test -- scan`? [y/N] y
      ✔ exit 0  … 12 passing
    → finish(summary: added a --timeout flag to scan and covered it with tests)

  ✔ added a --timeout flag to scan and covered it with tests
    +6 -1 across 1 file(s) · via ollama/qwen2.5-coder:7b
```

Run it non-interactively with `vg code "add a --timeout flag to scan" --provider ollama --model qwen2.5-coder:7b --auto`, or against a hosted model with `--provider openrouter --model anthropic/claude-3.5-sonnet` (set `OPENROUTER_API_KEY`).

**In a session** you can type slash-commands: `/undo` reverts the last change, `/diff` shows it, `/model` switches model, `/cost` shows the running token/$ cost, `/help` lists them, `/exit` quits.

**More session controls:**

- `--stream` streams the model's output live as it's generated.
- `--verify [command]` runs your tests after the agent finishes and, if they fail, feeds the failures back so it fixes them (uses the `testCommand` from config if you don't name one).
- `--continue` resumes your most recent session — it recaps what was already done for the model and restores `/undo`.
- A live **token/$ meter** shows after each task and via `/cost` (cost is shown when the model's price is known; local models are free).
- **External MCP tools:** list servers under `mcpServers` in `.vibgrate/code.json` and the agent can call their tools (namespaced `mcp__<server>__<tool>`); read-only tools run freely, anything else is approved like a built-in mutating tool. VG Code also **adopts the standard MCP config files** already in your repo — `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), and `.vscode/mcp.json` (VS Code) — and merges them with your `.vibgrate/code.json` (which wins on any name clash), so servers you've already configured for another tool work here with no extra setup. Both local (`command`) and remote (`url`) servers are supported.

**Tools the agent has:** searching is the code graph (`search_code`) — not a grep — plus `read_file`, `list_files`, `graph_impact` (blast radius), **`library_docs`** (version-correct docs for a dependency you actually have installed, so the model uses the right API for your version), `edit_file`, `create_file`, `delete_file`, and `run_command`.

**Safety.** The agent never sends a secrets file (`.env`, keys, credentials) to the model, and redacts stray credential shapes from any file it reads. Under `--auto`, a denylist blocks catastrophic commands (filesystem wipes, `curl … | sh`, force-push, …); interactively you see and approve each command yourself.

**Configure once** in `.vibgrate/code.json` so you can then just run `vg code` (flags still override):

```json
{
  "provider": "ollama",
  "model": "qwen2.5-coder:7b",
  "testCommand": "npm test",
  "auto": false,
  "denyCommands": ["deploy", "kubectl\\s+delete"],
  "maxSteps": 24,
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] }
  }
}
```

It assembles a small, high-signal context from the map (the relevant symbols, their relations, the blast radius of changing them, and any hard constraints), asks the model you choose for a minimal edit, and applies that edit through a deterministic merge so the change lands exactly where it was meant to.

Writing is opt-in and confirmed. `--apply` walks the full inspect → assess → dry-run → approve → execute → verify → log lifecycle, and still requires your explicit `--yes` (or an interactive confirmation) — there is no write-without-consent path.

```bash
vg code "rename readCfg to readConfig everywhere it is called" --apply --yes
```

Pick a backend with `--provider` and `--model`. No model is bundled, and nothing is installed until you first use a backend that needs it:

- **Local** — `--provider ollama` or `--provider lmstudio` (or `--local` to force on-device only, no network).
- **Hosted** — any OpenAI-compatible endpoint: `--provider openrouter` / `litellm` / `openai` / `together`. API keys are read from the environment only (e.g. `OPENROUTER_API_KEY`), never passed as flags.

With no `--provider`, `vg code` chooses from what you have already configured (a hosted key, or a locally-pulled model) and never dials a cloud endpoint you didn't set up.

| Flag | Default | Description |
|------|---------|-------------|
| `<instruction>` | — | What to change, in plain language |
| `--provider <id>` | auto | `ollama`, `lmstudio`, `openrouter`, `litellm`, `openai`, `together`, `llama-cpp` |
| `--model <id>` | — | Model id (or set `VG_CODE_MODEL`) |
| `--file <path>` | — | Restrict the edit surface to this file (repeatable) |
| `--budget <n>` | `3000` | Approx context token budget |
| `--apply` | — | Write the change (still requires `--yes` or a confirmation) |
| `--yes` | — | Consent to write, or to a first-use package install, non-interactively |
| `--local` | — | On-device backends only; never touch the network |

Add `--json` for the full machine-readable result (proposed changes, diffs, and the verification summary), or `--out <file>` to write it for CI. Requires a map — run `vg` first if you have not built one.

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

Epistemic-typed: declared/static → observed/derived. Open facts (contract / invariant / characterization) ship on every build.

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
vg install --all
vg install --detect
vg install --list
vg uninstall <tools...>
vg uninstall cursor --purge
```

Idempotent and repo-local (changes can be committed and shared with your team).

**Supported assistant ids:** `claude`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini`, `grok`, `opencode`, `kilo`, `aider`, `factory`, `trae`, `kiro`, `amp`, `kimi`, `codebuddy`, `copilot-cli`, `pi`, `devin`, `hermes`, `openclaw`, `agents`

Run `vg install --list` for the live support matrix (ids can grow over time) — it shows, per assistant, whether the install writes an MCP registration, a skill, and a nudge.

**Where the MCP server is registered.** Each host reads its own config file, so `vg install` writes the one that host actually loads: `.mcp.json` (Claude Code), `.cursor/mcp.json`, `.windsurf/mcp.json`, `.vscode/mcp.json`, and `.grok/config.toml` (a `[mcp_servers.vg]` table — what `grok mcp add --scope project` writes). Assistants without an MCP entry in the matrix get the skill and nudge, and their AI reaches the graph through the `vg` CLI instead. Existing entries, sections, and comments in these files are preserved — only the `vg` entry is written.

| Flag | Description |
|------|-------------|
| `[tools...]` | Assistant ids to install for |
| `--all` | Install for every supported assistant |
| `--detect` | Detect assistants in use (repo footprint, home config, PATH) and install for those; with `--list`, only report what was detected |
| `--list` | Show the support matrix and exit |
| `--no-hook` | Skip the advisory nudge |

**`vg uninstall` flags:**

| Flag | Description |
|------|-------------|
| `<tools...>` | Assistant ids to remove (required) |
| `--purge` | Also delete the skill file |

`vg uninstall` only removes AI-assistant wiring. To remove the CLI package from the machine, use your package manager (`npm uninstall -g @vibgrate/cli`, etc.).

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

### vg llm-host

Thin **enterprise inference process** (ADR-005). Code Modes and install stay on `vg models`; this host only loads weights and decodes over a local socket when isolation is `process`.

```bash
vg llm-host status
vg llm-host serve                 # listen on the default runtime socket
vg llm-host serve --socket /tmp/vg-llm.sock --yes
```

Default isolation is **embedded** (same process as the agent). Set `VIBGRATE_INFERENCE_ISOLATION=process` to use the host. Management never moves into the host process.

**First-party weights.** For catalogued GGUF refs (e.g. Spark’s llama.cpp fallback), `vg models install` can download into the Vibgrate weight store under the cache directory (HTTPS hosts allowlisted, including Hugging Face LFS/Xet CDNs). Catalog entries carry **sha256 pins**; a download that does not match is rejected. Ollama remains the default pull channel for Code Mode packs that list `ollama` as primary.

**Foundry Local.** On Windows (or any host running Microsoft Foundry Local), use `--provider foundry-local --model <id>` with the OpenAI-compatible server (default `http://127.0.0.1:5272/v1`, override with `FOUNDRY_LOCAL_BASE_URL`). `vg models status` lists models when the server responds.

**Warm local inference (Approach B default).** Code Mode packs (channel 2026.07.3) install first-party GGUF weights when fit allows; Ollama is the fallback adapter. When a GGUF is on disk (weight store or `~/models`), `vg code` prefers embedded llama.cpp automatically. Set `VG_PREFER_OLLAMA=1` to force Ollama first. Spark constrained decoding is **fail-closed**: if the binding cannot attach a PatchIR grammar, generation errors instead of free-text (opt-in raw string GBNF only via `VG_ALLOW_GRAMMAR_STRING_FALLBACK=1`).

**Identifier enforce (before apply).** Edits and `apply_patch` that invent identifiers not present in the code graph are **blocked** (not merely annotated). Identifiers already in the target file (locals, params, existing helpers) and tokens only in comments/strings are allowed. After an approved edit, the session trie updates so new symbols become legal.

**Native logit mask (P1).** When node-llama-cpp exposes `TokenBias`, the warm host **boosts** tokens for graph identifiers and can **suppress** vocabulary tokens that are complete identifiers absent from the graph. Bias is cached per session/trie. Without `TokenBias`, generation still runs (post-scan annotation + enforce-before-apply remain).

**Dynamic open-identifier sampler (P2).** When enabled (`VG_LLM_ON_TOKEN=1` or `VG_LLM_CUSTOM_SAMPLER=1`, or a binding that declares the hook), the host tracks whether generation is inside a code identifier and rejects tokens that invent graph-unknown names mid-decode. Composed with grammar + TokenBias on the same `prompt()` call.

**Warm KV prefix reuse (P1/P2).** Prompt segments are content-hashed; after the first turn, stable system/capsule blocks are warm. A multi-turn **cursor** skips already-evaluated leading blocks and only re-evaluates the delta when the binding supports evaluate-without-generate, so multi-turn TTFT does not re-prefill the full capsule every step.

**Speculative drafts (P2).** Graph-verbatim draft candidates are **ranked** against the user ask; the host tries accept in score order (evaluate-without-generate when available).

**Shared host in vgd.** The daemon protocol includes `host-status`, `host-load`, `host-unload`, and `host-generate` so a long-lived process can keep a warm model for CLI and IDE clients (same session pool as embedded). Clients may pass a **client id** on load so unload is **refcounted** — CLI and VS Code can share one warm model without the first exit killing the session.

**Hardware default mode.** `vg models mode --apply-recommend` pins the Code Mode recommended from free RAM/VRAM and repo size when no default is set. `vg doctor` surfaces the same recommendation under `localInference`.

**Coding metrics (release).** `vg models coding-metrics` builds a `coding-metrics/0` report: host-bench arms + gates + offline Fusion FCS/ZNS trajectory pack. Default host mode is **simulate** (no GPU). CI runs simulate+gate on PRs; CLI publish opens a website data PR under `data/benchmarks-coding/` (human review before public claims), same pattern as CLI release benchmarks.

**Host bench (P3).** `vg models host-bench` runs Approach B measurement arms (Ollama baseline, embedded warm, grammar, identifier enforce, TokenBias, dynamic sampler, KV delta). Default **simulate** exercises the warm host without a GPU; `--mock` is registry shells only; `--live --model-path <gguf>` is operator hardware. Add `--gate` to evaluate release gates (exit code **2** on hard failure). Use `--json` for CI artifacts.

---

### vg models

**Code Modes** (Spark / Flow / Forge) for VG Code, plus the **local model fleet** (Ollama, LM Studio, and on-disk `gguf` files). The default view is outcome-oriented: which mode fits this machine and repo, which pack backs it, and whether it is ready.

**Named install commands run by default** (same polarity as the rest of `vg`: the command does what it says). Pass `--dry-run` to print the plan only. Status/resolve never download. Destructive `rm` confirms on a TTY; non-interactive remove needs `--yes`.

`install` / `pull` install the **full provider dependency closure** for the pack (e.g. runtime npm deps for llama-cpp, then weight download for Ollama). Third-party apps such as Ollama itself are never auto-installed — install them separately if the plan lists them as blocked.

```bash
vg models                 # Code Modes status + fleet summary
vg models --raw           # local models only
vg models status
vg models mode [spark|flow|forge]
vg models resolve [mode]  # pack + model + fit (no download)
vg models install [mode]  # install the pack (add --dry-run to preview)
vg models pin <packId>
vg models unpin <mode>
vg models packs
vg models pull <name>     # download (add --dry-run to preview)
vg models uninstall <name> # uninstall (TTY confirm; --yes for CI; --dry-run to preview)
vg models host-bench      # Approach B measurement arms (default: simulate, no GPU)
vg models coding-metrics  # host-bench + Fusion FCS/ZNS report (coding-metrics/0)
vg models catalog
```

| Mode | Intent |
|------|--------|
| **Spark** | Fast, small footprint — quick edits and tight memory |
| **Flow** | Balanced default for day-to-day coding |
| **Forge** | Heavier pack when you have headroom and want more capacity |

| Subcommand / flag | Description |
|-------------------|-------------|
| `--raw` | Skip Code Modes; list discovered local models only |
| `mode [spark\|flow\|forge]` | Show or set the default Code Mode (`--auto` clears a fixed default) |
| `resolve [mode]` | Resolve pack + underlying model + fit without downloading |
| `install [mode]` | Resolve and install the pack (`--dry-run` for plan only) |
| `pin <packId>` / `unpin <mode>` | Pin or clear a reproducible pack (e.g. `flow@2026.07.1`) |
| `packs` | List qualified Code Mode packs |
| `pull <name>` | Download via local runtime (default Ollama; `--dry-run` for plan only) |
| `uninstall <name>` | Uninstall a local model — Ollama, LM Studio, or GGUF (`--dry-run` plan; TTY confirm or `--yes`; `--runtime` optional auto-detect) |
| `host-bench` | Approach B measurement arms (`--simulate` default, `--mock`, `--live --model-path`, `--gate`) |
| `coding-metrics` | Unified host-bench + Fusion FCS/ZNS report (`--out`, `--gate`, `--version`); publish path for release |
| `catalog` | Live hosted model catalog (cached; not used under `--local`) |
| `--json` | Machine-readable JSON on stdout |

```bash
vg models pull qwen2.5-coder:7b
vg models pull qwen2.5-coder:7b --dry-run   # plan only
```

| Flag | Default | Description |
|------|---------|-------------|
| `<name>` | — | Model to pull or uninstall, e.g. `qwen2.5-coder:7b` or a `.gguf` basename |
| `--runtime <id>` | pull: `ollama` · uninstall: auto | Runtime (`ollama`, `lm-studio`, `gguf`). Uninstall auto-detects from the installed fleet when omitted. |
| `--dry-run` | — | Print the plan only; do not download or uninstall |
| `--yes` | — | Skip interactive confirms (required for non-interactive `uninstall`) |

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

**The map stays fresh while you (or your AI) edit code.** Each tool call runs a cheap stat-only freshness check against the last build; when files really changed, the server rebuilds the map incrementally in-process — only changed files re-parse — and answers from the updated graph. Probes are debounced with a self-tuning cadence (2s floor, scaling with measured probe cost so probing never exceeds a few percent of serve time even on very large repos), rebuilds are single-flight and cross-process locked, and touch-only changes (a `git checkout`, a re-save with identical content) are recognized by content hash and never trigger a rebuild. There is no filesystem watcher: freshness is checked exactly when it matters — at query time. (`vg daemon` is a separate optional process for multi-workspace IDE/agent sessions; `vg serve` does not require it.) The server also hot-reloads `graph.json` whenever it changes on disk, so an external `vg` build is picked up on the next call too.

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

## Diagnostics, IDE & runtime

Setup health, IDE language server, local workspace daemon, and context-policy pins.

**Typical path:** `vg doctor` → `vg lsp` → `vg daemon`

### vg daemon

Local workspace daemon for multi-root graph sessions used by IDE extensions and coding agents. Tracks registered repository roots, can load a built map into an in-memory active graph, and answers structural queries and impact over a local socket. Does not rewrite your source tree.

Most developers never need this directly — Vibgrate for VS Code and `vg code` attach when needed. Use the CLI for explicit control, multi-root federation, or scripting.

```bash
vg daemon status
vg daemon ensure
vg daemon start
vg daemon stop
vg daemon restart
vg daemon register
vg daemon list
vg daemon federation
vg daemon publish
vg daemon query "<text>"
vg daemon impact <symbol>
vg daemon graphs
```

| Subcommand | Description |
|------------|-------------|
| `status` | Whether the daemon is running and how many workspaces it tracks |
| `start` | Run in the foreground (Ctrl-C to stop) |
| `ensure` | Start in the background if not already running (idempotent; for hosts and agents) |
| `stop` | Stop the running daemon (idempotent — succeeds if none is running) |
| `restart` | Stop the daemon if running, then start it in the background (`vg update` does this automatically after installing a new version) |
| `register [root]` | Register the current (or given) repository with a running daemon |
| `list` | List registered workspaces |
| `federation [root]` | Register a multi-root federation from `.vibgrate/federation.json` (or primary cwd) |
| `publish [root]` | Load the workspace code map into the daemon active graph (run `vg build` first). The daemon reads the map from disk itself, binary snapshot first — nothing heavy crosses the socket |
| `query <query...>` | Lexical/structural query against the active graph |
| `impact <symbol>` | Blast radius for a symbol in the active graph |
| `graphs` | List multi-branch graph slots currently resident |

| Flag | Description |
|------|-------------|
| `--socket <path>` | Override the local socket path |
| `--repository-id <id>` | On `query` / `impact` / `graphs`: target a workspace id from `vg daemon list` |
| `--git-ref <ref>` | On `publish` / `query` / `impact`: branch or SHA |
| `--limit <n>` | On `query`: max matches (default 12) |
| `--depth <n>` | On `impact`: max dependency depth (default 4) |
| `--json` | Machine-readable JSON on stdout |

Typical host flow:

```bash
vg build
vg daemon ensure
vg daemon publish
vg daemon query "payment service"
```

---

### vg doctor

One read-only diagnostic pass over setup: which config file won, which credential source won (secrets never printed), whether a code map exists and how fresh it is, hosted catalog reachability, what `vg install` would register as the MCP launch, telemetry opt-outs, and **local inference** (Code Mode recommendation from free RAM/VRAM, weight catalog pin status, warm host pool size, isolation / sampler env). Prints state; changes nothing.

```bash
vg doctor
vg doctor --json
vg doctor --local
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON on stdout |
| `--local` | Skip the hosted reachability probe |
| `-C, --cwd <dir>` | Run as if started in that directory |

---

### vg lsp

Start the Vibgrate language server over **stdio** — the shared engine behind **Vibgrate for VS Code** and other thin IDE clients. Editors spawn this; humans rarely run it by hand.

```bash
vg lsp
vg lsp --diagnostics
vg lsp --no-graph
vg lsp --no-semantic
vg lsp --local
```

| Flag | Description |
|------|-------------|
| `--diagnostics` | Also publish Problems-panel diagnostics (EOL runtime, unmaintained packages, license change). **Off by default** — drift is not a defect, and the Problems panel is not filled by default. |
| `--no-graph` | Skip the local code graph entirely: no background build; graph queries report it as turned off |
| `--no-semantic` | Never use semantic search for graph queries (lexical only; embedding model is not downloaded) |
| `--local` | Never touch the network (air-gapped editor sessions) |

The process owns stdin/stdout until the client sends `shutdown` + `exit`. Speaks standard LSP plus a custom `vibgrate/score` notification carrying the DriftScore and its **band** (never a colour) so clients can theme correctly.

---

### vg policy

Show the production **context-policy** pin used by VG Code ranking, and verify a signed `context-policy-patch/0` JSON file before any release that would bump it. Learning never mutates production policy from a single task.

This is not the hosted workspace policy UI in Vibgrate Cloud (banned packages, drift budgets). For dependency bans in CI, use `vg drift --fail-on standards` with a committed standards file.

```bash
vg policy
vg policy --json
vg policy verify ./context-policy-patch.json
```

| Subcommand | Description |
|------------|-------------|
| *(default)* | Print production pin and ranking version |
| `verify <file>` | Verify a `context-policy-patch/0` JSON file (hash + optional signature + production gate) |

Exit non-zero from `verify` when the production gate is not ready (so CI can block a premature bump).

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
- [Vibgrate Cloud MCP](https://vibgrate.com/mcp)
- [AI agent skills](https://vibgrate.com/skills)
- [Glossary](https://vibgrate.com/glossary)
- [Help center](https://vibgrate.com/help)
- [Changelog](https://vibgrate.com/changelog)
- [npm](https://www.npmjs.com/package/@vibgrate/cli)

---

Copyright © 2026 Vibgrate. All rights reserved. See [LICENSE](https://vibgrate.com/license) for terms.
