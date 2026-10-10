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
    - [Report format coverage](#report-format-coverage)
  - [vg review](#vg-review)
  - [vg sbom](#vg-sbom)
    - [Choosing CycloneDX or SPDX](#choosing-cyclonedx-or-spdx)
    - [Component identity](#component-identity)
    - [Package digests](#package-digests)
    - [CycloneDX type and SPDX primaryPackagePurpose](#cyclonedx-type-and-spdx-primarypackagepurpose)
    - [Production, development, and optional scope](./docs/sbom-dependency-scope.md)
  - [vg scan](#vg-scan)
    - [Unknown lockfile fields](#unknown-lockfile-fields)
    - [Offline scan with a package-version manifest](#offline-scan-with-a-package-version-manifest)
    - [Vulnerabilities and exposure attribution](#vulnerabilities-and-exposure-attribution)
      - [Go modules: pseudo-versions and +incompatible](#go-modules-pseudo-versions-and-incompatible)
    - [Maven and Gradle manifests](#maven-and-gradle-manifests)
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
    - [Sign and check the map](#sign-and-check-the-map)
    - [Maven and Gradle manifests](#maven-and-gradle-manifests)
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
    - [Lockfile pin](#lockfile-pin)
    - [When a lookup fails](#when-a-lookup-fails)
  - [vg locale](#vg-locale)
  - [vg map / vg hubs / vg areas / vg oddities](#vg-map--vg-hubs--vg-areas--vg-oddities)
  - [vg llm-host](#vg-llm-host)
  - [vg models](#vg-models)
  - [vg module](#vg-module)
  - [vg path](#vg-path)
  - [vg savings](#vg-savings)
  - [vg serve](#vg-serve)
  - [vg share](#vg-share)
  - [vg show](#vg-show)
  - [vg status](#vg-status)
  - [vg tests](#vg-tests)
  - [vg tree](#vg-tree)
  - [vg unknowns](#vg-unknowns)
- [Context compression](#context-compression)
  - [vg serve --compress](#vg-serve---compress)
  - [vg install --compress / vg uninstall](#vg-install---compress--vg-uninstall)
  - [vg savings / vg show savings](#vg-savings--vg-show-savings)
  - [vg install --learn](#vg-install---learn)
  - [vg serve memory](#vg-serve-memory)
  - [vg serve compress / vg serve retrieve](#vg-serve-compress--vg-serve-retrieve)
  - [Configuration reference (`VG_*`)](#configuration-reference-vg_)
  - [SDK](#sdk)
- [Holistic Code Specification (vg hcs)](#holistic-code-specification-vg-hcs)
  - [vg hcs extract](#vg-hcs-extract)
  - [vg hcs digest](#vg-hcs-digest)
  - [vg hcs map](#vg-hcs-map)
  - [vg hcs gate](#vg-hcs-gate)
  - [vg hcs validate](#vg-hcs-validate)
- [Diagnostics, IDE & runtime](#diagnostics-ide--runtime)
  - [vg daemon](#vg-daemon)
  - [vg doctor](#vg-doctor)
  - [vg lsp](#vg-lsp)
  - [vg policy](#vg-policy)
- [DriftScore](#driftscore)
- [Drift Baselines & Fitness Functions](#drift-baselines--fitness-functions)
  - [Record and refresh](#record-and-refresh)
  - [CI gates](#ci-gates)
  - [Suppressions](#suppressions)
  - [What to commit](#what-to-commit)
  - [CI example](#ci-example)
  - [How the Score Is Calculated](#how-the-score-is-calculated)
  - [Risk Levels](#risk-levels)
  - [Score Components](#score-components)
- [Output Formats](#output-formats)
  - [Text](#text)
  - [JSON Artifact](#json-artifact)
  - [SARIF](#sarif)
    - [Result fingerprints](#result-fingerprints)
    - [Advisories with several ids](#advisories-with-several-ids)
  - [Markdown](#markdown)
  - [JUnit](#junit)
- [Configuration](#configuration)
  - [vibgrate.config.ts](#vibgrateconfigts)
  - [Thresholds](#thresholds)
  - [Scanner Toggles](#scanner-toggles)
  - [Symlinks](#symlinks)
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
- [Troubleshooting: registry, auth, and network](#troubleshooting-registry-auth-and-network)
- [Privacy & Security](#privacy--security)
- [Exit Codes](#exit-codes)
- [Warning codes](#warning-codes)
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
- **Java** (`pom.xml`, Gradle-style manifests). Which Maven profiles, scopes, and Gradle configurations become a `vg scan` row or a `vg build` edge is in [Maven and Gradle manifests](#maven-and-gradle-manifests).

**Known-vulnerability detection** (`--vulns`) and **dependency attribution** (`vg why`, exposure windows) additionally cover npm / pnpm / yarn, pip / poetry / pipenv, cargo, composer, bundler, pub, hex, NuGet, and Maven/Gradle, read from each project's lockfile. Go is matched from direct `require` lines in `go.mod`. Pseudo-versions and `+incompatible` tags follow [Go modules: pseudo-versions and +incompatible](#go-modules-pseudo-versions-and-incompatible).

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

Run a full scan and write `.vibgrate/baseline.json`. There is no `create` or `update` subcommand. Running the command again overwrites that file. That second run is how you refresh the snapshot after planned upgrades land on the main branch.

```bash
vg baseline [path]
```

`[path]` is the project directory to scan. It defaults to `.`. The file is always `<path>/.vibgrate/baseline.json`.

Gating, suppressions, what to commit, and a CI example: [Drift Baselines & Fitness Functions](#drift-baselines--fitness-functions).

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
vg evidence release <product> <version> [--from <sbom-or-scan>] [--image <ref>] [--buildkit-metadata <file>] [--provenance <file>] [--ship-date <date>] [--build-id <id>] [--digest <sha256>] [--markets DE,FR]
vg evidence exposure <vuln> [--regime <id>] [--advisory <file>] [--offline] [--as-of <date>] [--products <substr>] [--include-eol] [--format table|json] [--pack --stage <stage>] [--bundle <dir>] [--tsa <url>]
vg evidence readiness [--regime <id>] [--format table|json]
vg evidence support-period <product> [--from <date>] [--until <date>]
vg evidence pack <vuln> [--regime <id>] [--stage <stage>] [--advisory <file>] [--offline] [--out <file>]
vg evidence drill [--regime <id>] [--scenario <name>] [--elapsed <seconds>]
vg evidence watch [--regime <id>] [--since <date>] [--webhook <url>] [--format table|json]
vg evidence verify <bundle> [--pub <file>]
vg evidence push [--result <bundle-or-file>] [--regime <id>] [--dsn <dsn>] [--no-releases]
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
| `vg evidence push` | Push the product registry, every frozen release manifest, and an optional signed exposure bundle to Vibgrate Cloud, which verifies the signature |
| `vg evidence export` | Air-gap bundle of all evidence state |

`release` freezes the manifest from a Vibgrate scan artifact or an SBOM — CycloneDX, SPDX, or either one wrapped in an in-toto / DSSE **SBOM attestation**. Where the artefact is a container image, it can also take the facts straight from what BuildKit wrote instead of values typed in by hand: `--buildkit-metadata` reads the `docker buildx build --metadata-file` output for the image digest and build reference; `--provenance` reads a SLSA provenance attestation for the source repository, commit, and base images; and `--image <ref>` asks Docker for the image's digest, `org.opencontainers.image.*` labels, and any attached provenance and SBOM attestations (an attached SBOM becomes the manifest when `--from` is not given). `--image` runs `docker image inspect` and `docker buildx imagetools inspect`; the second contacts the image's registry when the reference is not present locally. Those facts are stored under `build` in the frozen manifest. A typed `--digest` that disagrees with what the build wrote is an error, never a silent preference, and attestation signatures are recorded as unverified — verify them with `cosign`.

A `--from` file that is truncated, not valid JSON, or a CycloneDX or SPDX document missing a required field exits `1`. The message names that file and the format it expected: CycloneDX JSON with `bomFormat`, `specVersion`, and `version`, or SPDX JSON with `spdxVersion`, `SPDXID`, and `name`. It says to regenerate the SBOM and run the command again. The document and any home directory stay out of the message. A component or package missing `name` fails the command. The same check applies to an SBOM attached to an image. An unversioned component stays out of the frozen manifest: both formats allow a component without a version, and a manifest records a concrete one.

`push` sends the product registry, every frozen release manifest (components, artefact digest, and the build facts read from BuildKit), and — when `--result` points at a bundle directory — the exposure result with its DSSE envelope and RFC 3161 token. Vibgrate Cloud verifies the signature itself and records the outcome as `intact`, `failed` or `absent`; it never takes a flag's word for it (the old `--signed` flag is accepted and ignored). Bodies above the 10 MB limit drop component lists from the oldest releases first and say so; `--no-releases` omits the manifests entirely. In Vibgrate Cloud → Govern ▸ Evidence the frozen releases appear with their chain of custody, every component is searchable across releases, and each ledger entry offers its archived bundle for download.

`exposure` matches against manifests **frozen at ship time**, not the current tree, and never guesses: a bound product with no frozen manifest returns `undetermined` with a reason. It runs fully `--offline` against a local advisory file, and can emit a signed evidence bundle (`--bundle <dir>`) that `vg evidence verify` checks offline with honest `verified` / `unverified` / `failed` states. Pass `--tsa <url>` to anchor the bundle to a trusted **RFC 3161** timestamp (`timestamp.tsr`), fully verifiable with `openssl ts -verify`.

`watch` joins the CISA **Known Exploited Vulnerabilities (KEV)** catalog to the components in your frozen manifests (via OSV) and reports any KEV-listed vulnerability that affects a shipped release — alerting via stdout or `--webhook`. It **surfaces the KEV listing**; whether a vulnerability is "actively exploited" for a filing is your determination, not the tool's.

**Exit codes** (CI-usable): `0` no exposure · `2` exposure found · `3` undetermined (manual review) · `1` operational error.

If a command cannot serialize or write a JSON or JSONL file — permission denied, a missing parent directory, a path that is a directory, a full disk, or a value that cannot be serialized — that is an operational error. The command exits `1`. The message names the file. Check the path and permissions, or choose another `--out` or `--bundle`.

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
vg fix --kind patch --yes    # group and apply just the patch-level bumps
vg fix --packages "lodash,chalk" --yes  # group and apply exactly this batch
```

**Grouping, instead of one PR per package.** `--packages` and `--kind` narrow
planning to a specific batch — every patch bump, every minor bump, or an
explicit package list — so a CI job or an editor integration can open one PR
per batch instead of a constant stream of single-package PRs. The two compose:
`--packages "a,b,c" --kind minor` plans+applies only the minor bumps among
those three. Each batch still goes through the full hosted planner, so
cross-package conflicts *within that batch* (e.g. two packages that would pin
a shared peer dependency to incompatible ranges once bumped together) are
still caught — a conflict blocks apply unless you pass `--force`.

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
| `--packages <names>` | Plan/apply only these packages (comma-separated) — for grouping a specific batch instead of every drifted dependency. |
| `--kind <patch\|minor\|major>` | Plan/apply only upgrades of this semver bump kind. Combine with `--packages` to target one Dependabot-style batch. |
| `--force` | Apply a plan even if the planner flagged a blocking cross-package conflict within it. |
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

Render a saved scan artifact. The formats are `md`, `text`, `json`, and `html`.
`text` is the default. `json` prints the artifact unchanged and is the only
stable machine-readable contract. `sarif` is not a `vg report` format; write
that with `vg scan --format sarif`.

```bash
vg report [--in <file>] [--format md|text|json|html]
```

| Flag       | Default                      | Description                                                                      |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `--in`     | `.vibgrate/scan_result.json` | Input artifact file                                                              |
| `--format` | `text`                       | `md`, `text`, `json`, or `html`. Any other value is a usage error (exit `5`)     |

An unknown value is rejected before the file is read. The process exits `5`,
writes nothing to stdout, and prints one stderr line that names the value and
lists the valid ones:

```text
error: unknown --format "sarif" (expected md, text, json, html)
```

The comparison is exact. `HTML`, `sarif`, and `md ` are unknown. Omitting
`--format` stays on `text`.

`md`, `text`, and `json` are unchanged. `html` writes one self-contained page
from that same artifact. It does not call the network and does not load
external files. The page opens with a summary:

- DriftScore and the four component scores. A missing score is `n/a`. A measured `0` stays `0`.
- Counts by severity for vulnerability findings and for security findings. A check that did not run stays "Not scanned" rather than a row of zeros. A check that finished with nothing to report shows zeros.
- When a finding carries `details.fixedVersions`, how many of those findings name a fix.
- Links to the full tables under the summary: vulnerabilities, security findings, and the other findings.

The same artifact always produces the same page. Save it with a shell redirect:

```bash
vg report --format html > report.html
```

#### Report format coverage

`--format md` is `formatMarkdown` (`src/reporting/formatters/markdown.ts`).
`--format text` is `formatText` (`src/reporting/formatters/text.ts`).
`--format html` is `formatHtmlReport` (`src/reporting/formatters/html.ts`).
All three read the same artifact. A section below is omitted when its guard is
false. Lists follow artifact order except where a sort is named. Colours in the
text report are terminal styling; under `NO_COLOR` the same words are plain. A
null score is `n/a` in the human formats. A measured `0` stays `0`.

The same artifact, four formats:

```bash
vg report --in .vibgrate/scan_result.json --format md
vg report --in .vibgrate/scan_result.json --format text
vg report --in .vibgrate/scan_result.json --format json
vg report --in .vibgrate/scan_result.json --format html
```

##### Markdown (`formatMarkdown`)

Always:

| Section | Fields |
| --- | --- |
| Title | `# Vibgrate Drift Report` |
| Metrics table | **DriftScore** — `n/a`, or `{drift.score}/100` plus `_(lower is better; 0 = no drift)_`. **Risk Level** — `drift.riskLevel` uppercased, or `n/a` when it is missing. **Projects** — `projects.length`. **Scanned** — `timestamp`; when set, `durationMs` as seconds with one decimal, `filesScanned` as `{n} files`, and `treeSummary` as `{totalFiles} workspace files · {totalDirs} dirs`. **VCS** — `vcs.type`, only when `vcs` is set. **Branch** — `vcs.branch`, when set. **Commit** — `` `vcs.shortSha` ``, only when `vcs.sha` is set |
| Score Breakdown | `drift.components.runtimeScore`, `frameworkScore`, `dependencyScore`, `eolScore` |
| Projects | One `### {name} ({type})` per project. **Runtime**, when `runtime` is set: the runtime, then ` — {runtimeMajorsBehind} major(s) behind` when that count is greater than 0, otherwise ` — current`. **Frameworks**, when the list is non-empty: `name`, `currentVersion` or `?`, `latestVersion` or `?`, and `majorsBehind` as `current` (`0`), `{n} behind`, or `unknown` (`null`). **Dependencies**, when `current + oneBehind + twoPlusBehind + unknown` is greater than 0: those four `dependencyAgeBuckets` counts |

When the artifact carries the data:

| Section | Guard and fields |
| --- | --- |
| Product Purpose Signals | `extended.uiPurpose`. **Frameworks** — `detectedFrameworks`, or `unknown`. **Evidence Items** — `topEvidence.length`, plus `(capped from {evidenceCount})` when `capped` is set. **Top Evidence** — the first 10 of `topEvidence`: `kind`, `value`, `file`. **Unknowns** — the first 5 of `unknownSignals` |
| Recommended Standards | `extended.standards.recommended` is non-empty. **Detected purpose** — `projectPurposes` as `{project} → {category}`, when that list is non-empty. **Compliance framework coverage** — `frameworks`: `name`, `recommendedMembers`, `totalMembers`. **Top standards to consider** — the first 10 of `recommended`: `name`, `reason`, and `_(compliance)_` when `complianceRelevant` is set |
| Findings | `findings` is non-empty. Table of `level` (error, warning, or anything else), `ruleId`, the stored `message`, and `location` |
| Drift Delta | `delta` is set. The signed number, `vs baseline`, and `_(worsened)_` when positive, `_(improved)_` when negative, or neither when zero |
| Baseline suppressions | `baselineComparison.compared` is true. `{n} finding suppressed by baseline` or `{n} findings suppressed by baseline`, where `n` is `baselineComparison.suppressed.length` |

##### Text (`formatText`)

Always, including an artifact with no projects:

| Section | Fields |
| --- | --- |
| Banner | The word `vibgrate` and `Code Intelligence Engine v` plus the running CLI version. This version is not a field of the artifact |
| Title | `Vibgrate Drift Report` |
| DriftScore Summary | **DriftScore** — `n/a` or `{drift.score}/100`. **Risk Level** — `LOW`, `MODERATE`, or `HIGH` for `low`, `moderate`, and `high`; the raw string for any other non-empty level; `n/a` when missing. **Projects** — `projects.length`. **VCS**, when `vcs` is set — `vcs.type`, then `vcs.branch` and `vcs.shortSha` when those are set |
| Score Breakdown | The same four component scores as Markdown, each drawn as a bar when measured |
| Footer | `Scanned at {timestamp}`; when set, `durationMs` as seconds with one decimal, `{n} file scanned` or `{n} files scanned`, `{treeSummary.totalFiles} workspace files`, and `{treeSummary.totalDirs} dirs` |

Per project, in artifact order:

| Line | Guard and fields |
| --- | --- |
| Heading | `name`, `type`, `path` |
| Runtime | `runtime` when set, and `runtimeMajorsBehind` as `{n} major` or `majors behind` when greater than 0, otherwise `current` |
| Target | `targetFramework` when set |
| Frameworks | Same version fields as Markdown (`name`, `currentVersion`, `latestVersion`, `majorsBehind`) |
| Dependencies | The four `dependencyAgeBuckets` counts when their sum is greater than 0 |

When set:

| Section | Guard and fields |
| --- | --- |
| Drift Delta | `delta` is set. The signed number and `(vs baseline)`. Zero prints `0`. No worsened or improved word |
| Baseline suppressions | Same sentence as Markdown, when `baselineComparison.compared` is true |
| Tech Stack | `extended.toolingInventory` has a category with items. Category label, then each item's `name`. Labels: Frontend, Meta-frameworks, Bundlers, CSS / UI, Backend, ORM / Database, Testing, Lint & Format, API & Messaging, Observability, Payment, Auth, Email, Cloud, Databases, Messaging, CRM & Comms, Storage, Search & AI. An unlisted category key is printed as stored |
| Services & Integrations | `extended.serviceDependencies`, same category labels. Each item's `name`, and `version` when set |
| Breaking Change Exposure | `extended.breakingChangeExposure` has a deprecated package or a legacy polyfill. `exposureScore`, `deprecatedPackages`, `legacyPolyfills`, a peer-conflict line when `peerConflictsDetected` is set, `overallRecommendation`, and up to 3 `projectIntelligence` rows that have packages (project `project` and `recommendation`; up to 2 packages: `package`, `currentVersion`, `targetVersion`, `usage.touchedPercent`, `automatable`) |
| TypeScript | `extended.tsModernity.typescriptVersion` is set. The version, `strict` (`strict` is omitted when it is neither true nor false), `moduleType`, and `target` |
| Build & Deploy | `extended.buildDeploy` has CI entries, a Dockerfile, or a package manager. `ci`, Docker `dockerfileCount` and `baseImages`, `packageManagers`, `monorepoTools`, `iac` — each line only when that list or count is non-empty |
| Product Purpose Signals | `extended.uiPurpose`. `detectedFrameworks` or `unknown`. Evidence count is `topEvidence.length`, and `of {evidenceCount} (capped)` when `capped` is set. **Top Signals** — the first 8 of `topEvidence`: `kind`, `value`, `file`. **Unknowns** — the first 4 of `unknownSignals` |
| Security Posture | `extended.securityPosture`. `lockfilePresent`, `gitignoreCoversEnv`, `gitignoreCoversNodeModules`. `multipleLockfileTypes` and `envFilesTracked` only when true |
| Platform | `extended.platformMatrix` has a native module or a Docker base image. `nativeModules` when non-empty. `osAssumptions` when non-empty. `dockerBaseImages` only decides whether the section exists; it is not its own line |
| Code Quality | `extended.codeQuality`. `filesAnalyzed`, `functionsAnalyzed`, `avgCyclomaticComplexity`, `avgFunctionLength`, `maxNestingDepth`, `circularDependencies`, `deadCodePercent`. **God files** — the first 3 of `godFiles`: `path`, `lines` |
| Database Schema | `extended.databaseSchema`. `providers`, model count, enum count. **Sources** when models use more than one `source`, sorted by source name. **Models** — the first 5 `name`s, then a remaining count |
| Dependency Graph | `extended.dependencyGraph.lockfileType` is set. `lockfileType`, `totalUnique`, `totalInstalled`. Duplicated count when `duplicatedPackages` is non-empty. Phantom count when `phantomDependencies` is non-empty |
| Findings | `findings` is non-empty. Counts of `error`, `warning`, and `note`. Each row is the message from `humanFindingText`, then `ruleId` and `location`, then a hint when that helper returns one. The helper drops a stored ` — no fix available` and adds `fix available (...)` from `details.fixedVersions` only when the message does not already contain `fix available` |
| Top Priority Actions | Up to five derived lines, highest severity first. Each line has a title and an explanation; **Impact** is printed only for the runtime, framework, and dependency-rot actions. The triggers are: a runtime `runtimeMajorsBehind` of 3 or more; a framework `majorsBehind` of 3 or more; a project whose `twoPlusBehind / (current + oneBehind + twoPlusBehind)` is at least 40 percent; a framework exactly 2 majors behind; any deprecated package or legacy polyfill on `breakingChangeExposure`; 10 or more `phantomDependencies`; `securityPosture.envFilesTracked` or a missing lockfile; 3 or more `duplicatedPackages` that each have 3 or more versions. Explanations quote project `path`, runtime `runtime` / `runtimeLatest`, framework versions, dependency `package` / `resolvedVersion` or `currentSpec` / `latestStable` / `majorsBehind`, and the matching posture or graph fields |
| Architecture Layers | `extended.architecture`. `archetype`, `archetypeConfidence`, `totalClassified`, `unclassified`. **Folders** — the first 12 of `folders`: `path`, `layer`, `confidence`, `fileCount`. **Coverage**, when set — `ratio`, `classified`, `unclassified`, and `bySource` counts sorted by count descending then source name. **Unclassified source** — `unclassifiedFiles.length` when that list is non-empty. **Unclassified by folder** — the first 8 of `unclassifiedFolders`: `count`, `path`. **Layers** with `fileCount` greater than 0: `layer`, `fileCount`, `driftScore`, `riskLevel`. **Boundary violations** — violations whose `rule` does not start with `graph-conflict:`, first 8: `fromFile`, `toFile`, `rule`. **Layer conflicts** — the `graph-conflict:` violations, first 8, same three fields. A capped violation list is marked when `violationsCapped` is set |
| Solution Drift Summary | `solutions` is non-empty. `name`, `projectPaths.length`, and `drift.score` or `n/a` |

`relationshipDiagram` is not rendered. Markdown, text, and HTML leave that diagram in the JSON artifact.

##### HTML (`formatHtmlReport`)

`vg report --format html` writes one self-contained page from the same artifact. It does not call the network and does not load external files. The page opens with the summary listed above (DriftScore, severity counts, a fix-available count when a finding carries `details.fixedVersions`, and links to the tables), then the full vulnerability, security, and other-finding tables. A check that did not run stays "Not scanned". A missing score is `n/a`. The same artifact always produces the same page.

##### Differences

- Markdown is a short table. Text is the terminal report: banner and CLI version, project `path` and `targetFramework`, the extended sections above, findings with a fix hint, derived priority actions, architecture, solutions, score bars, and the scanned-at footer.
- Markdown prints **Recommended Standards**. Text does not.
- Text prints Tech Stack, Services, Breaking Change Exposure, TypeScript, Build & Deploy, Security Posture, Platform, Code Quality, Database Schema, and Dependency Graph. Markdown does not.
- Product purpose: Markdown shows 10 evidence rows and 5 unknowns (`Evidence Items`, `Top Evidence`). Text shows 8 and 4 (`Evidence`, `Top Signals`).
- Findings: Markdown prints the stored `message` in a table. Text prints counts plus `humanFindingText` (the stored message, a removed ` — no fix available`, and the fix hint).
- Drift delta: Markdown adds `_(worsened)_` or `_(improved)_`. Text prints the signed number only.
- DriftScore: Markdown puts the lower-is-better gloss in the opening cell. Text puts the score in **DriftScore Summary** without that gloss.
- VCS: Markdown uses separate VCS, Branch, and Commit rows, and Commit requires `vcs.sha`. Text uses one line and can show `shortSha` without requiring `sha`.
- Runtime wording: Markdown always says `major(s)`. Text says `major` or `majors`.
- HTML is the browser page: the summary above, then the vulnerability, security, and other-finding tables. It does not print Markdown's recommended-standards section or the text inventory.

##### JSON

`--format json` prints `JSON.stringify` of the loaded artifact with a two-space indent. Keys, values, and omissions are unchanged. Parse this when a script needs a field. Markdown, text, and HTML drop fields, cap lists, and add derived lines; they are not a stable contract.

---


### vg review

**Vibgrate Review** — architecture and security-control review of the change you
just made, run locally from the code map. Where `vg scan` answers "how far behind
is the stack?", `vg review` answers a different question about the same
repository: *did this change move the system toward its declared architecture,
weaken a security control, or create an implication the author did not account
for?*

```bash
vg review                            # the working tree + index, vs HEAD
vg review --in-place                 # the same, stated explicitly
vg review --local                    # deterministic scanners; no hosted model
vg review --loop                     # review → deterministic patch → re-review
vg review --base origin/main         # merge-base of HEAD and the base branch
vg review explain arch:<rule>:<path> # the evidence behind one finding
vg review findings-from-diff         # deterministic graph/policy findings only
vg review groups --base origin/main  # the change grouped for reading
vg review doc --base origin/main     # the review document, every claim pinned to lines
vg review propose blast:<node_id> --model forge --json
```

| Flag                  | Default | Description                                                                |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| `--in-place`          | off     | Review the working tree as-is (already the default without `--base`)        |
| `--local` (global)    | off     | Deterministic pass on this machine — never a hosted model (implies `--offline`) |
| `--loop`              | off     | Explicit review → apply deterministic patches → re-review. Never automatic. CLI only. |
| `--base <ref>`        | —       | Review HEAD against the merge-base with `<ref>`                             |
| `--format <fmt>`      | `text`  | `text`, `json` (the receipt), `sarif` (security findings only), `md`        |
| `-o, --out <file>`    | —       | Write the formatted result to a file                                        |
| `--push`              | off     | Send the receipt to Vibgrate Cloud (needs a DSN)                            |
| `--fail-on <level>`   | from config | Gate CI on this decision: `none`, `fail`, or `needs_review`              |
| `--explain`           | off     | Add local-model explanations. **Requires a local model; fails closed (exit 6) without one** |
| `--include-spans`     | off     | Include evidence line ranges in the pushed receipt                          |
| `--include-snippets`  | off     | Include capped source snippets in the pushed receipt (explicit opt-in)      |
| `--offline` (global)  | off     | Never touch the network — no push, no model fetch                          |
| `--write-context`     | off     | Write `.vibgrate/review-context.md` — committed agent memory                |
| `--inject-context [file]` | off | Update the managed review block inside `CLAUDE.md` (or a named file)      |

`vg review` reads the code map, so run `vg` (or `vg build`) in the repository
first. Without a map it exits `6` — never `0`.

#### Reading the change: groups and the review document

Before anyone judges a change, they have to read it. `vg review groups` puts
the change in reading order, and `vg review doc` turns it into a review
document. Neither needs a model, and neither builds a code map. Grouping and
diagrams come from the **Architecture** module (`vg module install arch`);
without it every changed file is listed in one "not grouped" group, and the
output says how to get the rest.

```bash
vg review groups                         # working tree vs HEAD
vg review groups --base origin/main      # a branch, against its merge-base
vg review groups --format json           # vg.review.groups.v1
vg review doc --base origin/main         # Markdown, ready for a pull request
vg review doc --base origin/main --base-graph   # also map the base commit: before/after call paths
vg review doc --format json -o review.json
vg review doc --check review.json        # validate an edited document
vg review doc --session latest           # what the last VG Code chat did
```

**Groups.** Every changed file lands in exactly one group. Files that are not
implementation are peeled off first, each for a reason you can see in the
output:

| Group | What lands there |
|---|---|
| Moved or renamed, no edits | renames with no changed lines |
| Generated files | code a tool wrote, from `.gitattributes`, the path, or the file's header |
| Dependencies and lockfiles | lockfiles and dependency manifests |
| Fixtures and snapshots | test fixtures and recorded snapshots |
| Tests | test files |
| Data and content | structured data that is not config, a manifest, an API contract or infrastructure code |
| Docs, Assets | prose, licences, images, fonts, media |
| Config and build | CI pipelines, container files, build and tooling config |
| Formatting only | the diff is empty once whitespace and blank lines are ignored |
| Imports only | every changed line is an import |

What is left is implementation, grouped by monorepo area (`packages/api`) and
architecture layer, in reading order, with large groups split so each fits in
one sitting. Each file carries the reason it landed where it did. The output
is deterministic: the same change always produces the same groups and the
same `digest`.

An agent or a person may merge or split groups and save the result. `vg review
groups --check <file>` exits `2` unless every changed file is in exactly one
group and nothing outside the change is listed. Anything left out is
uncategorized, and uncategorized fails.

**The review document** (`vg.review.doc.v1`) has up to four sections, always in
this order: *what and why*, *requirements*, *design*, *implementation*. `vg
review doc` writes what it can prove: a summary of the change, every
implementation group with a link to each changed hunk, and, when a code map
already exists, the deterministic findings with their evidence and diagrams
derived from the map. It leaves the why and the requirements to the author,
and says so in the document. `vg review doc` reads an existing code map but
never builds one; run `vg` first.

**Diagrams come from the code map, not from a model.** They are derived by the
**Architecture** module (`vg module install arch`); without it the document
has no diagrams and says how to get them. Whatever the module returns, `vg`
checks every pin against the reviewed base and head before showing it. With a
code map and the module, the design section gets:

- **A call path** into the changed function where most of the change happened:
  from an entry point (a function nothing calls, or a file's top level) down
  through each caller. Each frame is pinned to the function's lines and to
  the line it is called from, and says how it is reached: a plain call, an
  awaited (*async*) call, a function passed as a value (*callback*), or a call
  made where the caller publishes to a queue or calls out over HTTP. A path
  longer than 8 frames keeps its entry point, the changed functions and the
  last callers, and says how many calls it folded. Frames are marked *new*,
  *edited* or *gone*.
- **The before side** of that path, when you pass `--base-graph`. vg checks out
  the base commit in a temporary worktree, maps it, and removes the worktree.
  Unchanged files reuse their cached parses, but this still takes seconds to
  tens of seconds on a large package, so it is opt-in. Without it the before
  side reads *not computed*, never an empty path.
- **Up to three flows**: the statements the map extracted from a changed
  function, in order, with each condition as a decision and a `catch` on a
  dashed error edge. Steps on changed lines are highlighted.
- **The data the change reads and writes**, when the repository declares its
  data model in Prisma (`*.prisma`), SQL DDL (`CREATE TABLE`) or EF Core
  (`DbSet<T>` on a context, and the entity classes). The tables the changed
  functions read and write, and the tables they reference, with every column,
  key and foreign key linked to the line that declares it; each read and write
  at the line that runs it, followed into the repository or handler the change
  calls; and the entry points that reach them as use cases, including those
  that dispatch through a mediator rather than a direct call. A save that
  names no table (`SaveChangesAsync`) writes what the function loaded or added,
  not every row it looked at. A read or write that names no declared table is
  left out and counted in the notes. Connection strings are never read.
- **Where the change sits**, when the code map has its architecture (`vg`
  builds it with the Architecture module): a map that zooms from the system
  to the code. The containers are the packages the change touches and their
  most-connected neighbors, with the package-to-package call counts
  `vg show arch` shows; inside them, the changed functions, the functions
  that run their reads and writes, and the entry points that reach them,
  grouped into components by their architecture role (controllers, use
  cases, repositories, …); and the data stores they read and write. Calls,
  dispatches through a mediator, and reads and writes are drawn as edges;
  what the change touched is marked edited or new. Test packages are never
  containers.
- **Signature changes**, with `--base-graph`: a changed function whose
  signature differs from the base commit is called out under implementation,
  with the before and after and how many callers reach it.

Every node, frame and edge is marked `origin: graph`. A diagram whose pins do
not land (usually a code map older than the change) is left out, and the notes
say why. Pass `--no-diagrams` or `--no-findings` to leave either out.

Every claim about code is pinned: `[label](head:src/orders.ts#L10-L24)`, or
`base:` for the code before the change. `vg review doc --check <file>` exits
`2` when the document breaks a rule:

- a pin names a file that does not exist on that side, or runs past its last line
- sections are out of order, or repeated
- the design section does not have exactly one primary diagram
- a flow diagram has an edge to a missing node, a branch that does not leave a
  decision, or a process node with no pinned code
- a sequence step names an unknown actor, or has neither code nor a note
- a call-stack frame names a parent that does not come before it, or the
  before side is marked *not computed* or *absent* but still lists frames
- a data-store operation or foreign key points at a store, collection or field
  that is not defined
- a system-map element's parent is missing, or a relationship has a missing end
- the document was written for a different base or head

The Markdown output renders flow, sequence and system-map blocks as Mermaid
diagrams, so they draw directly in a GitHub comment.

**What a VG Code chat did.** `vg review doc --session <id>` (or `--session
latest`) writes the document for one VG Code chat, from what that chat
already saved under `.vibgrate/code-sessions/`. Nothing new is recorded.

- Only the files the chat touched are included. The notes count the changed
  files it left out, and name the files it touched that are no longer in the
  change (committed past the base, or reverted; pass `--base` to include
  commits).
- *What and why* says which chat made the change and quotes its first request.
  The agent's last summary is quoted too, marked as the agent's own account
  that vg has not checked against the code.
- *Requirements* lists each request, turn by turn, with links to the changed
  lines in the files that turn touched. A turn that stopped before finishing
  (out of steps, cancelled, an error) is called out.
- A chat that ran in its own worktree is read from that worktree, against the
  commit it branched from, so you can read the document before applying the
  worktree. Once the worktree is applied and removed, review the main tree.
- The document is marked `generator.by: "mixed"`: the requests are a person's
  words, the summary is the model's, and everything else vg derived.

`vg review groups --session <id>` groups the same files.

**Read the shape before the lines.** With a code map and the Architecture
module, each implementation file in the document lists the functions the
change touched, as a structural fold:

```
- `src/orders.ts` modified +28 −0 · L4–31
  - `async function placeOrder(db: any, req…)` L5–31 new, 27 lines — query User via findUnique · query Product via findMany · log via console.log
  - `function total(items)` L1–3 edited
```

- Every changed function shows its signature, whether it is new or edited,
  and a link to its lines. A function inside another changed one is read with
  it.
- A long new function (25 lines or more) is folded to what it does, step by
  step, from the statements the code map extracted. No model writes the
  summary.
- Tests and docs stay in their own groups, folded to a count, as before.
- A file whose lines no longer match the code map is left unfolded, and the
  notes say to rebuild the map.

**An agent writes the document.** `vg review doc` writes the deterministic
first pass. An agent (or a person) can then write the parts only it knows (the
why, the requirements, a diagram of the design) into a saved copy, block by
block, without ever being able to pass its words off as vg's.

```bash
vg serve --review                          # adds the review_doc MCP tool (or VG_REVIEW=1)
vg review doc --save                       # save the document for this change; prints its id
vg review doc --saved                      # show the saved one while it still matches the change
vg review doc --doc rd_5da78d7992d5 --patch ops.json --expect-version 2
vg review doc --doc rd_5da78d7992d5 --history
vg review doc --doc rd_5da78d7992d5 --restore 1
```

- **One document per scope.** The change (or the change against a base ref),
  or one VG Code chat, always opens the same saved document, `rd_…`. When the
  commits move, opening it builds a new version from the change; the edited
  versions stay in the history.
- **Patches by block id.** `set_text`, `insert`, `replace`, `remove`, `move`,
  `set_primary` and `set_title`, up to 50 in one patch. A replaced block keeps
  its id.
- **All or nothing.** After the operations apply, the whole document must pass
  the same checks as `--check`: schema, section order, one primary diagram,
  every pin landing on the change. Otherwise nothing is saved and the issues
  come back.
- **Versions, not overwrites.** A patch names the version it was written
  against, and a patch against an older one is refused, so two agents cannot
  overwrite each other. A restore adds a new version; nothing is ever lost.
- **Provenance that cannot be forged.** Text an agent writes is marked
  `origin: "agent"` and shows as *written by an agent*. A diagram element stays
  `origin: "graph"` only while it is unchanged from what vg derived; an agent
  that claims `graph` for something it drew or edited is recorded as `agent`,
  and told so.
- **Kept for 365 days** after its last update (the Repository retention
  category), then deleted. `.vibgrate/review-docs/` is in vg's own
  `.gitignore`, so a saved document is never committed with the change it
  describes.

Over MCP, `review_doc` takes an `op`: `open` (the change, a `base`, or a VG
Code `session`), `get` (the outline and the document, or one `block`),
`patch`, `check`, `history`, `restore`. It is listed only under `vg serve
--review`: a default `vg serve` advertises the same tools as before.

**A change across repositories.** When one change spans checkouts (an API
and the client that calls it), fold the others in with `--also`:

```bash
vg review doc --base origin/main --also ../web-client
vg review doc --base origin/main --also ../web-client=origin/develop --push
vg review doc --base origin/main --check doc.json --also ../web-client
```

- Each checkout's part is built there, from its own diff and code map, the
  same way `vg review doc` builds it, and joins the same four sections under a
  heading naming the repository. The first repository keeps the primary
  diagram.
- Every pin from another repository names it (`"repo": "web-client"`, or
  `head@web-client:src/api.ts#L4` in text), and the document lists them under
  `repos` with their commits. Each pin is checked against its own repository.
- `--check` checks pins in other repositories only against checkouts given
  with `--also`, matched by repository; one it was not given is named, not
  failed pin by pin.
- `--also` builds a document for a change; it does not combine with `--save`,
  `--saved` or `--session`. With `--push`, the GitHub App shows it on the
  first repository's pull request, and its pins link to each repository on
  GitHub.

**Show the document on the pull request.** `vg review doc --push` uploads the
whole document to Vibgrate Cloud. The GitHub App then shows it in its Review
summary comment, folded under the summary, with every pin linked to its lines
at the pull request's commits.

```bash
vg review doc --base origin/main --push    # in CI, after checkout, with VIBGRATE_DSN set
vg review doc --base origin/main --save --push
```

- **Opt-in on both sides.** The CLI sends a document only on `--push`; a
  receipt push (`vg review --push`) never includes one. The workspace must also
  have turned on **Review documents** (Vibgrate Cloud → Settings → Source
  control). It is off by default, only a workspace admin can change it, and
  the change is audited. While it is off, the upload is refused and nothing is
  stored.
- **What is uploaded.** The whole document, which carries code-derived text:
  function signatures, branch conditions, table and field names, the paths and
  line numbers it pins, and anything an agent or a person wrote into it (for a
  `--session` document, the requests made in that chat). Source files are not
  uploaded.
- **Committed changes only.** The App shows the document for the commit it
  describes, so a document of uncommitted work is refused before anything is
  sent. Commit first, then run it with `--base`.
- **Sealed.** Cloud recomputes the document digest and refuses a document
  edited after `vg` built it.
- **Kept for 365 days** (the Repository retention category), then deleted.
  Turning **Review documents** off deletes every stored document for the
  workspace at once.
- **Long documents.** The comment shows as much as fits GitHub's comment limit,
  section by section, and says how many blocks were left out.
- **In Vibgrate Cloud.** The Review run page the comment links to draws the
  whole document: diagrams, call paths, data tables and findings, with every
  pin linked to its lines on GitHub. It re-reads the document every 30 seconds,
  so a new push for the same commit (an agent's edits saved with `--save
  --push`, say) shows without a reload.
- **Comments an agent can answer.** On that page anyone who can see the run
  can comment on a block, reply, and resolve a thread. The agent reads and
  answers them where it works:

  ```bash
  vg review doc --base origin/main --comments                       # open threads first
  vg review doc --base origin/main --reply rdc_3f2a… --text "Because the base side was not built."
  ```

  Over MCP, `review_doc` op `comments` and op `reply` do the same for a saved
  document (`vg serve --review`). A reply sent this way is always shown as an
  agent's, and an agent can only answer a thread: it cannot start or resolve
  one. Comments are plain text, at most 4000 characters, and are deleted with
  their document (365 days, or when review documents are turned off). A thread
  on a block a later push removed stays visible, marked as outdated.

  The GitHub summary links each block to its comments: **Comment** opens the
  block on the run page with the comment box open, and "2 open comments"
  opens the first open thread. In Vibgrate for VS Code the threads show under
  their blocks in the review document tab, and new comments from people add a
  row to VG Code with **Answer them**, which puts the threads and the reply
  command into the composer, unsent. Settings → Source control's "What landed
  this week?" links each merged pull request to its review, and to its review
  document when one was pushed.

#### Decisions

Policy owns the decision, and it is the only layer that writes one. Findings —
from the scanners or from the optional local model — have nowhere to put a
verdict.

| Decision       | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `pass`         | No material delta, or every finding is target-aligned                          |
| `fail`         | An unresolved **protected** finding, or a high-severity finding above the confidence threshold |
| `needs_review` | Findings a human should look at                                                |
| `undetermined` | Not enough evidence to decide — deliberately not a pass                        |

**Gating is opt-in, exactly as it is for [`vg scan`](#vg-scan).** By default
`vg review` reports the decision, writes it to the receipt, and exits `0` — even
on `fail`. It breaks the build only when you ask it to:

| Gate | Set by | Exits `2` on |
| --- | --- | --- |
| `none` | the default | never |
| `fail` | `--fail-on fail`, or `enforcement = "enforced"` with `fail_on = "fail"` | `fail` |
| `needs_review` | `--fail-on needs_review`, or the same in config | `fail`, `needs_review`, `undetermined` |

A gate failure exits `2` (`GATE_FAILED`) — the same code `vg scan`, `vg drift`
and `vg hcs gate` use. It is deliberately **not** `1`: across this CLI `1` means
the command itself errored, and a policy verdict of `fail` is the command
working correctly. Machines should branch on `decision` in the receipt, which is
unambiguous; the exit code exists for CI.

`enforcement = "advisory"` means no gate at all. That is what makes the setting
real rather than a label on the receipt — an advisory repository reports
honestly and never blocks a merge.

**Protected findings** — an unguarded entrypoint, a removed guard, a validated
taint flow, a known-vulnerable dependency — carry `protected_finding: true`.
While one is unresolved, policy cannot emit `pass`: not via an approved
exception, not via low confidence, not via the quick path, and not via anything
the model says. Turn a rule off in the review policy (`review.protected`) if it
does not apply to your repository; that is the only way to stop it gating.

#### What it looks for

| Finding | What it means |
|---|---|
| `unguarded_entrypoint` | **Protected.** A mutating route has no authorization guard, where its peers do |
| `guard_removed` | **Protected.** A guard was deleted and nothing equivalent remains |
| `known_vulnerable_dependency` | **Protected.** A changed manifest declares a package with a known advisory |
| `correctness` (producer `blast_radius`) | Blast-radius fact: a changed symbol has cross-file callers or dependents — the same reverse-reachability `vg impact` reports. Severity stays at or below medium. Stable `id` (`blast:{node_id}` / `blast:{path}:{name}`) is the finding_key. |
| `correctness` (producer `architecture`) | Architecture-policy on a changed file (layer skip / boundary, peer deviation, duplicate implementation, uncovered change). Stable `id` is `arch:{rule}:{path}` using the architecture pack's rule string when one exists. Severity is `low`, `medium`, or `high` — never `critical` from version lag. |

Two of these deserve a note, because they are what a linter cannot do:

**Peers are graph areas and roles, not folders.** A directory is a filing
decision; an area is a structural one. Recent files count roughly twice what
year-old ones do, so a large abandoned wing does not get to dictate "the
convention". Where peers are too evenly split to have one, Review says *no
convention* instead of naming a plurality winner.

**A majority is never treated as correct.** Peers establish what is *normal*;
only the declared `targetPattern` establishes what is *right*. A file that goes through the
service layer while all its peers bypass it is the first one to improve — Review
will not flag it. That is the difference between this and a consistency scanner,
which by construction scores your best file worst.

**Routes get three answers, not two.** Every route is `auth`, `not-auth`, or
`unsure`, and `unsure` is never promoted. A guard Review does not recognise, or
a file it could not parse, becomes an honest unknown — never "this route is
open". Below four classified peer routes a finding is advisory and cannot gate.

#### Findings from a change — `vg review findings-from-diff`

The same deterministic scanners `vg review` runs, printed as the
`vg.review.findings.v1` document — graph blast-radius facts for changed
symbols, plus architecture and security-control findings on the change set.
No hosted model. Use this when you want the findings (and their ids) without
the signed receipt ceremony.

```bash
vg review findings-from-diff
vg review findings-from-diff --base origin/main
vg review findings-from-diff --diff pr.patch --format json
```

`--diff` reads a unified diff (`-` is stdin). The patch names the files and
hunks. Scanners still read file text from the working tree, and they still
need the code map. This command builds a missing map the same way `vg review`
does (`vg build` is the explicit map command). `--format json`, and the global
`--json` flag, write one document: the findings object plus a `publishable`
array. Text output is a different shape and is not this contract.

| Field | Blast-radius | Architecture-policy |
| --- | --- | --- |
| `kind` | `correctness` (top-level only) | `correctness` (top-level only) |
| `id` / `finding_key` | `blast:{node_id}` or `blast:{path}:{name}` | `arch:{rule}:{path}` |
| `source` | `scanner` | `scanner` |
| producer / `scanner_kind` | `blast_radius` | `architecture` |
| severity | `low` or `medium` | `low`, `medium`, or `high` — never `critical` from version lag |
| `receipts` | existing capsule `verify:` / `scan:` / `attest:` ids when those facts already exist | same |

Ids for those two rows are stable across head SHAs: the same symbol, or the
same rule and path, keeps the same key. No spaces. Suggested-fix on publishable
rows is an honest skip (`null` / `skipped_no_patch`) — there is no computed
PatchIR for blast-radius or architecture-policy rows. Each run also writes
`.vibgrate/review-propose-handoff.json` (`vg.review.propose-handoff.v1`) so
`vg review propose` can resolve those ids without a second findings loop.
That file is not the stdout document. This path does not post a comment or a
check run.

The field list, every `kind`, the sort, a captured example, and the failure
exits are in [Findings JSON contract](#findings-json-contract).

#### Findings JSON contract

`vg review findings-from-diff --format json` prints a single JSON object to
stdout and a trailing newline. Errors go to stderr. The object is
`JSON.stringify` of the findings value with `publishable` added, indented by
two spaces. Keys stay in the order below.

##### Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | string | Schema identifier. Always `vg.review.findings.v1`. |
| `change_class` | string[] | `architecture`, then `security`, when those classes apply. Otherwise `["none"]`. |
| `architecture_findings` | object[] | Architecture-policy rows and blast-radius rows. May be empty. |
| `security_findings` | object[] | Security-control rows. May be empty. |
| `unknowns` | string[] | Facts the scanners could not establish. May be empty. Not sorted. |
| `required_checks` | string[] | Check names, unique, then sorted by UTF-16 code unit. |
| `publishable` | object[] | Blast-radius and architecture-policy rows only, sorted by `finding_key`. Always present. |

`change_class` pushes `architecture` when an architecture finding remains, a
cross-file edge was added, or a changed path is architectural. It then pushes
`security` when a security finding remains, a security fact is on the capsule,
or a dependency manifest changed. With neither, the array is `["none"]`.

There is no `decision`, receipt id, timestamp, digest, signature, or git SHA
on this object. Those live on `vg review --format json`
(`vg.review.receipt.v1`), not here.

##### Finding object

Architecture and blast-radius rows are written with these keys, in this order:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable key. Same value as `finding_key` on these rows. |
| `kind` | string | See [kind values](#finding-kind-values). |
| `finding_key` | string | Same as `id` for blast-radius and architecture-policy rows. |
| `producer` | string | `blast_radius` or `architecture`. Not a second `kind`. |
| `severity` | string | `low`, `medium`, or `high`. |
| `confidence` | number | `0..1`. Blast-radius confidence is rounded to three decimal places. |
| `claim` | string | One sentence (sometimes two) stating the fact. |
| `evidence_ids` | string[] | Ids that exist on the capsule. Order is emission order, then any `verify:` / `scan:` / `attest:` ids that were not already listed. |
| `target_alignment` | string | `regression`, `legacy_consistent`, `approved_exception`, or `unknown` from these scanners. |
| `remediation` | string | What to do next. |
| `paths` | string[] | Repo-relative paths. Blast-radius lists the changed file, then affected files, de-duplicated, at most eight. |
| `protected_finding` | boolean | `false` on blast-radius and architecture-policy rows. |
| `source` | string | `scanner`. This command does not call a model. |
| `receipts` | string[] | Existing `verify:` / `scan:` / `attest:` ids for the finding's paths, sorted with `localeCompare`. `[]` when none exist. |

Security rows use the same keys except they omit `finding_key`, `producer`,
and `receipts`. Their `id` is `sec-01`, `sec-02`, … in emission order. That
counter is not a content hash: it stays put for a fixed input and renumbers
when an earlier security row appears or disappears.

`target_alignment` on the type also includes `target`. These scanners do not
write `target`. Severity on the type also includes `critical`. These scanners
do not write `critical`.

##### Finding `kind` values

`kind` is the top-level classification. Blast-radius is not its own `kind`.

| `kind` | Where | How you tell the rows apart |
| --- | --- | --- |
| `correctness` | `architecture_findings` | `producer` is `blast_radius` or `architecture`. |
| `guard_removed` | `security_findings` | A guard was deleted and none remains. `protected_finding` is `true` when the rule is on. |
| `unguarded_entrypoint` | `security_findings` | A changed mutating route has no guard while peers do. `protected_finding` is `true` only when the peer group is large enough. |
| `known_vulnerable_dependency` | `security_findings` | A changed manifest declares a package named in `.vibgrate/scan_result.json`. `protected_finding` is `true`. |

**Blast-radius** (`producer: "blast_radius"`, `scanner_kind: "blast_radius"` on
`publishable`): a changed symbol has at least one dependent in another file,
the same reverse reachability as `vg impact` (depth 4). `id` is
`blast:{node_id}` when the graph node is known, otherwise
`blast:{path}:{name}` with whitespace stripped. Severity is `medium` when
three or more direct cross-file dependents exist, otherwise `low`. At most
eight blast-radius rows are emitted, highest fan-out first. Same-file-only
fan-out is omitted.

**Architecture-policy** (`producer: "architecture"`, `scanner_kind:
"architecture"` on `publishable`): `kind` is still `correctness`. The rule
lives in the id, `arch:{rule}:{path}`, with an optional extra segment
(`arch:{rule}:{path}:{extra}`) and whitespace stripped. Rules this command
emits:

| Rule in the id | When |
| --- | --- |
| `peer_deviation` | A changed file steps away from a peer majority. |
| `duplicate_implementation` | A changed function matches an existing one. Extra segment is the function name. |
| `unverified_change` | No test edge reaches the changed file. |
| `{profile}:skip:{from}→{to}` | Declared `layered`, `mvc`, or `mvvm` target, and the new edge skips a tier. Extra segment is the destination path. |
| `{profile}:outer-ring:{from}→{to}` | Declared `clean`, `hexagonal`, or `onion` target, and an outer layer touches persistence directly. |
| `{profile}:domain→{to}` | Domain depends on data-access or infrastructure. |
| `{profile}:upward:{from}→{to}` | A dependency points up the layered stack. |
| `vertical-slice:cross-slice-internal` | A vertical-slice edge reaches into another slice. |
| `layer-skip` or `boundary_bypass` | Fallback ids used only when the scanner's rule string is empty. |

Layer and skip rows are emitted only when a profile exists (a declared target,
or an observed majority). A skip is emitted only against a declared target.
Severity on these rows is `low`, `medium`, or `high`, never `critical`.

**Gap:** `validated_taint` is a protected kind the review policy understands,
and older notes list it next to the other security kinds. This command does
not emit a finding with `kind: "validated_taint"`. When the rule is on and the
change touches an entrypoint or a cross-layer path, the scanner appends one
`unknowns` string instead and does not confirm or exclude tainted input.

##### `publishable` rows

Only blast-radius and architecture-policy rows are copied here. A row is
dropped when its key is empty, contains whitespace, or lacks the `blast:` /
`arch:` prefix. Other `kind` values stay on `architecture_findings` or
`security_findings` and are absent from `publishable`.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Same as `finding_key`. |
| `finding_key` | string | The stable id. |
| `kind` | string | Always `correctness`. |
| `scanner_kind` | string | `blast_radius` or `architecture`. |
| `review_check` | string | Always `vibgrate/review`. |
| `severity` | string | Blast-radius is clamped to `low` or `medium` (`medium` stays; anything else becomes `low`). Architecture stays `low`, `medium`, or `high`. Never `critical`. |
| `confidence` | number | Copied from the finding. |
| `claim` | string | Copied. |
| `paths` | string[] | Copied, same order. |
| `source` | string | `scanner`. |
| `receipts` | string[] | Copied, then sorted with `localeCompare`. |
| `evidence_ids` | string[] | Copied, same order. |
| `suggested_fix` | null | Always `null`. |
| `suggested_fix_status` | string | Always `skipped_no_patch`. |
| `suggested_fix_note` | string | The blast-radius note or the architecture-policy note below. |

Blast-radius note, exactly:

```text
No automatic patch — blast-radius facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump.
```

Architecture-policy note, exactly:

```text
No automatic patch — architecture-policy facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump.
```

##### Ordering

The same map, the same change, the same review policy, and the same
`.vibgrate/scan_result.json` (or its absence) produce byte-identical stdout.
Two runs of the fixture below matched. The sorts that fix that order:

1. **`publishable`** is sorted by `finding_key` with `String.prototype.localeCompare`
   (`exportCorrectnessPublishRows` in `src/review/finding-publish.ts`). This
   sort is not the order of `architecture_findings`. In the fixture below the
   two orders happen to agree (`arch:` before `blast:`).
2. **Blast-radius rows inside `architecture_findings`** follow `compareRanked`
   in `collectBlastRadiusFindings` (`src/review/impact-findings.ts`): more
   depth-1 cross-file dependents first, then more cross-file dependents, then
   `path`, `name`, and `node_id` with `localeCompare`. Symbols are sorted by
   that same path / name / node id before impact is computed. The list is then
   cut at eight. Named callers inside one claim follow `impactOf`: depth
   ascending, confidence descending, then `name` with `localeCompare`.
3. **Architecture-policy rows** are appended in scanner pass order, before the
   blast-radius rows, and are not re-sorted as one list:
   - layer and skip rows, in code-map edge order (edges are sorted by kind, then source, then destination);
   - `peer_deviation`, peer groups ordered by group id with code-unit `<`, deviator paths with the default array sort;
   - `duplicate_implementation`, one row per changed function, in graph node id order (`localeCompare` on the node id);
   - `unverified_change`, by path with `localeCompare`.
4. **`security_findings`**: `guard_removed` (removed-line entries, default array sort), then `unguarded_entrypoint` (route directories ordered with code-unit `<`), then `known_vulnerable_dependency` in the order those findings appear in `.vibgrate/scan_result.json`.
5. **`required_checks`**: insertion order, duplicates removed, then the default array sort (UTF-16 code units, not `localeCompare`).
6. **`receipts`**: `localeCompare`.
7. **`unknowns`**: first-seen order (capsule unknowns, then scanner unknowns). Not sorted.
8. **`change_class`**: `architecture` then `security`, or `["none"]`. Not alphabetical.

Paths inside a unified `--diff` are collected with code-unit `<` before any
finding is built.

##### What varies

Stdout does not include a clock, a receipt id, a signature, a digest, or a git
SHA, so those cannot change this document.

These change when the inputs change, and they are not stable identifiers:

- `claim`, `confidence`, `severity`, and `paths` follow the map and the change. Blast-radius `confidence` is rounded to three decimals. Peer-deviation and duplicate-implementation confidence are not rounded to a fixed scale before they are printed.
- Security `id` (`sec-NN`) is an emission counter.
- An evidence id of the form `source_span:<n>` uses the capsule evidence length at the moment it is inserted, so it moves when earlier evidence is added.

The same `--diff` text on two different trees can differ, because file text is
read from disk. A missing `.vibgrate/scan_result.json` is not "no
vulnerabilities": dependency-manifest changes become an `unknowns` entry and
`required_checks` gains `dependency-advisory-check`.

stderr is not part of the document. Without `--quiet` or `--json`, a map build
or refresh prints a line whose elapsed seconds vary (`code map built — N files
in X.Xs`, or the refreshed form). `--format json` alone does not hide that
line. `--json` does.

`.vibgrate/review-propose-handoff.json` is a side file
(`vg.review.propose-handoff.v1`). Its capsule carries `base_sha`, `head_sha`,
`dirty_tree_hash`, and a path-derived `repo_pseudonym`. A failed write of that
file does not fail the command.

##### Example

Captured stdout, twice, byte-identical, from a two-file git repository. `src/app.ts`
imports `add` from `src/lib.ts`. After the first commit, `add`'s return was
edited to `a + b + 0` and left unstaged. The command was:

```bash
vg review findings-from-diff --format json --quiet
```

The map was built by the command. Both rows have `kind: "correctness"`. The
first is architecture-policy (`unverified_change`: no test edge). The second
is blast-radius (`main` in `src/app.ts` depends on `add`). `publishable` lists
the `arch:` key before the `blast:` key.

```json
{
  "schema_version": "vg.review.findings.v1",
  "change_class": [
    "architecture"
  ],
  "architecture_findings": [
    {
      "id": "arch:unverified_change:src/lib.ts",
      "kind": "correctness",
      "finding_key": "arch:unverified_change:src/lib.ts",
      "producer": "architecture",
      "severity": "medium",
      "confidence": 0.7,
      "claim": "src/lib.ts has no test edge reaching it in the code map.",
      "evidence_ids": [
        "verify:no_test_covering_change:1"
      ],
      "target_alignment": "unknown",
      "remediation": "Add a test that exercises the changed call path, or point `vg build` at the coverage report that already covers it.",
      "paths": [
        "src/lib.ts"
      ],
      "protected_finding": false,
      "source": "scanner",
      "receipts": [
        "verify:no_test_covering_change:1"
      ]
    },
    {
      "id": "blast:1fc1f7fc442e388dcdf2eb08b60759d9",
      "kind": "correctness",
      "finding_key": "blast:1fc1f7fc442e388dcdf2eb08b60759d9",
      "producer": "blast_radius",
      "severity": "low",
      "confidence": 0.75,
      "claim": "Changing add in src/lib.ts reaches 1 direct and 0 transitive dependents across 1 file(s): main in src/app.ts. No test edge reaches this file in the map.",
      "evidence_ids": [
        "impact:1fc1f7fc442e388dcdf2eb08b60759d9",
        "impact:1fc1f7fc442e388dcdf2eb08b60759d9:dep:24636616b8372e46cd4c85a83253282c",
        "verify:no_test_covering_change:1"
      ],
      "target_alignment": "unknown",
      "remediation": "Add a test that exercises the highest-fan-out caller (main) before merging, or keep the exported contract of add compatible with those callers.",
      "paths": [
        "src/lib.ts",
        "src/app.ts"
      ],
      "protected_finding": false,
      "source": "scanner",
      "receipts": [
        "verify:no_test_covering_change:1"
      ]
    }
  ],
  "security_findings": [],
  "unknowns": [],
  "required_checks": [
    "changed-call-path-test"
  ],
  "publishable": [
    {
      "id": "arch:unverified_change:src/lib.ts",
      "finding_key": "arch:unverified_change:src/lib.ts",
      "kind": "correctness",
      "scanner_kind": "architecture",
      "review_check": "vibgrate/review",
      "severity": "medium",
      "confidence": 0.7,
      "claim": "src/lib.ts has no test edge reaching it in the code map.",
      "paths": [
        "src/lib.ts"
      ],
      "source": "scanner",
      "receipts": [
        "verify:no_test_covering_change:1"
      ],
      "evidence_ids": [
        "verify:no_test_covering_change:1"
      ],
      "suggested_fix": null,
      "suggested_fix_status": "skipped_no_patch",
      "suggested_fix_note": "No automatic patch — architecture-policy facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump."
    },
    {
      "id": "blast:1fc1f7fc442e388dcdf2eb08b60759d9",
      "finding_key": "blast:1fc1f7fc442e388dcdf2eb08b60759d9",
      "kind": "correctness",
      "scanner_kind": "blast_radius",
      "review_check": "vibgrate/review",
      "severity": "low",
      "confidence": 0.75,
      "claim": "Changing add in src/lib.ts reaches 1 direct and 0 transitive dependents across 1 file(s): main in src/app.ts. No test edge reaches this file in the map.",
      "paths": [
        "src/lib.ts",
        "src/app.ts"
      ],
      "source": "scanner",
      "receipts": [
        "verify:no_test_covering_change:1"
      ],
      "evidence_ids": [
        "impact:1fc1f7fc442e388dcdf2eb08b60759d9",
        "impact:1fc1f7fc442e388dcdf2eb08b60759d9:dep:24636616b8372e46cd4c85a83253282c",
        "verify:no_test_covering_change:1"
      ],
      "suggested_fix": null,
      "suggested_fix_status": "skipped_no_patch",
      "suggested_fix_note": "No automatic patch — blast-radius facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump."
    }
  ]
}
```

The `blast:` id is the graph node id from that map. It is a content id, not a
secret. A different grammar or a different node-id algorithm would change it;
the rest of the shape would not.

##### Failures

Stdout is empty on every failure below. The `error:` line is stderr. The
text here was captured with `--no-color`.

| Case | Exit | Stderr |
| --- | --- | --- |
| No code map, and this run did not leave one | `6` | see below |
| `--graph <file>` does not exist | `6` | the missing-map line, then ` (looked at <file>)` |
| `--graph <file>` exists but is not valid JSON | `1` | see below |
| `--diff <file>` does not exist | `3` | see below |
| Not a git repository (or git is not on `PATH`) | `5` | see below |
| `--format` is not `text` or `json` | `5` | `error: unknown --format (expected text \| json)` |

No code map:

```text
error: no code map found — run `vg` in this repository first, then `vg review`
```

`--graph` file present but not JSON (exit `1`):

```text
error: The code map is truncated or not valid JSON. Rebuild it with `vg build`.
```

Missing `--diff` file (`<file>` is the path you passed):

```text
error: no diff at <file> — pass a unified-diff file or `-` to read stdin
```

Not a git repository (`<root>` is the directory `vg` resolved):

```text
error: `vg review` needs a git repository — <root> is not one (or git is not on PATH)
```

The missing-diff check runs after map prep and before the missing-map check.
A missing `--diff` path exits `3` even when the map was not built. With neither
`--quiet` nor `--json`, a skipped build also prints `  code map not built: <reason>`
before the `error:` line. One verified reason is `another vg process is building the map`.

**Gap — empty diff.** An empty file, a blank file, or text that is not a
unified diff is not an error. Exit is `0`. The document is:

```json
{
  "schema_version": "vg.review.findings.v1",
  "change_class": ["none"],
  "architecture_findings": [],
  "security_findings": [],
  "unknowns": [],
  "required_checks": [],
  "publishable": []
}
```

A clean working tree with no `--diff` prints the same document. Callers that
need a failure on an empty patch have to test `change_class` and the finding
arrays themselves.

**Gap — `--no-auto-build`.** That flag belongs to `vg review`. On
`findings-from-diff` it is an unknown option and the process exits `1` with
`error: unknown option '--no-auto-build'`. Placing it before the subcommand
(`vg review --no-auto-build findings-from-diff`) does not stop the build: the
subcommand never reads the flag, builds a missing map, and exits `0` when the
review itself succeeds. Exit `6` on this subcommand is the case where prep did
not leave a map (`--graph` pointing at nothing, a build error that is not a
config-file error, or a refresh lock held by another `vg` process). A broken
project config is thrown as its own error and is not this exit `6` message.

#### Propose a PatchIR dry-run — `vg review propose`

```bash
vg review propose blast:<node_id> --model forge --json
vg review propose blast:<node_id> --model forge --json --base origin/main
vg review propose arch:<rule>:<path> --model forge --json --findings findings.json
vg review propose arch:<rule>:<path> --model relay:<slug> --json
```

Attaches a PatchIR dry-run to one finding id via the VG Code agent loop — there
is no second Review runtime. Lookup is the current change set, then
`--findings` JSON (a `vg.review.findings.v1` document or a review receipt),
then the last-run `.vibgrate/review-propose-handoff.json`. Pass the same
`--base` / `--in-place` / `--diff` as findings-from-diff when you want that
change set explicitly.

| Flag | Default | Description |
| --- | --- | --- |
| `--model <id>` | required | `relay:<slug>` (hosted Review) or `spark` \| `flow` \| `forge` (local Code Mode). A bare slug is invalid — propose never calls a backend in that case. |
| `--loop` | on | VG Code agent loop (capped; stops on no progress) |
| `--single` | off | One-shot residual → patch → verify instead of the loop |
| `--apply` | off | Write the patch (still requires `--yes`; refused on the default branch) |
| `--yes` | off | Consent to write when `--apply` is set |
| `--base <ref>` | — | Same change set as `findings-from-diff --base` |
| `--in-place` | off | Same as `findings-from-diff --in-place` |
| `--diff <file>` | — | Same as `findings-from-diff --diff` (`-` is stdin) |
| `--findings <file>` | — | Findings JSON when the current change set does not list the id |

Dry-run unless you pass `--apply --yes` on a **topic branch**. It never writes
the default branch. The same Code Mode and Relay ids are used by `vg code`.
This command does not post a check run or a review comment.

#### Before you write it — `assess_change`

`vg review` asks "was that change sound?". The MCP tool `assess_change` asks
"would this be sound?", while an agent is still deciding — the only point at
which the fix is free.

```jsonc
// one call, from any MCP client wired to `vg serve`
{ "file": "src/routes/invoices.ts", "content": "<the proposed code>" }
```

It returns the conflicts, anything the proposal duplicates, the convention its
peers follow with example files to open, and the declared target. One tool, not
a family of them: a family pushes the judgement into the model, and in this
product the model never decides.

#### Agent memory — `--write-context`

`vg review --write-context` writes `.vibgrate/review-context.md`: the declared
target, the conventions with exemplars, what is currently open, and what to do.
Commit it, and the next agent starts from the answer.

It tells the agent to follow the **declared target**, never "the majority" —
otherwise a repository mid-migration ends up with memory instructing every agent
to perpetuate the legacy it is migrating away from. `--inject-context` keeps the
same content in a marked block inside `CLAUDE.md`, leaving everything a human
wrote in that file untouched.

#### Configuration — the `review` block

The review policy is the `review` block of the project config
(`.vibgrate/config.yml` or `vibgrate.config.json`, which take the same settings):

```yaml
# .vibgrate/config.yml
review:
  enforcement: advisory       # advisory | enforced
  failOn: fail                # none | fail | needs_review
  targetPattern: layered      # the architecture you say you want
  protected:
    unguardedEntrypoint: true
    knownVulnerableDependency: true
    validatedTaint: true
```

Read from the **trusted base branch** when `--base` is given, so a pull request
cannot weaken the policy applied to itself. It is read as data: a `review` block
in a `.ts`/`.js` config is never run, so keep it in YAML or JSON.

A key `vg` does not recognise, or a value of the wrong type, stops the command.
The error names the file and, when the file makes it clear, the line and the
key. The value is not printed. `.vibgrate/review.toml` still skips keys it does
not recognise.

The first `vg review` in a repository with no policy writes an advisory starter
policy: a new `.vibgrate/config.yml` when there is no config, or a `review` block
added to an existing `.vibgrate/config.yml` / `vibgrate.config.json`. A `.ts` or
`.js` config is never rewritten, so those repositories get `.vibgrate/review.toml`.

`.vibgrate/review.toml` keeps working wherever the config has no `review` block.
Its keys are the snake_case forms of the ones above (`fail_on`, `target_pattern`,
`[review.protected]`). `vg doctor` says when a `review` block makes it redundant.

Team markdown packs live under `.vibgrate/review/` — the same tree the GitHub
App reads. With `--base` they are read from the base branch, like the `review`
policy, so a change cannot add an `ignore.md` glob over the files it breaks or
delete a check to clear its own review; its edits apply after it merges.
Without `--base`, the files on disk are used. `ignore.md` drops matching finding paths; `policy.md` is attached to
the human report; `merge.md` is evaluated locally (docs-only may approve; a
change to `merge.md` itself is refused); `checks/*.md` each produce one CLI
pass or a skipped-with-reason line. Custom checks have no extra correctness
engine on the CLI either.

`--loop` applies only deterministic `package.json` version bumps it can compute
(from a known current → latest pair). It does not rewrite lockfiles, does not
open a hosted branch, and never starts unless you pass the flag.

Declaring `targetPattern` is what turns a layering observation into a
*regression*. Without it, a dependency that skips a tier is reported as a medium
finding about the repository's own majority — because a majority is not the same
thing as a decision, and Review will not treat it as one.

#### What it does not claim

Review reports change integrity. It does not prove code is secure, correct, or
free of vulnerabilities; it does not replace Semgrep, CodeQL, a compiler, or your
tests; and **absence of findings is not a certification**.

#### Privacy

Source stays on the machine. `--push` sends the receipt — decisions, claims,
evidence ids, paths, digests, versions — never the analysis capsule and never
source text. Line ranges are opt-in (`--include-spans`); snippets are a second,
explicit opt-in (`--include-snippets`) and are capped. `--offline`, or simply
having no DSN, keeps the receipt on disk.

Ready-to-use workflows: `examples/github-actions/vibgrate-review.yml` and
`vibgrate-review-sarif.yml`.

---


### vg sbom

Export [SBOMs](https://vibgrate.com/glossary/sbom) from an existing scan artifact or compare two artifacts.

```bash
vg sbom export [--in <file>] [--format cyclonedx|spdx] [--out <file>] [--root <dir>] [--no-transitive]
vg sbom delta --from <file> --to <file> [--out <file>]
vg sbom vex [--from <file>] [--statement <json>...] [--product <ref>] [--out <file>]
```

| Command | Description |
|---------|-------------|
| `vg sbom export` | Emit CycloneDX (default) or SPDX JSON from a scan artifact |
| `vg sbom delta` | Compare dependencies between two artifacts (added/removed/changed + drift delta) |
| `vg sbom vex` | Emit a spec-compliant OpenVEX document (exploitability statements) for attestation |

Use this to treat SBOMs as operational intelligence instead of static compliance output.

#### Choosing CycloneDX or SPDX

`vg sbom export` writes one JSON document. `--format` accepts `cyclonedx` or `spdx`, compared without regard to case. The default is `cyclonedx`. Any other value prints `Invalid SBOM format. Use cyclonedx or spdx.` and the process exits 1.

Both formats are built from the same scan artifact and the same lockfiles under `--root`. The component list and its order are the same: Package URL when the component has one, otherwise the package name, then the version. Each specification then places those facts in its own fields.

```bash
vg scan --offline
vg sbom export --format cyclonedx --out sbom.cdx.json
vg sbom export --format spdx --out sbom.spdx.json
```

`vg scan --offline` writes `.vibgrate/scan_result.json` on this machine and does not upload. Both export commands read that file, the default for `--in`, and the lockfiles in the current directory, the default for `--root`. Leave `--format` off and the file is CycloneDX. Leave `--out` off and the JSON is printed on stdout.

| | CycloneDX 1.5 | SPDX 2.3 |
| --- | --- | --- |
| Document | `bomFormat` is `CycloneDX`, `specVersion` is `1.5`, and `version` is `1` | `spdxVersion` is `SPDX-2.3`, `dataLicense` is `CC0-1.0`, `SPDXID` is `SPDXRef-DOCUMENT`, and `name` is `<scan root>-sbom` |
| Document id | `serialNumber` is `urn:uuid:` followed by a content-derived UUID | `documentNamespace` is `https://vibgrate.com/spdx/<scan root>/` followed by a content-derived UUID |
| Tool | `metadata.tools` is an array of one object: `vendor` `Vibgrate`, `name` `@vibgrate/cli`, `version` the artifact's `vibgrateVersion` | `creationInfo.creators` is an array containing `Tool: @vibgrate/cli-<vibgrateVersion>`. Each package annotation's `annotator` is `Tool: @vibgrate/cli` |
| Created | `metadata.timestamp` is the artifact's `timestamp` | `creationInfo.created` is that same timestamp |
| Scan root | `metadata.component` has `type` `application`, `bom-ref` `vibgrate-root`, and `name` set to the scan root. That component is not copied into `components` | There is no package for the scan root |
| Package identity | `components[].purl`. When a purl is written, `bom-ref` is that purl | `packages[].externalRefs[]` with `referenceCategory` `PACKAGE-MANAGER`, `referenceType` `purl`, and `referenceLocator` set to the purl. `SPDXID` is `SPDXRef-Package-N` |
| Dependency graph | `dependencies` is an array of `{ ref, dependsOn }`. `ref` is a `bom-ref`. The first entry is `vibgrate-root`. Every component is an entry after that, in the component order above. `dependsOn` lists child `bom-ref` values, or is `[]` when none were recorded for that component | `relationships` is an array of `{ spdxElementId, relatedSpdxElementId, relationshipType }`. `relationshipType` is `DEPENDS_ON`. Edges from the document use `SPDXRef-DOCUMENT`. A row is written only for a recorded edge. `SPDXID` values follow the component order above |
| Licenses | `licenses` is present when the declared license can be written, and absent when it cannot | `licenseDeclared` is set on every package. `licenseConcluded` is `NOASSERTION` on every package. `hasExtractedLicensingInfos` is present when a `LicenseRef-…` is used. Every package has `downloadLocation` `NOASSERTION` and `filesAnalyzed` `false` |

`dataLicense` `CC0-1.0` is the SPDX license for the document data. Package licenses stay on `licenseDeclared`.

The UUID inside `serialNumber` and the UUID inside `documentNamespace` are different values. The hash seed starts with the format name, so the two ids differ for the same artifact. The same artifact and the same lockfiles produce the same id for that format on every run. A later scan records a new timestamp, so both ids change. The rest of the seed is under [Several versions of one package](#several-versions-of-one-package).

When the lockfile records no edges, both documents leave the graph member out. CycloneDX omits `dependencies`. SPDX omits `relationships`. npm `package-lock.json` v2/v3 records edges. pnpm and yarn list the components and leave the graph member out.

Purl rules, the fallback `bom-ref`, and how a scan artifact joins to these fields are in [Component identity](#component-identity).

`type` and `primaryPackagePurpose` are in [CycloneDX type and SPDX primaryPackagePurpose](#cyclonedx-type-and-spdx-primarypackagepurpose).

Direct and transitive scope, and the production, development, and optional signals the export records or drops, are in [Dependency scope](./docs/sbom-dependency-scope.md).

How a declared license is copied into each format is in [Declared licenses](#declared-licenses).

`vg sbom export` reports the full resolved dependency tree, not just what's declared
in the manifest: it reads `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` (npm,
pnpm, and yarn) from `--root` (defaults to the current directory) and folds every
transitive package in alongside the directly-scanned ones. Each component carries a
`vibgrate:scope` property (`direct` or `transitive`) so consumers can still tell the
two apart. Pass `--no-transitive` to report only the manifest-declared dependencies,
matching pre-existing output.

Every component also carries a [purl](https://github.com/package-url/purl-spec)
(`pkg:npm/<name>@<version>`, scoped names as their own namespace segment) — as the
CycloneDX `purl` field and `bom-ref`, and as the SPDX `externalRefs` PACKAGE-MANAGER
reference — so a vulnerability scanner can match components without re-deriving an
identifier. When a package name cannot be a Package URL (a space, a non-ASCII
character, an empty path segment, or a slash or colon that is not an npm scope
separator), that component stays in the document and
the purl is omitted. CycloneDX sets `vibgrate:purlStatus` to `unavailable` and
records the reason on `vibgrate:purlWarning`. SPDX omits the purl externalRef,
records `purlStatus=unavailable` on the package annotation, and repeats the
reason in a second annotation. `vg sbom export` prints the same warning on
stderr. The warning names the package and its ecosystem. The purl rules above
are the identity a scanner should store.

#### Component identity

Match a component on its [package URL](https://github.com/package-url/purl-spec) (purl). That string is the primary identity in `vg sbom export`. `vg scan --format json` and `.vibgrate/scan_result.json` use the same coordinates and do not repeat the purl string.

| Output | Fields to key on |
| --- | --- |
| CycloneDX | `components[].purl`. `bom-ref` is that purl when the purl was written. |
| SPDX | `packages[].externalRefs[]` with `referenceType` `purl`. The value is `referenceLocator`. |
| Scan JSON, inventory | `projects[].type`, `projects[].dependencies[].package`, `projects[].dependencies[].resolvedVersion`. |
| Scan JSON, advisory match | `extended.vulnerabilities.packages[].ecosystem`, `.package`, and `.version`. |

`projects[].type` is the project kind (`java`, `node`, `python`). The vulnerability block uses the advisory ecosystem (`maven`, `npm`, `pypi`). `vg sbom export` turns those coordinates into the purl type (`pkg:maven`, `pkg:npm`, `pkg:pypi`).

These documents have no CPE field. The CLI does not write one, including when a name has several segments (a Maven `group:artifact`, an npm scope, a Go module path). A missing CPE is the normal record. Leave it missing. If a file from another cataloger carries a `cpe` property, keep the purl as the identity you match. A CPE does not replace a purl, rank above it, or stand in for a purl that was omitted.

When a name cannot be a package URL, the component stays in the SBOM and `purl` is omitted. CycloneDX sets `vibgrate:purlStatus` to `unavailable`. That row still has no CPE.

Local advisory matching uses the same coordinates. `vg scan --vulns --offline --package-manifest package-versions.json` reads `vulns` under the ecosystem and the package name in that file. Matches land on `extended.vulnerabilities.packages[]`. Join an advisory of your own on the purl, or on ecosystem + package name + version.

```bash
vg scan --vulns --offline --package-manifest package-versions.json --format json --out scan.json
vg sbom export --in scan.json --format cyclonedx --out sbom.cdx.json
```

For `com.google.code.gson:gson` at `2.11.0` in a Java project, read these fields. They are shown together so the join is visible. `vg` writes them in `scan.json` and `sbom.cdx.json`, not in one object. The advisory object is present when `--vulns` records a match for that package.

```json
{
  "scanDependency": {
    "projectType": "java",
    "package": "com.google.code.gson:gson",
    "resolvedVersion": "2.11.0"
  },
  "scanAdvisory": {
    "ecosystem": "maven",
    "package": "com.google.code.gson:gson",
    "version": "2.11.0"
  },
  "cyclonedx": {
    "name": "com.google.code.gson:gson",
    "version": "2.11.0",
    "purl": "pkg:maven/com.google.code.gson/gson@2.11.0",
    "bom-ref": "pkg:maven/com.google.code.gson/gson@2.11.0"
  }
}
```

Key the join on `pkg:maven/com.google.code.gson/gson@2.11.0`, or on `maven` + `com.google.code.gson:gson` + `2.11.0`. The group `com.google.code.gson` is the purl namespace. SPDX stores the same purl on `externalRefs[].referenceLocator`.

#### Package digests

A package digest is a hash of that package's bytes. `vg sbom export` and `vg scan --format json` do not write one. Match the component on its purl. The fields are in [Component identity](#component-identity).

| Output | Field | Shape | What is written |
| --- | --- | --- | --- |
| CycloneDX `components[]` and `metadata.component` | `hashes` | An array of `{ "alg", "content" }` | The key is omitted. |
| SPDX `packages[]` | `checksums` | An array of `{ "algorithm", "checksumValue" }` | The key is omitted. |
| SPDX `packages[]` | `filesAnalyzed` | Boolean | `false`. The package files were not hashed. |
| Scan JSON `projects[].dependencies[]` | — | — | No `integrity`, `checksum`, `hash`, or `digest` key. |
| CycloneDX document | `serialNumber` | `urn:uuid:` and a version-8 UUID | A document identifier. The third UUID group starts with `8`. |
| SPDX document | `documentNamespace` | `https://vibgrate.com/spdx/<rootPath>/<version-8 UUID>` | A document identifier. `<rootPath>` is the scan root. |
| Scan JSON `projects[]` | `projectId` | 16 lowercase hex characters | A project identifier. |
| Scan JSON `solutions[]`, and `projects[].solutionId` when the project belongs to one | `solutionId` | 16 lowercase hex characters | A solution identifier. |

A missing digest stays omitted. The export does not write `[]`, `null`, or `""` where `hashes` or `checksums` would go. It does not hash the package name, the purl, or the document id and store that string as a digest. When you need a hash of the bytes, hash the artifact you fetched.

**Document identifier.** CycloneDX and SPDX each get their own version-8 UUID. The value is derived from the scan artifact, including its timestamp, and from the ordered component list, contributing projects, merge warnings, declared licenses, license-parse notes, and edges. The same inputs produce the same UUID. A later scan records a new timestamp, so the UUID changes. The UUID identifies that export. It is not a SHA-256 digest of the JSON file or of a package. Stability of the whole document is in [Several versions of one package](#several-versions-of-one-package).

**Project and solution identifiers.** `projectId` is the first 16 hexadecimal characters of the SHA-256 of `<path>:<name>`, using that project's `path` and `name`. When the scan has a workspace DSN (`--dsn` or `VIBGRATE_DSN`), the input is `<path>:<name>:<workspace id>`. A local scan without a DSN uses path and name only. The same inputs produce the same id. `solutionId` is the same construction from the solution file's path and name. Each project in that solution copies the id to `projects[].solutionId`. An id already stored for that solution path in `.vibgrate/solutions.json` is the id the scan writes. These strings name the project or the solution.

Two other strings in the same file are easy to misread as package digests. `vcs.sha` is the git commit the scan recorded. `baselineComparison.suppressed[].id` is present only when `--baseline` compared findings: the first 32 hexadecimal characters of the SHA-256 of the finding's rule and location.

**Lockfile digests stay in the lockfile.** The reader that feeds `vg sbom export` keeps `package` and `version`, and dependency edges when that format records them. It drops the digest:

| Lockfile | Digest field that is not copied |
| --- | --- |
| `package-lock.json` | `integrity` |
| `pnpm-lock.yaml` | `resolution.integrity` |
| `Cargo.lock` | `checksum` |
| `uv.lock` | `hash` |
| `go.sum` | `h1:` |

**Several digests, one component.** A lockfile can list more than one digest for one package. The export still writes one component for that ecosystem, name, and version. It does not add a row per digest. `hashes` and `checksums` are omitted, so there is no digest array and no digest order to keep stable. Component order stays the order in [Several versions of one package](#several-versions-of-one-package): Package URL when the component has one, otherwise the package name, then the version. Digest text is not part of that sort, and it is not part of the document id. Exporting the same scan artifact again, after a lockfile edit that changes only those digest strings and leaves names, versions, and edges alone, writes the same JSON, including `serialNumber` and `documentNamespace`.

`go.sum` lists a module twice: `<module> <version> h1:…` and `<module> <version>/go.mod h1:…`. The `/go.mod` line is not a second component. Both `h1:` values are dropped. A `uv.lock` package block can carry more than one `hash`. Those values are dropped, and the block stays one component, in the same order as the other rows. An npm `integrity` string and a pnpm `resolution.integrity` string are not read, including when the string names more than one algorithm.

```bash
vg scan --offline --no-graph --format json --out scan.json
vg sbom export --in scan.json --format cyclonedx --out sbom.cdx.json
```

Both commands read and write local files. In `scan.json`, a dependency object has no digest key. In `sbom.cdx.json`, a component has no `hashes` key. Join the two on the purl from [Component identity](#component-identity).

#### Declared licenses

When a scanned dependency carries a declared license, `vg sbom export` copies
that declaration onto the component. SPDX `licenseConcluded` is `NOASSERTION`
on every package: the field reports the declaration, and the export does not
conclude a license.

| Declared value | CycloneDX 1.5 | SPDX 2.3 `licenseDeclared` |
| --- | --- | --- |
| One SPDX license-list id, such as `MIT` | `licenses: [{ "license": { "id": "MIT" } }]` | `MIT` |
| A `LicenseRef-…` or an SPDX expression (`OR`, `AND`, `WITH`, or a trailing `+`) | `licenses: [{ "expression": "<expression>" }]` | the same expression |
| Missing, empty, or an explicit unknown (`NOASSERTION`, `unknown`, `none`, `n/a`) | `licenses` omitted | `NOASSERTION` |
| Any other value | `licenses` omitted, plus a warning | `NOASSERTION`, plus a warning |

A single SPDX license-list id is the only value written to CycloneDX
`license.id`. A custom reference and a compound expression are one
`expression` string. `MIT OR LicenseRef-Acme-1.0` stays that expression:
CycloneDX treats a list of `license` objects as licenses that all apply, which
is a different claim from `OR`.

A valid custom reference is `LicenseRef-` followed by one or more letters,
digits, `.`, or `-`. `LicenseRef-Acme-1.0` is copied unchanged into both
formats. It is not reported as a license-parse failure. `LicenseRef-Proprietary`
is the same kind of reference.

Each distinct `LicenseRef-…` used in the document appears once in the SPDX
array `hasExtractedLicensingInfos`, sorted by `licenseId`. Each entry has
`licenseId`, `extractedText`, and `name`. The scan does not include the
license text, so `extractedText` is `No license text was recorded for this
custom license reference.` `name` is the reference. A reference that is
already in the license catalog keeps that catalog name (`LicenseRef-Proprietary`
is `Proprietary / Commercial`).

A value that cannot be represented, such as `LicenseRef-has space`, stays
visible. The component remains in the document. CycloneDX sets
`vibgrate:licenseStatus` to `unrepresentable` and records the reason on
`vibgrate:licenseWarning`. SPDX adds `licenseStatus=unrepresentable` to the
package annotation and repeats the reason in a second annotation. `vg sbom
export` prints the same warning on stderr. The warning names the ecosystem,
the package, and the version. No license field is left as an empty string,
and no license is filled in from a guess.

Document-level license-parse failures are unchanged. A scan finding whose
rule is `vibgrate/license-parse-failed` is repeated on the CycloneDX metadata
`properties` and as an SPDX document annotation.

The license on a shared `name@version` is the license from the scan row that
was kept (the first project that declared that version). A lockfile-only
transitive row has no declared license, so its SPDX `licenseDeclared` is
`NOASSERTION` and its CycloneDX `licenses` field is omitted.

#### Several versions of one package

A component's identity is **ecosystem + package name + resolved version**.
That triple is what deduplication uses. The purl, when one can be built, is
the same triple in Package URL form, and it is what you should match on.
`left-pad@1.3.0` from npm and `left-pad@1.3.0` from PyPI are two components.

| Field | What it is |
| --- | --- |
| CycloneDX `purl` and `bom-ref` | The purl (`pkg:npm/left-pad@1.3.0`). `bom-ref` falls back to `vibgrate:<ecosystem>:<name>@<version>` when the purl is omitted (see above). |
| SPDX `externalRefs` | The same purl, `referenceType: purl`. |
| SPDX `SPDXID` | `SPDXRef-Package-N`, N being this row's position in `packages` (1-based). |

`left-pad@1.3.0` and `left-pad@1.2.0` are two components. An npm
`package-lock.json` v2/v3 that records both — `node_modules/left-pad` at 1.3.0
and `node_modules/widget/node_modules/left-pad` at 1.2.0 — exports both, with
distinct purls and distinct `bom-ref` values. The same ecosystem, name, and
version are one component: a second install path of that exact version, or a
second scanned project that resolved that exact version, does not add a row.

The row that is kept for a shared identity follows a fixed precedence. Direct
manifest rows come first. Among those, the first project in the scan artifact
wins, and `vibgrate:project`, `vibgrate:currentSpec`, `vibgrate:drift`,
`vibgrate:majorsBehind`, and the declared license come from that project.
Lockfile rows come next, in sorted project-path order, and the first path
wins. A later copy is not an error. `vibgrate:projects` (SPDX: `projects=` on
the package annotation) lists every project that contributed the identity,
sorted. When a later manifest row carries different drift, spec, or license
metadata, that metadata is dropped, the component stays, and
`vibgrate:mergeWarning` records the drop. The same warning is an additional SPDX
annotation, and `vg sbom export` prints it on stderr.

`vibgrate:scope` (SPDX: `scope=` on the package annotation) is `direct` when a
scanned manifest declared that exact identity, and `transitive` when the
version appears only in a lockfile. The manifest row wins, so a version that is
both declared and locked is `direct`. The lockfile copy of that same version
is omitted as a second row. A second version that the lockfile resolved and no
manifest declared stays in the document as `transitive`. On a transitive row,
`vibgrate:project` is the project whose lockfile supplied the kept row (the
first sorted project path that listed it). `vibgrate:projects` still lists
every project whose lockfile listed that identity.

That value is `direct` or `transitive`. Production, development, and optional
are recorded or dropped before export, and the CycloneDX `scope` member is
omitted. The mapping, a worked example, and the gaps are in
[Dependency scope](./docs/sbom-dependency-scope.md).

```bash
vg sbom export --format cyclonedx --out sbom.cdx.json
vg sbom export --no-transitive --format cyclonedx --out sbom-direct.cdx.json
```

`--no-transitive` keeps manifest-declared rows only. Lockfile-only versions are
absent, and so is the dependency graph. A consumer that filters to
`vibgrate:scope=direct` sees the same gap: other installed versions of that
package are still in the full document, marked `transitive`.

**Order.** CycloneDX `components`, SPDX `packages`, and the package entries in
CycloneDX `dependencies` share one order. A component with a Package URL sorts
by that purl. A component without one sorts by package name. Version is the
next key. When two components share a purl and a version, package name orders
them (`Flask` before `flask`). `dependencies` starts with `vibgrate-root`, then
those components. The order is the same on every run of the same artifact and
the same lockfiles. It is independent of project order in the scan artifact,
directory walk order, and lockfile map order. `dependsOn` entries and the names
inside one lockfile edge are sorted on their own. SPDX `SPDXID` values are
`SPDXRef-Package-N` for that order, so they stay put when only discovery order
changes. The document id stays a content-derived UUID.

**Same inputs, same document.** For one scan artifact and the lockfiles under
`--root`, `vg sbom export` writes the same JSON on every run, including the
CycloneDX `serialNumber` and the SPDX `documentNamespace`. Those values are
document identifiers. Each one is derived from the scan artifact — timestamp
included — and from the ordered component list, contributing projects, merge
warnings, declared licenses, license-parse notes, and edges. A lockfile digest
is not an input, so a change that touches only that digest leaves the document
the same. A later scan of the same tree records a new timestamp, so the
document id changes. Purls and CycloneDX `bom-ref` values do not. Field shapes
are in [Package digests](#package-digests).

**Known limitations:**

- Which project's metadata is kept for a shared identity follows the scan
  artifact. Reordering projects changes `vibgrate:project` on that row and
  changes the document serial number and namespace, because the kept project
  is part of the document id. Component order and SPDX `SPDXID` values stay
  on the Package URL, or on the name and version when there is no purl, so
  those identifiers do not move when only project order changes. CycloneDX
  `bom-ref` stays on the purl, so a scanner that stored the purl still
  matches. `vibgrate:projects` stays the sorted set of contributing projects.
- npm `package-lock.json` v2/v3 collapses two install paths of the same
  `name@version` into one component. When those paths declare different
  dependencies, the edge list is the path that appears last in the lockfile
  `packages` object. The other path's dependencies remain components when they
  are different versions, and they are omitted from that parent's `dependsOn`.
  That collapse is inside one lockfile. It is separate from the multi-project
  merge below.
- In a multi-project scan the component list is the union of every scanned
  project's lockfile, keyed by ecosystem, name, and version. A sub-project
  keeps the ecosystem of its own lockfile, so a Python lockfile stays
  `pkg:pypi` when the other projects are npm. Edges for a component come from
  the lockfile that won for that identity (sorted project path, first wins).
  They are not copied from the root lockfile onto every component. When a
  later lockfile lists a different dependency list for that identity, the
  later list is dropped and `vibgrate:mergeWarning` names the drop. The
  CycloneDX root `dependsOn` and the SPDX document `DEPENDS_ON` relationships
  are the scan-root lockfile's direct dependencies, or the first project path
  that has a lockfile when the root has none. A version that exists only in
  another lockfile is still a component. Its `dependsOn` comes from that
  lockfile when the format records edges. When the document already has edges
  from another lockfile and this format does not record them, `dependsOn` is
  empty and `vibgrate:mergeWarning` says the empty list is not a claim that
  the package has no dependencies. A project type with no mapped package
  ecosystem is recorded as npm, and that assumption is the same warning.
- PyPI purl names are normalized (PEP 503: lowercase, runs of `-_.` folded to
  one `-`). Deduplication uses the name string the scan recorded, before that
  normalization. `Flask@3.0.0` and `flask@3.0.0` are therefore two components
  with one purl and one CycloneDX `bom-ref` (`pkg:pypi/flask@3.0.0`). SPDX
  still assigns each row its own `SPDXID`. An npm name is copied into the purl
  as scanned, so `left-pad@1.3.0` and `left-pad@1.2.0` stay two purls.

#### CycloneDX type and SPDX primaryPackagePurpose

`vg sbom export` writes an inventory of what the scan artifact and the lockfiles
listed. An inventory, not a compliance determination. The labels below are what
this command writes. They are not a certification, a profile check, or a claim
that the inventory is complete.

CycloneDX 1.5 `type` is written in two places. SPDX 2.3 `primaryPackagePurpose`
is omitted on every package.

| Source | Where it is written | CycloneDX `type` | SPDX `primaryPackagePurpose` |
| --- | --- | --- | --- |
| Scan root (the artifact's root directory name) | CycloneDX `metadata.component` only. It is not copied into `components`. SPDX has no package for the root. | `application` | Omitted. There is no package to carry the field. |
| Lockfile package (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`), including a package that only the lockfile lists | One CycloneDX component and one SPDX package | `library` | Omitted |
| Manifest dependency from a scanned project (Node, Python, Rust, Go, Java, Kotlin, Scala, Ruby, PHP, .NET, Swift, Dart, and any other project the scan records) | One CycloneDX component and one SPDX package | `library` | Omitted |
| Container image named by a `Dockerfile` `FROM` or a Compose `image:` line | The same kind of row. A Docker Hub image with no namespace is named `library/<image>`. The tag is the version. | `library` | Omitted |
| Helm chart dependency (`Chart.yaml` `dependencies`) | The same kind of row. The chart itself is not a row. | `library` | Omitted |
| Terraform registry provider or registry module | The same kind of row. The name is `provider:<source>` or `module:<source>`. | `library` | Omitted |
| OS packages, packages installed inside an image, Terraform `resource` blocks, local or git Terraform modules (`./`, `../`, `git::`), Kubernetes manifests | Not emitted | — | — |

`type` is present on `metadata.component` and on every component. The only values
this command writes are `application` and `library`. It does not write
`container`, `operating-system`, `file`, `firmware`, `platform`, or
`machine-learning-model`.

`primaryPackagePurpose` is absent from every SPDX package. The document does not
write `LIBRARY`, `APPLICATION`, `CONTAINER`, `OPERATING_SYSTEM`, or any other
purpose. An omitted field is not a default. A consumer that needs a purpose has
to supply one; this file does not.

The metadata component's `bom-ref` is `vibgrate-root`. Its `name` is the scan
root. It has no version and no purl. A scan that recorded no dependencies still
writes that metadata component and an empty `components` array. SPDX `packages`
is empty in that case, and `primaryPackagePurpose` is still absent because there
is still no package.

**Gaps.** These are holes in the inventory, labeled as holes.

- The metadata label `application` is fixed. A library package, a Dockerfile, a
  Helm chart, and a Terraform directory all get it. The command does not read
  the manifest, the image, or the project type to choose a different label.
- Every dependency row is `library`, including a container image and a Terraform
  provider. The command does not inspect the package to decide a role. `library`
  here is the label it writes.
- OS packages are a gap. `apk add`, Debian packages, and RPM packages are not
  rows. A base image is one row. What that image contains is unknown to this
  command.
- A Kubernetes manifest that names an image is a gap. A fixture whose only file
  was a Deployment using `nginx:1.27` produced an empty component list. The
  metadata component was still `application`.
- A Terraform `resource` block is a gap. A module whose source starts with
  `./`, `../`, or `git::` is a gap. A registry module is a row, typed `library`.
- Docker, Helm, and Terraform are not ecosystems this command has a Package URL
type for, so it records them as npm and says so. On a `Chart.yaml` whose only
dependency was `redis` at `17.14.0`, the row was `type` `library` with purl
`pkg:npm/redis@17.14.0` and a `vibgrate:mergeWarning` that the ecosystem was
unknown. That URL names the npm registry. The chart (`tiny`
at `0.1.0`) was not a row. An image name or a `provider:` / `module:` name
contains a slash or a colon, so the purl is omitted and `vibgrate:purlStatus`
is `unavailable`. The merge warning is still written. Neither outcome is an
OCI, Helm, or Terraform Package URL.

**Examples.** Each excerpt is `vg sbom export` output from a small fixture,
run from that directory with `vg scan --offline --no-graph` and then
`vg sbom export --format cyclonedx` and `vg sbom export --format spdx`.
Annotations, `externalRefs`, properties, serial numbers, and timestamps are
left out of the excerpt. The values that are shown are the ones the command
wrote. `primaryPackagePurpose` was not a key on any package.

Lockfile packages. The fixture directory is `tiny-npm`. `package.json` depends
on `left-pad` at `1.3.0`. Its `package-lock.json` also lists `once` at `1.4.0`
under `left-pad`. That lockfile is the fixture. It is not the registry's tree
for `left-pad`.

```json
"component": { "type": "application", "bom-ref": "vibgrate-root", "name": "tiny-npm" }
```

```json
{ "type": "library", "name": "left-pad", "version": "1.3.0", "purl": "pkg:npm/left-pad@1.3.0" }
{ "type": "library", "name": "once", "version": "1.4.0", "purl": "pkg:npm/once@1.4.0" }
```

The SPDX package for `left-pad` was:

```json
{
  "name": "left-pad",
  "SPDXID": "SPDXRef-Package-1",
  "versionInfo": "1.3.0",
  "downloadLocation": "NOASSERTION",
  "filesAnalyzed": false
}
```

`once` was `SPDXRef-Package-2`. Neither package had `primaryPackagePurpose`.
There was no SPDX package for `tiny-npm`.

Container image. The fixture directory is `tiny-image`. The Dockerfile is:

```dockerfile
FROM alpine:3.20
RUN apk add --no-cache curl
```

```json
"component": { "type": "application", "bom-ref": "vibgrate-root", "name": "tiny-image" }
```

```json
{ "type": "library", "name": "library/alpine", "version": "3.20" }
```

The purl was omitted (`vibgrate:purlStatus` `unavailable`). `curl` was not a
component. The project type is not a mapped package ecosystem, so the row
also carries `vibgrate:mergeWarning` and the export prints that warning: npm
was assumed. The SPDX package was `library/alpine` at `3.20`, with no
`primaryPackagePurpose`.

Terraform. The fixture directory is `tiny-iac`. `main.tf` required provider
`hashicorp/random` at `3.6.2`, declared `resource "random_pet" "example"`,
called registry module `terraform-aws-modules/vpc/aws` at `5.1.2`, and called
a local module with `source = "./modules/local"`. The component list was these
two rows, both `library`:

```json
{ "type": "library", "name": "provider:hashicorp/random", "version": "3.6.2" }
{ "type": "library", "name": "module:terraform-aws-modules/vpc/aws", "version": "5.1.2" }
```

The metadata component was `application`, name `tiny-iac`. Both purls were
omitted. `random_pet` and the local module were not rows. Both SPDX packages
omitted `primaryPackagePurpose`.

When the lockfile format resolves real dependency edges (npm
`package-lock.json` v2/v3 today; pnpm and yarn report components without edges), the
SBOM also carries the resolved dependency graph: CycloneDX's top-level `dependencies`
array, or SPDX `DEPENDS_ON` relationships. Where edges aren't resolvable, that section
is left out entirely rather than shipping a graph that claims "no dependencies" when
the truth is "not tracked". In a multi-project scan each component's edges
come from the lockfile that won for that identity, as described above. The
document root's edges are the scan-root lockfile's direct dependencies.

`vg sbom vex` is input-agnostic: it assembles a complete OpenVEX document from the statements you supply (`--from <file>` and/or repeatable `--statement`), so it works regardless of which scanner flagged the components. A zero-statement document is valid and honest — it asserts no known affected components.

---


### vg scan

The primary command. Scans your project for upgrade drift.

```bash
vg scan [path] [--vulns] [--full] [--iac] [--format text|json|sarif|md] [--out <file>] [--junit <file>] [--fail-on warn|error|architecture-finding|architecture-warning] [--offline] [--package-manifest <file>] [--no-local-artifacts] [--max-privacy] [--baseline <file>] [--drift-budget <score>] [--drift-worsening <percent>] [--changed-only] [--concurrency <n>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--vulns` | — | Also detect known vulnerabilities (OSV online; offline via `--package-manifest` advisories) |
| `--full` | — | Comprehensive scan: turns on known-vulnerability detection (`--vulns`), infrastructure misconfiguration rules (`--iac`), and, when a standards policy exists, a banned-dependency report |
| `--iac` | — | Evaluate infrastructure misconfiguration rules (Terraform, Kubernetes, Helm, Dockerfiles) with the Architecture module's `iac-cis-v1` pack. Needs the code map. How this pass and Terraform drift scoring treat `.tf` and `.tofu`: [Terraform and OpenTofu files](./docs/security-packs.md#terraform-and-opentofu-files) |
| `--format` | `text` | Output format: `text`, `json`, `sarif`, or `md` |
| `--out <file>` | — | Write output to a file |
| `--junit <file>` | — | Also write a deterministic JUnit XML report of findings and gates. See [JUnit](#junit). Does not replace `--format` |
| `--fail-on <level>` | — | Exit with code 2 if findings at this level exist. `warn` / `error` gate on drift findings. `architecture-finding` (hard boundary violations) and `architecture-warning` (violations and warnings) gate on the architecture module's boundary findings, judged under the policy pack in force — `hexagonal-v1` unless `.vibgrate/architecture.toml`, `VIBGRATE_ARCHITECTURE_POLICY` or `vg build --policy` says `layered-v1`. The output names the pack whether the gate passes or fails; each failing row is `file:line  symbol  violation: … (rule)`. Pick the pack before turning this on: see [Architecture policy packs](./docs/architecture-policies.md) |
| `--baseline <file>` | — | Compare against a previous baseline. JSON records matching findings in `baselineComparison` (rule, location, and id, sorted). Text prints the count. SARIF lists the same ids as suppressions. Those findings stay in the report and still count toward `--fail-on`. See [Drift Baselines & Fitness Functions](#drift-baselines--fitness-functions) |
| `--changed-only` | — | Only scan changed files |
| `--concurrency <n>` | `8` | Max concurrent npm registry calls |
| `--drift-budget <score>` | — | Fitness gate: fail if drift score is above this budget |
| `--drift-worsening <percent>` | — | Fitness gate: fail if drift worsens by more than % vs baseline |
| `--summary-out <file>` | — | Also write a small JSON summary for CI steps: `driftScore`, `riskLevel`, `components`, and `delta` / `baselineScore` when `--baseline` is set. An unmeasured score is `null`, never `0`. Written before any gate can fail the run |
| `--push` | — | Upload scan artifact to Vibgrate Cloud after a successful scan |
| `--dsn <dsn>` | `VIBGRATE_DSN` env | DSN used for `--push` authentication |
| `--region <region>` | — | Override data residency (`us`, `eu`) during push |
| `--strict` | — | Fail scan command if push fails |
| `--ui-purpose` | — | Enable optional UI-purpose evidence extraction |
| `--offline` | — | Disable network calls and disable upload/push behavior |
| `--package-manifest <file>` | — | JSON or ZIP package-version manifest used for offline/latest lookups (latest bundle: `https://github.com/vibgrate/manifests/latest-packages.zip`) |
| `--no-local-artifacts` | — | Do not write `.vibgrate/*.json` scan artifacts to disk |
| `--max-privacy` | — | Hardened privacy mode with minimal scanners and no local artifacts |
| `--no-graph` | — | Skip building the local code map that scan produces after scoring drift |
| `--project-scan-timeout <seconds>` | `180` | Per-project scan timeout |
| `--repository-name <name>` | directory / `package.json` name | Override the repository name recorded for this scan |
| `--force` | — | Always create a fresh ingest, even when the repository is unchanged since the last scan |
| `--quiet` | — | Suppress promotional output; scan results are unaffected |

Switches (flags that take no value, such as `--vulns`, `--offline` or `--no-graph`) are off unless you pass them. They do not accept a value or an invented `--no-` form: `--vulns=false`, `--vulns=true` and `--no-vulns` stop with exit code `5` and name the form that works. In a CI template, add or leave out the flag itself rather than passing `true` or `false`.

By default, the scan writes `.vibgrate/scan_result.json`. Use `--no-local-artifacts` or `--max-privacy` to suppress local JSON artifact files.

`vg scan` does not follow symlinks while it indexes the tree. A skipped link is named once on stderr. See [Symlinks](#symlinks).

For offline drift scoring, pass `--package-manifest <file>` with a downloaded manifest bundle such as `https://github.com/vibgrate/manifests/latest-packages.zip`. The manifest shape, the fail-closed errors, and what offline mode skips are in [Offline scan with a package-version manifest](#offline-scan-with-a-package-version-manifest).

### Unknown lockfile fields

Package managers add fields to lockfiles as they release. When the file still lists dependencies vg can read, an extra field does not erase that graph or the SBOM rows built from it. vg keeps the package names, versions, and dependency edges it understands.

vg prints one warning on stderr for each unknown field name in that file. Lines are sorted by lockfile path, then by field name. The same path and field name is printed once. A warning looks like this:

```text
pnpm-lock.yaml: unknown optional lockfile field "futureOptional"; continuing with the fields this version understands.
```

The path is relative to the directory you ran the command from, when the lockfile is under that directory. Otherwise the warning uses the file name only. The warning names the field. It does not print the field's value, an environment value, or an authorization header. A field name that is not a plain identifier is reported as `(name omitted)`.

A lockfile that is truncated, empty, or missing the structure its format requires still fails the command. The error names the file and the format, tells you to regenerate the file with your package manager, and the process exits non-zero. The error does not include the file's contents.

`vg scan` and `vg sbom export` follow this for npm, pnpm, yarn, poetry, uv, pdm, Pipfile, Cargo, Composer, NuGet, Swift package pins, and pub. A Gradle lock line, a Gemfile spec, and a `go.sum` line do not have optional field names. A line that does not match that format is invalid, and the command fails.

### Offline scan with a package-version manifest

`--offline` scores drift, and with `--vulns` it matches known vulnerabilities, from files on the machine. `--package-manifest` is the local file those lookups read.

#### Manifest input

The file is JSON, or a ZIP whose root contains `package-versions.json`, `manifest.json`, or `index.json`. A ZIP is unpacked with the `unzip` command. The JSON is one object. These keys are the package ecosystems, and `runtimes` is an optional catalog of runtime versions:

`npm`, `nuget`, `pypi`, `maven`, `rubygems`, `swift`, `go`, `cargo`, `composer`, `pub`, `hex`, `docker`, `helm`, `terraform`, `runtimes`

Each ecosystem value is an object keyed by package name. NuGet names are matched case-insensitively. An entry may include:

| Field | Role |
| --- | --- |
| `latest` | Newest version used for drift |
| `versions` | Versions the scanner may resolve a declared range against |
| `vulns` | Advisories `--vulns` reads when the scan is offline |
| `releaseDates` | Optional map of version to an ISO-8601 publish date, so freshness does not need a registry |

A `vulns` entry needs an `id`. `ranges` are half-open: a version matches from `introduced` up to, and not including, `fixed`. `versions` lists affected versions explicitly. `severity` is `low`, `moderate`, `high`, `critical`, or `unknown`. Optional `aliases`, `summary`, `cvss`, `cvssVector`, `epss`, `epssPercentile`, and `kev` are copied onto the advisory when you set them. A withdrawn advisory is skipped.

`vg scan` has no separate advisory-file flag. Offline advisories are the `vulns` arrays in this manifest.

A JSON value that is not this shape is rejected. That includes a `package.json`, a JSON array, and text that is not JSON. An empty object is accepted and supplies no versions and no advisories.

Minimal example, saved as `package-versions.json` next to a project whose lockfile installs `left-pad@1.3.0`:

```json
{
  "npm": {
    "left-pad": {
      "latest": "1.3.0",
      "versions": ["1.3.0"],
      "vulns": [
        {
          "id": "GHSA-example",
          "severity": "high",
          "ranges": [{ "introduced": "0", "fixed": "1.3.1" }]
        }
      ]
    }
  }
}
```

#### Offline scan

```bash
vg scan --vulns --offline --package-manifest ./package-versions.json
```

The installed version comes from the lockfile when that version still satisfies the range declared in the project. `--vulns` turns advisory matching on. `--offline` without `--vulns` still uses the file for latest-version drift and does not report advisories.

#### Missing or invalid manifest

Passing `--package-manifest` when the path is missing, unreadable, or not a package-version manifest stops the command before the scan. The exit code is `1`. Stdout is empty, and no `.vibgrate` scan artifact is written.

A missing file prints:

```text
error: Package manifest not found: /abs/path/missing.json. Pass a readable JSON or ZIP package-version manifest to --package-manifest.
```

A file that is not JSON, or JSON that is not a package-version manifest, prints:

```text
error: Package manifest is not usable: /abs/path/bad.json. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.
```

The path in the message is the resolved path you passed. A ZIP that does not contain one of those three names at its root says `The ZIP must contain package-versions.json, manifest.json, or index.json.` A file this process cannot read says `Package manifest is not readable: <path>. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.`

The fail-closed path is covered by `src/reporting/commands/scan-package-manifest.test.ts`.

#### What offline mode does not do

`--offline` does not contact package registries. It does not query the OSV database. It does not upload results, including when `--push` is set or `VIBGRATE_DSN` is present. It does not call an EPSS or KEV service. A package the manifest does not list is not requested from a registry. Known-vulnerability matches come from the `vulns` entries in the manifest.

#### Determinism

The same tree and the same manifest produce the same findings order and the same advisory ids. Vulnerability findings are ordered by ecosystem, then package name, then installed version. Advisories on one package are ordered by severity — critical, high, moderate, low, unknown — and then by advisory id. That id is the `id` from the manifest. JSON records it as `details.advisoryId`. The order of keys in the manifest file does not change the result. `timestamp` and `durationMs` on the scan artifact still change between runs. In a git checkout, an exposure window's day count follows the scan date. The advisory id and the finding order stay the same.

Registry, sign-in, and upload failures — the message `vg` prints and the next command — are in [Troubleshooting: registry, auth, and network](#troubleshooting-registry-auth-and-network).

Examples:

```bash
# Standard text scan
vg scan

# JSON output for automation
vg scan --format json --out scan.json

# JUnit XML for a CI test reporter, beside the SARIF upload
vg scan --format sarif --out vibgrate.sarif --junit vibgrate.junit.xml --fail-on error --drift-budget 40

# CI gate with baseline regression protection
vg scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error

# Upload result in the same command
vg scan --push --strict
```

Expected results:

- Clear score/risk output in terminal (or JSON/SARIF when selected).
- Exit code `2` when configured quality gates are exceeded.
- When `--push` is enabled, artifact upload is attempted after scan completion.

**Plan limits never block the scan.** If your workspace is at a plan limit that gates ingestion — repository cap, scan credits, VM minutes — the CLI warns with the reason (and the upgrade link), disables the upload, and runs the **full local scan** anyway, repeating the warning after the results so it isn't lost in the output. Local scoring never depended on the cloud, and now neither does it depend on your plan. Pass `--strict` to keep the old behaviour and fail the command instead, which is usually what you want in CI.

Maven scopes, Maven profiles, and Gradle configurations do not all become dependency rows. The included and omitted cases, and what to edit when a version is missing, are in [Maven and Gradle manifests](#maven-and-gradle-manifests).

---

### Vulnerabilities and exposure attribution

`vg scan --vulns` matches your installed dependencies against the public OSV database and records each known vulnerability — advisory id and CVE, severity, CVSS, and the fixing version — in the scan artifact, as findings, and in SARIF. Supply advisories in a `--package-manifest` bundle to run it offline. The manifest shape, the exit code `1` errors, and the offline limits are in [Offline scan with a package-version manifest](#offline-scan-with-a-package-version-manifest).

SARIF from that scan is one result per package and advisory. How a GHSA, a CVE, and other aliases share that result, and when a second code-scanning alert is expected, is under [Advisories with several ids](#advisories-with-several-ids).

Machine-readable JSON (`vg scan --format json`, and the `.vibgrate/scan_result.json` artifact) lists each advisory under `extended.vulnerabilities.packages[].advisories`. Match the package on `ecosystem`, `package`, and `version` — the same identity `vg sbom export` writes as a purl. See [Component identity](#component-identity). When the advisory data used for that scan already carries exploitability, the same object includes these optional fields:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `epss` | number, 0–1 | [FIRST EPSS](https://www.first.org/epss/) probability that the CVE is exploited in the wild within 30 days |
| `epssPercentile` | number, 0–1 | EPSS percentile for that probability |
| `kev` | boolean | Whether that advisory data marks the CVE in the CISA Known Exploited Vulnerabilities catalog |

A value that is not in the source is omitted. It is never written as `0` or `false` to mean "unknown". A present `0` is a real EPSS score, and a present `false` means the data explicitly says the CVE is not in the catalog. Text and SARIF findings are unchanged.

`vg scan --vulns --offline` and `--package-manifest` read these fields from the local bundle only. They do not contact an EPSS or KEV service. An online scan reads them from the OSV advisory document when that document already includes them, and does not make a separate exploitability request.

A package-manifest `vulns` entry accepts the same optional fields:

```json
{
  "id": "GHSA-example",
  "severity": "high",
  "ranges": [{ "introduced": "0", "fixed": "1.3.1" }],
  "epss": 0.42,
  "epssPercentile": 0.91,
  "kev": false
}
```

In a git repository the scan also attributes each finding: the commit, author, and date that introduced the vulnerable version, and how long you have been exposed. These exposure windows aggregate into remediation metrics framed around the [EU Cyber Resilience Act (CRA)](https://vibgrate.com/compliance/cra): open counts by severity, mean and maximum time exposed, and per-severity SLA breaches (defaults: critical 7 days, high 30, moderate 90, low 180). The metrics are descriptive — they show whether remediation keeps pace; they are not a compliance certification.

The scan also reconstructs **closed** exposure windows from history — a vulnerable version that was later bumped out of the affected range or removed from the lockfile entirely — and reports real remediation time (MTTR) from them: measured, not estimated. Offline, a package-version manifest extends this to advisories that are fully fixed today, so a dependency that is clean now but was once vulnerable still counts toward your remediation record.

Detection and attribution read each project's lockfile for npm / pnpm / yarn, pip / poetry / pipenv, cargo, composer, bundler, pub, hex, NuGet, and Maven/Gradle. Go is matched from direct `require` lines in `go.mod`. The pseudo-version and `+incompatible` rules are in [Go modules: pseudo-versions and +incompatible](#go-modules-pseudo-versions-and-incompatible).

```bash
# Online detection against OSV
vg scan --vulns

# Air-gapped: advisories supplied in the manifest bundle
vg scan --vulns --offline --package-manifest ./package-versions.zip

# Everything in one run: drift + vulnerabilities + a banned-dependency report
vg scan --full
```

#### Go modules: pseudo-versions and +incompatible

Go modules pin an untagged commit as a pseudo-version (`v0.0.0-20191109021931-daa7c04131f5`, or `v1.2.4-0.20210101120000-abcdefabcdef` for a commit after tag `v1.2.3`). A major of 2 or higher whose module path has no `/vN` suffix is written with `+incompatible` (`v2.0.0+incompatible`). The local comparison below is what `vg scan --vulns` uses against a package-version manifest. `--offline` keeps that comparison on the machine: no module proxy, no OSV query, no registry token. Leave `--offline` off and the same recorded version is sent to the public OSV API, which applies OSV's own comparison.

##### Which version is compared

The scan reads direct `require` lines in `go.mod`.

- A concrete `v` version that is valid semver after the leading `v` is removed is the recorded version. `v1.2.3` is recorded as `1.2.3`.
- Build metadata is dropped. `v2.0.0+incompatible` is recorded as `2.0.0`. The major stays 2.
- A pseudo-version keeps its pre-release suffix. `v0.0.0-20191109021931-daa7c04131f5` is recorded as `0.0.0-20191109021931-daa7c04131f5`.
- A bare module path, a range such as `>=1.4.0`, a line marked `// indirect`, and a token that is not a full semver (`v1.2`) are not matched against advisories.
- `go.sum` is not the version source for this match.

A range is half-open: the version matches from `introduced` up to, and not including, `fixed`. `introduced` of `0` means from the beginning. Before that check, the recorded version is reduced to `major.minor.patch`. The pre-release suffix is not ordered against the tag. An explicit `versions` list matches the recorded string exactly, so the list entry still has the pre-release suffix and has no leading `v`.

##### Pseudo-versions and tagged releases

| Require line | Recorded | Compared as | `introduced` `1.0.0`, `fixed` `1.2.4` |
| --- | --- | --- | --- |
| `v1.2.3` | `1.2.3` | `1.2.3` | matches |
| `v1.2.3-0.20210101120000-abcdefabcdef` | `1.2.3-0.20210101120000-abcdefabcdef` | `1.2.3` | matches |
| `v1.2.4-0.20210101120000-abcdefabcdef` | `1.2.4-0.20210101120000-abcdefabcdef` | `1.2.4` | does not match |
| `v0.0.0-20191109021931-daa7c04131f5` | `0.0.0-20191109021931-daa7c04131f5` | `0.0.0` | does not match |

In Go's own order, `v1.2.4-0.<timestamp>-<commit>` is a commit after `v1.2.3` and before the `v1.2.4` tag. Local matching compares it as `1.2.4`, so an advisory fixed at `1.2.4` does not include it. That gap is real. A `v0.0.0-<timestamp>-<commit>` pseudo-version (no earlier tag for that major) compares as `0.0.0`. It matches a range that starts at `0` and is fixed at `1.0.0`. It does not match a range that starts at `1.0.0`.

An explicit list entry of `v0.0.0-20191109021931-daa7c04131f5` does not match the open finding. The entry `0.0.0-20191109021931-daa7c04131f5` does. The entry `0.0.0` does not: the list is exact, and the recorded string still has the pre-release suffix.

Exposure windows replay the `require` token as written in `go.mod`, including the leading `v` and a `+incompatible` suffix. Range checks reduce that token to the same `major.minor.patch` as the open finding. An explicit `versions` list matches the string it is given, so `v2.0.0+incompatible` can match a history replay and miss the open finding (`2.0.0`), or the other way around.

##### `+incompatible`

The suffix is dropped before the comparison. `v2.0.0+incompatible` matches a range from `2.0.0` up to `2.1.0`. It does not match a range that only covers `1.x`. An explicit list entry of `v2.0.0+incompatible` does not match the open finding. The entry `2.0.0` does.

##### `replace` and `exclude`

`replace` and `exclude` are not applied before the match.

- The module path and version on the `require` line are what get matched. A `replace` to a fork, another version, or a local directory does not change that target. A `replace` with no `require` adds nothing.
- An `exclude` line does not add a module, and it does not drop a version that is also required.

The code graph records those same `require` paths, including lines marked `// indirect`, and skips `replace` and `exclude`. The graph does not store the version. Vulnerability matching still skips `// indirect`.

##### Check it locally

The two files are checked in at `examples/go-pseudo-versions/`. They use `example.com` module paths and example advisory ids. Copy them into an empty directory if you are reading this from an installed package.

`go.mod`:

```go
module example.com/demo

go 1.22

require (
	example.com/tagged v1.2.3
	example.com/pseudo-next v1.2.4-0.20210101120000-abcdefabcdef
	example.com/pseudo-base v0.0.0-20191109021931-daa7c04131f5
	example.com/oldmajor v2.0.0+incompatible
	example.com/replaced-mod v1.0.0
	example.com/indirect-mod v1.2.3 // indirect
)

exclude example.com/excluded-mod v1.2.3

replace example.com/replaced-mod => ./local

replace example.com/fork-only => example.com/fork v1.2.3
```

`package-versions.json`:

```json
{
  "go": {
    "example.com/tagged": {
      "latest": "1.2.4",
      "vulns": [
        {
          "id": "GHSA-example-tagged",
          "severity": "high",
          "ranges": [{ "introduced": "1.0.0", "fixed": "1.2.4" }]
        }
      ]
    },
    "example.com/pseudo-next": {
      "latest": "1.2.4",
      "vulns": [
        {
          "id": "GHSA-example-pseudo-next",
          "severity": "high",
          "ranges": [{ "introduced": "1.0.0", "fixed": "1.2.4" }]
        }
      ]
    },
    "example.com/pseudo-base": {
      "latest": "1.0.0",
      "vulns": [
        {
          "id": "GHSA-example-pseudo-base",
          "severity": "moderate",
          "ranges": [{ "introduced": "0", "fixed": "1.0.0" }]
        },
        {
          "id": "GHSA-example-pseudo-explicit-v",
          "severity": "low",
          "versions": ["v0.0.0-20191109021931-daa7c04131f5"]
        },
        {
          "id": "GHSA-example-pseudo-explicit-clean",
          "severity": "low",
          "versions": ["0.0.0-20191109021931-daa7c04131f5"]
        }
      ]
    },
    "example.com/oldmajor": {
      "latest": "2.1.0",
      "vulns": [
        {
          "id": "GHSA-example-incompatible-range",
          "severity": "high",
          "ranges": [{ "introduced": "2.0.0", "fixed": "2.1.0" }]
        },
        {
          "id": "GHSA-example-incompatible-v1",
          "severity": "high",
          "ranges": [{ "introduced": "1.0.0", "fixed": "1.9.0" }]
        },
        {
          "id": "GHSA-example-incompatible-explicit",
          "severity": "low",
          "versions": ["v2.0.0+incompatible"]
        }
      ]
    },
    "example.com/replaced-mod": {
      "latest": "1.0.1",
      "vulns": [
        {
          "id": "GHSA-example-replaced",
          "severity": "moderate",
          "ranges": [{ "introduced": "0", "fixed": "1.0.1" }]
        }
      ]
    },
    "example.com/indirect-mod": {
      "latest": "1.2.4",
      "vulns": [
        {
          "id": "GHSA-example-indirect",
          "severity": "high",
          "ranges": [{ "introduced": "0", "fixed": "9.0.0" }]
        }
      ]
    },
    "example.com/excluded-mod": {
      "latest": "1.2.3",
      "vulns": [
        {
          "id": "GHSA-example-excluded",
          "severity": "high",
          "ranges": [{ "introduced": "0" }]
        }
      ]
    }
  }
}
```

From that directory:

```bash
vg scan --vulns --offline --package-manifest package-versions.json --format json --out go-vulns.json
```

`findings[].details.advisoryId` in `go-vulns.json` (the same ids are under `extended.vulnerabilities.packages[].advisories`):

| Module | Advisory id | Result |
| --- | --- | --- |
| `example.com/tagged` | `GHSA-example-tagged` | reported (`1.2.3` is below `1.2.4`) |
| `example.com/pseudo-next` | `GHSA-example-pseudo-next` | absent (compared as `1.2.4`) |
| `example.com/pseudo-base` | `GHSA-example-pseudo-base` | reported (compared as `0.0.0`) |
| `example.com/pseudo-base` | `GHSA-example-pseudo-explicit-v` | absent (the list has the leading `v`) |
| `example.com/pseudo-base` | `GHSA-example-pseudo-explicit-clean` | reported |
| `example.com/oldmajor` | `GHSA-example-incompatible-range` | reported (`2.0.0`) |
| `example.com/oldmajor` | `GHSA-example-incompatible-v1` | absent (that range is `1.x`) |
| `example.com/oldmajor` | `GHSA-example-incompatible-explicit` | absent (the list is `v2.0.0+incompatible`) |
| `example.com/replaced-mod` | `GHSA-example-replaced` | reported (the `require` version; the `replace` is ignored) |
| `example.com/indirect-mod` | `GHSA-example-indirect` | absent |
| `example.com/excluded-mod` | `GHSA-example-excluded` | absent |
| `example.com/fork-only` | — | absent (`replace` only, no `require`) |

`timestamp` and `durationMs` change between runs. The advisory ids and their order do not: ecosystem, then package name, then recorded version, then severity (critical, high, moderate, low, unknown), then advisory id. The scan also writes `.vibgrate/scan_result.json` beside the `go.mod`.

##### If the match looks wrong

A surprise match, or a missing one, is a bug report. Include a local repro:

- the `go.mod` `require` line
- the advisory id and its `introduced` / `fixed` bounds, or the explicit `versions` list
- the command above, run with `--offline`, so the repro needs no network and no registry credential
- the advisory ids from the JSON, and which row in the table you expected to differ
- `vg --version`

Leave out tokens, `.netrc` contents, and private module-proxy URLs.

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

#### Which agent session wrote a line

Pass `<file:line>` instead of a package to see the commit that last changed that line. If a VG Code session made the change, you also see what it was asked.

```bash
vg review trailer on     # opt in for this repository
vg why src/orders.ts:42
```

`vg review trailer on` installs a git `prepare-commit-msg` hook. When a commit includes files that a VG Code session changed in the last 14 days, the hook adds a `Vibgrate-Session: <id>` trailer to the message.

- **Only the session's random id is committed.** The session itself (what was asked and what the agent answered) stays in `.vibgrate/code-sessions/` on the machine where it ran.
- **The hook never blocks a commit.** If anything fails, the commit goes ahead without a trailer. Merge and squash messages are left alone.
- **An existing hook is never replaced.** If another tool already owns `prepare-commit-msg`, `vg review trailer on` changes nothing and prints the one line to add to that hook.

`vg why <file:line>` blames the line, reads the commit's trailers and shows each session's title and model. It then lists the requests in that session that touched the file. The agent's own answer is shown as its account, unverified. A session that ran on another machine is named, but its contents are not shown. `vg review trailer off` removes the hook, and `vg review trailer status` shows whether it is on. Both take `--json`.

**Sessions that ran on another machine.** A session stays where it ran, so a teammate's `vg why` shows only its id. To share the sessions behind your commits with your Vibgrate Cloud workspace:

```bash
vg review trailer push --dry-run     # list what would be sent
vg review trailer push               # sessions named on commits no remote branch has yet
vg review trailer push --base origin/main
vg why src/orders.ts:42 --cloud      # a teammate reads them back
```

- **Opt-in on both sides.** Sessions are sent only when you run `push`. Vibgrate Cloud stores them only when a workspace admin has turned on Agent provenance under Source control. It is off by default.
- **What is sent:** per turn, the request, the agent's summary, the repo-relative files it changed and a timestamp. File contents, diffs and attachments are never sent.
- **Credentials:** they are masked before sending. A session that still carries one is not sent, and `push` says which.
- **Retention:** 365 days from the first upload. Turning the setting off deletes every stored session at once.

Both commands use your DSN (`vg login`, `VIBGRATE_DSN` or `--dsn`).

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

A local ONNX embedding model is downloaded once on first use, then cached and fully offline. Degrades gracefully to lexical-only under `--offline` or `--no-semantic`.

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
| `--attest` | — | After the map is written, sign it. See [Sign and check the map](#sign-and-check-the-map) |
| `--verify` | — | Check an attestation against the map on disk, and run the determinism self-check. Does not sign, and does not replace the map |
| `--attest-key <path>` | `$VG_ATTEST_KEY`, else `.vibgrate/attest-key.pem` | Ed25519 private key PEM used by `--attest` |
| `--attestation <file>` | `.vibgrate/attestation.intoto.jsonl` | Where `--attest` writes, and where `--verify` reads |
| `--pub <path>` | — | Public key PEM that pins the signer for `--verify` |

`vg build` does not follow symlinks while it discovers files. A skipped link is named once on stderr. See [Symlinks](#symlinks). `.gitignore` and `--exclude` still apply.

**Local by default — no git churn.** The first time vg writes into `.vibgrate/` it also creates `.vibgrate/.gitignore`, keeping the graph artifacts (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `facts.jsonl`, `mcp-navigation.json`) and the cache out of git — so builds, auto-refreshes, and MCP use never leave your branch dirty. Run `vg share` when you want the map committed for your team (it rewrites that ignore file). vg never touches an existing `.vibgrate/.gitignore`, so edit it (or leave it empty) to manage the ignores yourself.

Maven `import` edges, and the Gradle files that stay document nodes, are in [Maven and Gradle manifests](#maven-and-gradle-manifests). How a GitHub Actions `uses:` pin is copied into the map: [Action pins in the code map](./docs/ci/github-actions.md#action-pins-in-the-code-map).

#### Sign and check the map

There is no `vg attest-actions` command. Signing and checking are flags on `vg build`. `vg attest` and `vg verify` are retired names: each exits `5` and prints where the flag moved. A GitHub Actions `uses:` pin is recorded while the map is built. This signature does not classify that pin. See [Action pins in the code map](./docs/ci/github-actions.md#action-pins-in-the-code-map).

```text
error: `vg attest` has moved to `vg build --attest`
error: `vg verify` has moved to `vg build --verify`
```

`--attest` builds the map, writes the usual artifacts, then signs that map. `--verify` does not take that path. If both flags are set, `--verify` runs and nothing is signed.

**Purpose.** The attestation is a signed statement that this map was produced by this `vg` version, over this corpus, and (when git can say so) at this commit. A later `vg build --verify` checks that statement against the map already on disk. It does not decide that the source was reviewed, and it does not certify a build environment.

**Inputs and outputs.**

| | `--attest` | `--verify` |
| --- | --- | --- |
| Reads | The project tree, then an Ed25519 private key | The attestation file, the map already on disk, and the project tree (the determinism rebuilds). `--pub` adds a public key PEM |
| Writes | The usual map artifacts, then the attestation file. The first run with no key at the default path also writes the key pair | Nothing. The in-memory rebuilds are not saved over `graph.json`, and no attestation is written |

**What `--attest` writes.** A one-line DSSE envelope at `.vibgrate/attestation.intoto.jsonl`. `--attestation <file>` chooses another path. The envelope's payload type is `application/vnd.in-toto+json`. Inside it is an in-toto Statement (`https://in-toto.io/Statement/v1`) whose predicate type is `https://vibgrate.com/attestation/code-graph/v1`. The subject is `graph.json`. Its sha256 is the canonical map with `generatedAt` left out, so two builds of the same content share a digest. The predicate records the tool name and version, the toolchain fingerprint, the corpus hash, that digest, the node/edge/area counts, and commit metadata when git provided it. The signature block also carries the signer's public key, so a later check can test that the bytes were not altered without a separate key file. The same graph and the same Ed25519 key produce the same envelope. No timestamp is written.

If that file cannot be serialized or written, the command exits `1` and names the path. Check the path and permissions, or pass another `--attestation` path.

The default `.vibgrate/.gitignore` does not list `attestation.intoto.jsonl`. The file is meant to be committed. The private key is not.

**Key.** `--attest` reads an Ed25519 private key in this order: `--attest-key <path>`, then `VG_ATTEST_KEY`, then `.vibgrate/attest-key.pem`. When nothing names a key and the default path is missing, the first run creates an Ed25519 key there, mode `0600`, and writes the public key beside it as `.vibgrate/attest-key.pem.pub`. It prints:

```text
  minted a new Ed25519 signing key at .vibgrate/attest-key.pem (keyid <16 hex chars>) — keep it, add it to .gitignore, and reuse it to re-sign reproducibly
```

Keep that private key. Add it to `.gitignore`. The same key is what a later signature must use if you want the same signer. Do not commit it, and do not paste it into a doc, a CI log, or a chat. The `.pub` file is what you pass to `--pub`. A key you name with `--attest-key` or `VG_ATTEST_KEY` is never created for you.

On success the human output adds a line of this shape (the digest is the first 16 hex characters of the subject sha256):

```text
  attested · keyid <16 hex chars> · digest <16 hex chars>… → .vibgrate/attestation.intoto.jsonl
```

`--json` puts the same facts on `attestation` (`keyid`, `graphDigest`, `fingerprint`, `commit`, `out`). When this run created the key, `keyGeneratedAt` is the key path, not a time. The mint notice is not repeated in the JSON.

**What `--verify` checks.** It does two things, then exits.

1. Determinism. It builds the map in memory twice with the cache off (the second build single-threaded) and once with the cache warm, and compares those builds. When a committed map is present and you did not pass `--only` or `--exclude`, it also compares toolchain fingerprints. These builds are not written over `graph.json`.
2. The attestation. It reads the file (default `.vibgrate/attestation.intoto.jsonl`, or `--attestation <file>`) and compares it to the map already on disk. It does not rebuild in order to check the signature, and it does not re-read git. `dirty` in the result is the flag stored when you signed.

`--pub <path>` pins the signer. Without it, a good signature is integrity only: the embedded public key shows the envelope was not edited, not that you trust who signed it.

JSON `status` is one of three values. On a terminal the line above the reason is `✔ attestation verified`, `~ attestation signature valid`, or `✘ attestation failed`, plus ` · keyid <16 hex chars>` when a key id is present.

| Status | Exit | Reason text |
| --- | --- | --- |
| `verified` | `0` | `signature valid, signer trusted, graph digest matches` when the on-disk map was compared and matched. `signature valid, signer trusted` when no map was on disk, so the digest was not compared |
| `signature-valid` | `0` | `signature valid but signer not pinned — pass --pub to establish trust`, or `signature valid but the attested tree was dirty (uncommitted changes)` |
| `failed` | `2` | `signature verification failed`, `no signature in envelope`, `graph.json no longer matches the attested digest (content changed since signing)`, or `malformed attestation payload (not a valid in-toto statement)` |

`verified` requires a pinned key, a valid signature, and a statement that was not marked dirty at sign time. A dirty tree at sign time stays `signature-valid` even when you pass `--pub`. A missing map does not by itself fail the signature; read the reason line before treating `verified` as "the map matches."

A missing file at the default path, with no `--attestation` and no `--pub`, is not a failure. The command prints:

```text
  attestation: none (sign one with `vg build --attest`)
```

JSON sets `attestation` to `null`. The process still exits `4` when the determinism checks fail, and `0` when they pass.

**Network.** The signature and the check use local Ed25519 only. Nothing is uploaded, and no attestation service is called. While signing, `git` is used when it works: current commit (`rev-parse HEAD`), whether the tree is dirty (`status --porcelain`), and the branch name (`rev-parse --abbrev-ref HEAD`). No git, or a failed `rev-parse HEAD`, omits commit metadata. A detached `HEAD` or a failed branch command omits the branch. A failed status command omits `dirty`. Those calls do not fetch or push.

`vg build --attest` is still a build. Unless you pass `--offline` or `--local`, that build can download the Architecture module. On an interactive terminal it can also start an embedding-model download unless you pass `--offline`, `--local`, `--no-warm`, `--json`, or `--quiet`. The signature step does not add a network call. `vg build --verify` does not install modules and does not upload. Its in-memory rebuilds read the local tree.

#### Try it

Sign the map in the current directory, then check it against the public key written next to the private key:

```bash
vg build --attest
vg build --verify --pub .vibgrate/attest-key.pem.pub
```

The second command prints a determinism line for each check, then an attestation line. With a clean tree at sign time and a matching map, the reason is `signature valid, signer trusted, graph digest matches`.

Asking to verify a file that is not there is a failure. From the project root, before any attestation has been written:

```bash
vg build --verify --attestation .vibgrate/attestation.intoto.jsonl
```

```text
error: no attestation at .vibgrate/attestation.intoto.jsonl — sign one with `vg build --attest`
```

Exit code `3`. The path in the message is the path you named, relative to the project root when it sits inside that root.

#### What to check when it fails

`<path>`, `<type>`, and the hex fields below are filled in by the command. The surrounding words are the text it prints.

Exit `3`. You passed `--attestation`, or you passed `--pub`, and that file is not there. `--pub` alone, with no file at the default path, raises this same error. Sign with `vg build --attest`, or point `--attestation` at the file you committed.

```text
error: no attestation at <path> — sign one with `vg build --attest`
```

Not a failed signature. No attestation is at the default path, and you did not name one. The exit is `0` when the determinism checks pass, and `4` when they do not. Sign if you wanted the file checked.

```text
  attestation: none (sign one with `vg build --attest`)
```

Exit `5`. `--attest-key` or `VG_ATTEST_KEY` names a file that is not there. The message keeps the path you supplied. The default path is created only when you do not name a key.

```text
error: signing key not found: <path>
```

Exit `5`. The file is there but is not a PEM private key.

```text
error: could not read an Ed25519 private key from <path>
```

Exit `5`. The PEM is some other algorithm (`rsa`, `ec`, …) or `unknown`. Use an Ed25519 key.

```text
error: attest requires an Ed25519 key, but <path> is <type>
```

Exit `2`. Read the reason on the line above. A bad signature means the file, the key you pinned, or both do not match. A digest mismatch means the map on disk changed after signing: run `vg build --attest` again with the same key. `malformed attestation payload (not a valid in-toto statement)` means the file parsed as an envelope but the payload inside is not an in-toto statement.

A file that is not a JSON line never reaches that reason. Parsing it throws, the process exits `1`, and the message is the JSON parser's text plus a `ref` line. Replace the file, or sign a new one with `vg build --attest`.

`--pub` is read only after an attestation file is found. A public-key path that is not there is the same kind of exit `1`: the message names the missing path. Point `--pub` at a PEM that exists. When the attestation file is also missing, you get the exit `3` line above instead, because that check runs first.

```text
error: attestation verification failed
```

Exit `4`. The in-memory rebuilds disagreed, or the toolchain fingerprint does not match the committed map. The check line names which one. Two builds that differ print `first divergence at line <n>`. A fingerprint mismatch prints `committed toolchain <old> != current <new> (grammar/resolver versions differ — rebuild or align the toolchain)`. This exit is reported even when the attestation also failed.

```text
error: determinism self-check failed
```

Exit `5`. Those names are retired.

```text
error: `vg attest` has moved to `vg build --attest`
error: `vg verify` has moved to `vg build --verify`
```

---

### Maven and Gradle manifests

`vg scan` and `vg build` read Java build files as text and XML. They do not run Maven or Gradle, and they do not decide which Maven profile is active. A profile that is `activeByDefault`, and a profile that is not, are treated the same: the dependencies inside `<profiles>` are left out of both outputs.

`vg scan` writes one dependency row per coordinate it keeps. The rows are `projects[].dependencies` in `vg scan --format json` and in `.vibgrate/scan_result.json`. `vg build` writes `import` edges in the code map (`graph.json`, or the file you pass to `vg build -o`). `vg show` lists call edges. On a POM-only tree its `calls` list stays empty even when `import` edges exist. Read the map file for those edges.

`vg drift` is a third reader. It is not this table. On a POM it records every `<dependency>` element it finds as text, including blocks inside profiles, and it stores an unresolved `${property}` as `*`. On Gradle it does not read `gradle.lockfile`.

#### What each output carries

A code-map `import` edge runs from the POM's `package` node to an `external` node. The external name is `groupId:artifactId`. The edge fields are `kind: "import"`, `epistemic: "declared"`, `resolution: "heuristic"`, `confidence: 1`, `count: 1`. There is no version field and no scope field. The package node's qualified name is `groupId:artifactId` when the POM has its own `<groupId>`. When `<groupId>` is only on a parent POM, the qualified name is the `<artifactId>` alone.

A scan row has `package` (`groupId:artifactId`), `section`, `currentSpec`, `resolvedVersion`, `latestStable`, `majorsBehind`, and `drift`. `section` is `dependencies` for every Java row, including `<scope>test</scope>` and `testImplementation`. Scope and the Gradle configuration name are not fields. A missing resolved version is `null`, and a missing major lag is `null`.

`resolvedVersion` is the declared version when that string converts to a semantic version, with a missing patch padded (`1.2` becomes `1.2.0`). `32.1.3-jre` is kept. `1.2.3-SNAPSHOT` and a Maven range such as `[1.0,2.0)` stay in `currentSpec` and set `resolvedVersion` to `null`. With `--offline`, `latestStable` is `null` and `drift` is `unknown`. A run that can reach Maven Central fills `latestStable` and `drift` from that registry.

#### Maven

| Declaration in the POM | `vg build` import edge | `vg scan` row |
| --- | --- | --- |
| Top-level `<dependencies>` entry with a literal `<version>`, any `<scope>` (`compile`, `test`, `provided`, `runtime`) | Included. Scope is dropped. | Included. `currentSpec` is the version. `section` is `dependencies`. |
| Top-level entry with no `<version>` | Included. The edge still has no version. | Omitted. |
| Top-level `<version>${name}</version>` and `<properties><name>…</name></properties>` in the same file | Included. The edge name is still `groupId:artifactId`. | Included. `currentSpec` is the property value. |
| `${…}` that is not a `<properties>` entry in the same file, including `${project.version}` | Included. | Omitted. The unsubstituted text contains `${`. |
| `<dependencyManagement>` entry in the same file with `groupId`, `artifactId`, and `<version>` (a BOM `<scope>import</scope>` included) | Omitted. | Included, even when `<dependencies>` never names that coordinate. |
| `<dependencyManagement>` entry with no `<version>` | Omitted. | Omitted. |
| `<dependencies>` or `<dependencyManagement>` inside `<profiles>`, whether or not the profile is `activeByDefault` | Omitted. | Omitted. |
| Version that exists only on a parent POM's `<dependencyManagement>` | Edge from the child POM when the child lists the coordinate under its own top-level `<dependencies>`. The parent's management block is not an edge. | Omitted on the child. The parent file can still have its own row for a versioned management entry in that parent file. |
| `<dependencies>` nested under a `<plugin>` | Omitted. | Omitted. |

A direct dependency and a `<dependencyManagement>` entry for the same coordinate in one file: the direct entry is first. A direct entry that has a version keeps that version. A direct entry with no version is skipped, and the versioned management entry can still supply the row.

#### Gradle

`vg scan` reads `build.gradle` and `build.gradle.kts`. The match is a text search over the whole file for these configuration names: `implementation`, `api`, `compileOnly`, `runtimeOnly`, `testImplementation`, `testRuntimeOnly`, `annotationProcessor`, `kapt`. The coordinate has to be a quoted `group:artifact:version` (`implementation 'g:a:v'` or `implementation("g:a:v")`). `implementation platform('g:a:v')` and `api(platform("g:a:v"))` are included too. The configuration name is not stored.

| Declaration | `vg build` import edge | `vg scan` row |
| --- | --- | --- |
| Quoted `group:artifact:version` on a configuration in the list above | Omitted. The file is a `document` node (`build.gradle.kts` is also a Kotlin `file` node). | Included. `currentSpec` is the third colon field. |
| `implementation platform('g:a:v')` or `api(platform("g:a:v"))` | Omitted. | Included. |
| Same configurations with no version (`implementation 'g:a'`) | Omitted. | Omitted. A `gradle.lockfile` line for that coordinate does not add the row. |
| Dynamic version such as `1.+`, with `gradle.lockfile` beside the build file containing `group:artifact:1.4.2=runtimeClasspath` | Omitted. The lockfile is not a map input. | Included. `currentSpec` stays `1.+`. `resolvedVersion` is `1.4.2`. |
| Custom configuration (`integrationTestImplementation`, `smoke`), legacy `compile`, Spring `developmentOnly` | Omitted. | Omitted. |
| Version catalog (`implementation(libs.guava)`), map notation (`group:`, `name:`, `version:`), `project(':core')` | Omitted. | Omitted. |
| A matching configuration string in a comment, or inside `constraints { }` | Omitted. | Included. The search does not know comments or which block it is in. |

`gradle.lockfile` lines look like `group:artifact:version=conf1,conf2`. Blank lines, `#` comments, and `empty=` are skipped. The first line for a coordinate wins. The configuration list on that line is not copied onto the row. The lockfile version is used for `resolvedVersion` only when the build file already contributed that coordinate with a non-empty version string. `currentSpec` stays the declared text.

#### Same directory

A directory that contains both `pom.xml` and `build.gradle` (or `build.gradle.kts`) is one scan project. Both files contribute coordinates. The version kept for a coordinate that appears in both is the one from whichever file the directory listing returns first. A later file does not replace it. The project name is whatever the last file sets (the POM's `<artifactId>`, or the directory name from the Gradle file). **Gap:** that order is not sorted, and there is no stable preference for the POM. On one check, `build.gradle` was first, so `com.example:shared` kept the Gradle version `9.9.9`, and `pom.xml` was second, so the project name was the POM artifact id. The code map for that tree had `import` edges only from the POM.

#### Gaps

- Profile activation is not evaluated. Active and inactive profile dependencies are both omitted from `vg scan` and from `vg build`.
- `import` edges never carry a version or a scope, including when the POM has both.
- Gradle dependencies never become `import` edges. `gradle.lockfile` is not read by `vg build`.
- Scan rows do not record Maven scope or the Gradle configuration. Test-scoped and `testImplementation` coordinates are `section: "dependencies"`.
- A versioned `<dependencyManagement>` entry becomes a scan row even when the POM does not depend on that artifact. A BOM import can show up as its own row.
- Parent POMs, imported BOMs that this file does not restate, and `${project.version}` do not fill a missing child version.
- A `gradle.lockfile` does not create a row for a coordinate the build file declared without a version.
- The Gradle reader is a text search. Commented-out lines and `constraints` blocks that contain a recognized configuration become rows. Custom configurations, catalogs, map notation, and `project()` dependencies do not.
- Two manifests in one directory do not have a defined winner.

#### Recover a missing version

**Maven, scan row missing.** Put a literal `<version>` on the `<dependency>` in that same `pom.xml`, or use `${name}` with `<name>` defined in that file's `<properties>`. A versioned `<dependencyManagement>` entry in that same file also creates the row. Move a profile coordinate you need scored into the top-level `<dependencies>` or into that file's `<dependencyManagement>`, with a version. Repeat a parent-managed or BOM-managed version in this file. Replace `${project.version}` with a literal or with a `<properties>` entry in this file.

**Gradle, scan row missing.** Declare `group:artifact:version` on `implementation`, `api`, `compileOnly`, `runtimeOnly`, `testImplementation`, `testRuntimeOnly`, `annotationProcessor`, or `kapt`, or use `implementation platform('g:a:v')` / `api(platform("g:a:v"))`. A declaration with no version stays omitted; add the version on that line. `gradle.lockfile` then supplies `resolvedVersion` for a dynamic declared version (`1.+`) and leaves `currentSpec` as the text you wrote. Generate the lockfile with Gradle's dependency locking so the line is `group:artifact:version=configurations`, and keep it next to the build file. For a custom configuration or a version-catalog alias, declare the same coordinate again on one of the configurations above. Delete a commented-out coordinate if it should not be a row.

**`resolvedVersion` is null.** The row is present and `currentSpec` holds the declared text, and the text is not a semantic version (`1.2.3-SNAPSHOT`, `[1.0,2.0)`, `1.+` with no lockfile pin). Pin a semantic version in the declaration, or add a `gradle.lockfile` pin for a dynamic Gradle version.

**Code map.** Adding a `<version>` does not put a version on the `import` edge. **Gap:** there is no switch that adds versions to those edges. A missing Maven edge comes back when the coordinate is a direct child of the top-level `<dependencies>` in that POM. A missing version does not block the edge. **Gap:** `vg build` does not create Gradle dependency edges. `vg scan` is the command that lists those coordinates.

#### Example: Maven

`pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <properties>
    <jackson.version>2.17.0</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.1.3-jre</version>
      <scope>compile</scope>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>${jackson.version}</version>
    </dependency>
  </dependencies>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.squareup.okhttp3</groupId>
        <artifactId>okhttp</artifactId>
        <version>4.12.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <profiles>
    <profile>
      <id>extra</id>
      <activation>
        <activeByDefault>true</activeByDefault>
      </activation>
      <dependencies>
        <dependency>
          <groupId>com.google.code.gson</groupId>
          <artifactId>gson</artifactId>
          <version>2.10.1</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
</project>
```

From that directory:

```bash
vg build --no-html --no-report -o graph.json
vg scan --offline --format json --out scan.json --no-graph
```

`vg build` on this file wrote 7 nodes and 5 edges, 4 of them `import` edges from `com.example:demo`:

- `com.fasterxml.jackson.core:jackson-databind`
- `com.google.guava:guava`
- `junit:junit`
- `org.slf4j:slf4j-api`

`com.squareup.okhttp3:okhttp` and `com.google.code.gson:gson` were not edges. `vg show demo --json` reported `calls` and `calledBy` as empty arrays.

`vg scan --offline` wrote these rows (`latestStable` and `majorsBehind` are `null`, `drift` is `unknown`, because the run did not ask Maven Central). `org.slf4j:slf4j-api` and `gson` are absent:

```json
[
  {
    "package": "com.fasterxml.jackson.core:jackson-databind",
    "section": "dependencies",
    "currentSpec": "2.17.0",
    "resolvedVersion": "2.17.0",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  },
  {
    "package": "com.google.guava:guava",
    "section": "dependencies",
    "currentSpec": "32.1.3-jre",
    "resolvedVersion": "32.1.3-jre",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  },
  {
    "package": "com.squareup.okhttp3:okhttp",
    "section": "dependencies",
    "currentSpec": "4.12.0",
    "resolvedVersion": "4.12.0",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  },
  {
    "package": "junit:junit",
    "section": "dependencies",
    "currentSpec": "4.13.2",
    "resolvedVersion": "4.13.2",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  }
]
```

The test-scoped JUnit row uses `section: "dependencies"`. OkHttp is a row because `<dependencyManagement>` in this file carries a version. Gson stays out because it lives in a profile, including one marked `activeByDefault`.

#### Example: Gradle

`build.gradle`:

```groovy
dependencies {
    implementation 'com.google.guava:guava:32.1.3-jre'
    testImplementation 'junit:junit:4.13.2'
    implementation 'com.example:dynamic:1.+'
    implementation 'com.example:managed'
    integrationTestImplementation 'com.example:it:2.0.0'
}
```

`gradle.lockfile` in the same directory:

```text
# This is a Gradle generated file for dependency locking.
com.example:dynamic:1.4.2=runtimeClasspath
com.example:managed:4.5.6=runtimeClasspath
empty=
```

From that directory, the same two commands:

```bash
vg build --no-html --no-report -o graph.json
vg scan --offline --format json --out scan.json --no-graph
```

`vg build` wrote one `document` node, `build.gradle`, and zero edges. The lockfile was not a node.

`vg scan --offline` named the project from the directory (`gradle` when the folder is `gradle`) and wrote:

```json
[
  {
    "package": "com.example:dynamic",
    "section": "dependencies",
    "currentSpec": "1.+",
    "resolvedVersion": "1.4.2",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  },
  {
    "package": "com.google.guava:guava",
    "section": "dependencies",
    "currentSpec": "32.1.3-jre",
    "resolvedVersion": "32.1.3-jre",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  },
  {
    "package": "junit:junit",
    "section": "dependencies",
    "currentSpec": "4.13.2",
    "resolvedVersion": "4.13.2",
    "latestStable": null,
    "majorsBehind": null,
    "drift": "unknown"
  }
]
```

`com.example:managed` is absent even though the lockfile pins `4.5.6`, because the build file has no version. `com.example:it` is absent because `integrationTestImplementation` is a custom configuration. JUnit's `testImplementation` row is still `section: "dependencies"`. `currentSpec` for the dynamic coordinate stays `1.+`; the lockfile supplies `resolvedVersion`.

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

A coding **agent** grounded in the deterministic code graph: its search tool resolves symbols and relations from the map, not text matches from a grep. It runs on a local model or a hosted one, and every change it makes to your working tree is approved before it lands.

```bash
vg code                                            # guided: pick a model, then describe tasks
vg code "add a --timeout flag to the scan command"
```

#### Does it write to my disk?

Yes — through approved steps, and only those. This is the one thing to be clear about before you run it:

| You run | What happens |
|---|---|
| `vg code` or `vg code "<instruction>"` at a terminal | The **agent loop**. Read-only steps (search, read, list, impact) run without prompting. Every edit and every command **asks you first**, and writes when you approve. |
| `… --auto` | The same loop with no prompts. A denylist blocks catastrophic commands. For CI and scripted runs. |
| `… --single` | The **one-shot planner**: one proposed edit, no tool loop, no commands. **Dry-run by default** — it prints the diff and writes nothing unless you pass `--apply` *and* `--yes`. |
| `… --mock <file>` | The one-shot path driven by a scripted reply instead of a model (offline; tests, CI, benchmarks). |

The agent loop is the default. `--apply` and `--yes` belong to `--single` / `--mock` only — in the agent loop, consent is the per-step approval instead. Without a TTY and without `--auto`, `vg code` refuses to start rather than writing unattended.

**How the loop works.** The model is given tools and works in steps — search the code graph, read files, check a symbol's blast radius, edit, create/delete files, and run your tests or build — until the task is done. `--max-steps <n>` caps the loop (default 24).

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

**In a session** you can type slash-commands:

| Command | What it does |
|---|---|
| `/undo` | Revert the files changed by the last task |
| `/diff` | Show the last change |
| `/model` | Switch model without leaving the session |
| `/cost` | Running token/$ cost for the session (local models are free) |
| `/compact` | Condense the session so far into one checkpoint recap |
| `/clear` | Explains that each task already starts fresh — nothing to clear |
| `/help` | List the commands |
| `/exit` | Quit (an empty line, `exit`, or `quit` also work) |

**More session controls:**

- `--stream` streams the model's output live as it's generated.
- `--verify [command]` runs your tests after the agent finishes and, if they fail, feeds the failures back so it fixes them (uses the `testCommand` from config if you don't name one).
- `--continue [id]` resumes a session — your most recent one, or the id you name — recapping what was already done for the model and restoring `/undo`.
- `--reasoning-effort low|medium|high` tells a reasoning-capable model how hard to think (models without the knob ignore it).
- `--worktree` runs the session in an **isolated git worktree** under `.vibgrate/worktrees`, so an agent can work without touching your checkout. Bare `--worktree` creates one; `--worktree <id>` reuses it. Inspect and land the result with `--worktree-diff <id>` (print the delta as a patch), `--worktree-apply <id>` (apply it onto the main tree via `git apply --3way`), and `--worktree-remove <id>`.
- `--security-tier <tier>` sets shell isolation for `run_command`: `L0` runs on the host, `L1` uses Seatbelt or bubblewrap where available (`L2`/`L3` are reserved).
- A live **token/$ meter** shows after each task and via `/cost` (cost is shown when the model's price is known; local models are free).
- **External MCP tools:** list servers under `mcpServers` in `.vibgrate/code.json` and the agent can call their tools (namespaced `mcp__<server>__<tool>`); read-only tools run freely, anything else is approved like a built-in mutating tool. VG Code also **adopts the standard MCP config files** already in your repo — `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), and `.vscode/mcp.json` (VS Code) — and merges them with your `.vibgrate/code.json` (which wins on any name clash), so servers you've already configured for another tool work here with no extra setup. Both local (`command`) and remote (`url`) servers are supported.

**Tools the agent has.** Searching is the code graph (`search_code`) — not a grep. Read-only tools run without prompting; the rest are approved per step (or auto-approved under `--auto`).

| Tool | What it does | Approval |
|---|---|---|
| `search_code` | Search the code graph: symbols and relations, plus a literal sweep for exact phrases and URLs | free |
| `read_file` / `list_files` | Read a file (or a line range); list files known to the map | free |
| `graph_impact` | Blast radius of changing a symbol — callers, importers, subtypes | free |
| `library_docs` | Version-correct docs for a dependency this project actually installs | free |
| `set_progress` | Maintain the task checklist shown during the run | free |
| `inspect_task` / `inspect_change` / `verify_change` | Governance steps: assess the task, review a pending change, verify the result | free |
| `edit_file` / `create_file` / `delete_file` | Change the working tree | **approved** |
| `apply_patch` | Apply a validated PatchIR multi-op edit transactionally | **approved** per file |
| `run_command` | Run tests, builds, or any other shell command | **approved** |
| `read_notebook` / `edit_notebook_cell` | Read a Jupyter notebook; edit one cell | read free · edit **approved** |
| `web_fetch` / `web_search` | Fetch a URL or search the web — results are size-capped, secret-redacted, and treated as untrusted | **approved** |
| `browser_*` | Drive a browser: start, navigate, snapshot, click, type, stop | start/navigate **approved** |
| `spawn_subagent` | Delegate a sub-task to a nested agent (optionally in a worktree) | **approved** |
| `ask_user` | Ask you a question mid-task | free |
| `finish` / `abort` | End the task with a summary, or give up | free |
| `mcp__<server>__<tool>` | Tools from your configured MCP servers | free if read-only, else **approved** |

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

| Key | Default | Notes |
|---|---|---|
| `provider` | auto | `vibgrate-relay`, `ollama`, `lmstudio`, `foundry-local`, `openrouter`, `litellm`, `openai`, `together`, `llama-cpp` |
| `model` | — | Model id/slug (or set `VG_CODE_MODEL`) |
| `auto` | `false` | Run autonomously (auto-approve) by default |
| `testCommand` | — | The project's test command, surfaced to the agent and used by `--verify` |
| `denyCommands` | — | Extra regex/substring rules blocked on top of the built-in denylist |
| `contextWindow` | model default | Override the usable context window (tokens) for compaction sizing |
| `maxSteps` | `24` | Default step cap for the agent loop |
| `capsule` | — | Prefer a source-bearing Task Capsule for first context (`--capsule` / `--no-capsule`) |
| `securityTier` | `L0` | Shell isolation: `L0` host, `L1` Seatbelt/bubblewrap where available (`L2`/`L3` reserved) |
| `modelProfile` | derived | Overrides merged onto the model-derived profile: `mode`, `capsuleBudgetTokens`, `maxRepairRounds`, `constrainedDecoding`, `securityTier` |
| `mcpServers` | — | External MCP servers (name → launch spec), merged with `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`; this file wins on a name clash |

A missing or malformed file is simply "no config", never an error.

**How an edit is built.** It assembles a small, high-signal context from the map (the relevant symbols, their relations, the blast radius of changing them, and any hard constraints), asks the model for a minimal edit, and applies that edit through a deterministic merge so the change lands exactly where it was meant to. Before an edit is written, its replacement body is scanned against the graph's identifier trie: an edit that references a symbol the graph does not know — and that is not already local to the target file — is **blocked, not merely flagged**.

**The one-shot path.** `--single` skips the tool loop and proposes a single edit. That path is dry-run by default; `--apply` walks the full inspect → assess → dry-run → approve → execute → verify → log lifecycle, and still requires your explicit `--yes` (or an interactive confirmation) — there is no write-without-consent path.

```bash
vg code "rename readCfg to readConfig everywhere it is called" --single --apply --yes
```

Pick a backend with `--provider` and `--model`. No model is bundled, and nothing is installed until you first use a backend that needs it:

- **Local** — a Code Mode pack, `--provider ollama`, `--provider lmstudio`, `--provider foundry-local`, or `--provider llama-cpp --model-path <gguf>` (or `--local` to force on-device only).
- **Vibgrate Relay** — the first-party hosted router that supplements your local models: `--provider vibgrate-relay`, authenticated with `VIBGRATE_RELAY_TOKEN` instead of a per-provider API key. Set `VIBGRATE_RELAY_URL` to point at staging or a self-hosted deployment.
- **Other hosted** — any OpenAI-compatible endpoint: `--provider openrouter` / `litellm` / `openai` / `together`. API keys are read from the environment only (e.g. `OPENROUTER_API_KEY`), never passed as flags.

With no `--provider`, `vg code` chooses from what you have already configured, best first: **Vibgrate Relay** when `VIBGRATE_RELAY_TOKEN` is set (with local fallback if Relay is unreachable), then another configured hosted key, then a locally-pulled model. It never dials a cloud endpoint you didn't set up.

| Flag | Default | Description |
|------|---------|-------------|
| `<instruction>` | — | What to change, in plain language. Omit it at a TTY for guided mode. |
| `--provider <id>` | auto | `vibgrate-relay`, `ollama`, `lmstudio`, `foundry-local`, `openrouter`, `litellm`, `openai`, `together`, `llama-cpp` |
| `--model <id>` | — | Model id (or set `VG_CODE_MODEL`) |
| `--mode <mode>` | auto-fit | Code Mode: `spark` \| `flow` \| `forge` — preferred over raw model names |
| `--model-path <gguf>` | — | GGUF path for `--provider llama-cpp` (weights are never auto-downloaded) |
| `-f, --file <path>` | — | Restrict the edit surface to this file (repeatable) |
| `-b, --budget <n>` | `3000` | Approx context token budget |
| `--auto` | — | Autonomous: auto-approve every edit and command (denylist still applies) |
| `--max-steps <n>` | `24` | Cap the number of agent steps |
| `--single` | — | One-shot planner (single edit, no tool loop) instead of the agent |
| `--apply` | — | `--single`/`--mock` only: write the change (still requires `--yes` or a confirmation) |
| `--yes` | — | Consent to write, or to a first-use package install, non-interactively |
| `--stream` | — | Stream the model output live |
| `--verify [command]` | — | After the agent finishes, run tests and feed failures back for repair (uses `testCommand` when no command is given) |
| `--continue [id]` | — | Resume the most recent session, or the given session id (recap + restore `/undo`) |
| `--reasoning-effort <level>` | model default | How hard a reasoning-capable model should think: `low` \| `medium` \| `high` |
| `--worktree [id]` | — | Run the session in an isolated git worktree under `.vibgrate/worktrees` |
| `--worktree-diff` / `--worktree-apply` / `--worktree-remove <id>` | — | One-shot worktree review flow: print the delta, apply it onto the main tree (`git apply --3way`), or remove the checkout |
| `--capsule` / `--no-capsule` | config | Use (or disable) a source-bearing Task Capsule for first context |
| `--security-tier <tier>` | `L0` | Shell isolation: `L0` host, `L1` Seatbelt/bubblewrap where available |
| `--restore-checkpoint <commit>` | — | One-shot: restore the given `--file` paths from a checkpoint commit, then exit (for host UIs) |
| `--stream-json` | — | Machine protocol: NDJSON agent events on stdout, approval decisions on stdin (host UIs such as the VS Code panel) |
| `--session` | — | With `--stream-json`: stay open for further turns instead of exiting after one |
| `--mock <file>` | — | Use a scripted reply instead of a model (offline; tests/CI/benchmarks) |
| `-o, --out <file>` | — | Write the JSON result to a file (for CI/benchmarks) |
| `--local` (global) | — | On-device model backends only — never a hosted model. Implies `--offline` |

`--stream-json` is the protocol **Vibgrate for VS Code** speaks to the CLI: the panel renders the agent's steps, approves or denies each mutating tool call over stdin, and with `--session` keeps one warm graph across turns. It is a supported surface for any host UI, not just ours.

Add `--json` for the full machine-readable result (proposed changes, diffs, and the verification summary), or `--out <file>` to write it for CI. Requires a map — run `vg` first if you have not built one.

#### Tool results are compressed

Inside the agent loop there is no wire to sit on, so `vg code` applies
[context compression](#context-compression) itself: a bulky `run_command`,
`search_code` or `web_fetch` result is compressed once on the way into the
transcript instead of being re-billed on every later step. Reads an edit is
computed from, and failed results, are never touched. The original stays in the
local retrievable store and the model gets a `vg_retrieve` tool, so it can pull
back the whole result or just the lines it needs (`grep`, `lines`, `head`,
`tail`, capped by `VG_CODE_RETRIEVE_MAX_TOKENS`). Tokens are counted in the
routed model's tokenizer; the run result reports what it saved (`compression`
in `--json`) and `vg savings` counts it under the `vg-code` client. Set
`VG_CODE_COMPRESS=0` to turn it off.

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
| `--compress [url]` | Also route the assistant through the local compression listener and start it — see [vg install --compress](#vg-install---compress--vg-uninstall) |
| `--compress-scope <s>` | Where `--compress` writes: `project` (default) or `user` |
| `--login` | Copilot only: GitHub device-flow sign-in before the routing is written |
| `--learn` / `--apply` | Turn past agent sessions into guardrails in the assistant's instructions file — see [vg install --learn](#vg-install---learn) |

**`vg uninstall` flags:**

| Flag | Description |
|------|-------------|
| `<tools...>` | Assistant ids to remove (required) |
| `--purge` | Also delete the skill file |
| `--force` | Restore a routed config file even when another live session still holds it |

`vg uninstall` only removes AI-assistant wiring. To remove the CLI package from the machine, use your package manager (`npm uninstall -g @vibgrate/cli`, etc.).

---

### vg lib

`vg lib <pkg>` prints usage docs for one library. When a lockfile in the project root lists that package, the version label is that pin.

```bash
vg lib react
```

```bash
vg lib                  # List the local catalog
vg lib <name>           # Docs for one library
vg lib add <source>     # Ingest docs from a local source
vg lib publish <name>   # Upload private library docs to the hosted catalog
vg lib resolve <name>   # Resolve name → catalog id + version
vg lib refresh          # Re-ingest local sources
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
| `-C, --cwd <dir>` | `.` | Directory whose lockfiles and manifests are read |
| `--json` | — | Machine-readable JSON, including `source` and `version_mismatch` |
| `--offline` | off | Skip the hosted catalog |
| `--local` | off | On-device only; implies `--offline`, so the hosted catalog is skipped |

#### Lockfile pin

A pin is looked up when the name is a declared dependency. For npm that is `dependencies` and `devDependencies` in `package.json`. A name that exists only inside a lockfile has no pin from this command.

The label uses the first version it can read:

1. The lockfile pin, from the files in the table below.
2. The installed copy, when those files have no entry.
3. The range written in the manifest, when there is no pin and no installed copy.

`--json` reports that choice as `source`: `lockfile`, `installed`, `declared`, or `unknown`.

Readers open these filenames in the directory you run from (`-C` changes it). A lockfile that lives only in a subdirectory is left unread. For npm, the first file that contains the name wins.

| Ecosystem | File | What is read |
|-----------|------|----------------|
| npm | `package-lock.json` | v2/v3: `packages["node_modules/<name>"].version`. v1: `dependencies.<name>.version`. |
| npm | `pnpm-lock.yaml` | The importer entry's `version`. A peer suffix such as `(zod@4.0.0)` is removed. |
| npm | `yarn.lock` | The `version` line in the block whose header names the package. |
| Python | `poetry.lock`, then `uv.lock` | `version` on the `[[package]]` table with that name. Matching ignores case and treats `-`, `_`, and `.` as the same character. |
| Python | `Pipfile.lock` | `version` under `default` or `develop`, with a leading `==` removed. Same name matching as Poetry. |
| Rust | `Cargo.lock` | `version` on the `[[package]]` table. Crate names are matched case-insensitively. |
| Ruby | `Gemfile.lock` | The concrete version in the specs block (`name (1.2.3)`). |
| PHP | `composer.lock` | `version` in `packages` or `packages-dev`, with a leading `v` removed. |
| .NET | `packages.lock.json` | `resolved` under `dependencies.<framework>.<id>`. Ids are matched case-insensitively. |
| Swift | `Package.resolved` | `state.version` for a matching `identity` (v1 `object.pins`, or v2/v3 `pins`). |
| Dart | `pubspec.lock` | The `version` field on that package. |
| Java | `gradle.lockfile` | The version in a `group:artifact:version=` line. Pass the name as `group:artifact`. |

The pin lookup skips `go.sum` (Go keeps the version declared in `go.mod`), `pdm.lock`, `npm-shrinkwrap.json`, `bun.lock`, and Maven lockfiles. A Java dependency declared only in `pom.xml` uses that declared version.

The text is chosen separately from the label:

- A catalog entry from `vg lib add` is printed with the version stored on that entry.
- Otherwise, for an npm package, the command reads the installed package: `llms.txt`, then a README, then markdown under `docs/`, then the `description` in `package.json`. The label stays the lockfile pin when one exists, so the words can be the installed copy while the heading shows the pin.
- When that text is missing or too thin, and the run may use the network, the hosted catalog is asked by library name. The heading then shows the version the catalog returned. When the catalog omits a version, the heading keeps the lockfile label.

#### When a lookup fails

**Missing lockfile entry.** The lockfile is absent, or it has no row for that name. The label moves to the installed version, then to the declared range. `--json` sets `source` to `installed`, `declared`, or `unknown`.

**Lockfile and install disagree.** When both a pin and an installed version are readable and they differ, the label stays the pin. The command prints a warning that names both versions: the lockfile pins one version and the installed tree has the other. Reinstall from the lockfile, or commit the lockfile that matches what is installed. The warning is omitted when the two versions agree. `--json` puts the same pair on `version_mismatch` (`lockfile`, `installed`, `note`), or `null` when they agree. The installed copy is `node_modules/<name>/package.json` for npm, a `.dist-info` directory under `.venv`, `venv`, `env`, or `.tox` for Python, and `vendor/composer/installed.json` for PHP. Other ecosystems can show a pin without this comparison.

**Offline or `--local`.** `--local` and `--offline` both skip the hosted catalog. A catalog entry and installed npm docs still print. When neither exists, the command exits 3:

```text
no library docs for "<name>" — add with `vg lib add <path|url> --name <name>` or install the package (or retry with --online for the hosted catalog)
```

The error text mentions `--online`. Remove `--local` or `--offline` and run the command again; those two flags are what keep the hosted catalog off. The network is on unless you pass one of them.

**Network fetch fails.** A timeout, a connection error, a non-success response, or an empty body counts as no hosted answer. The message leaves out the response body and any credential. A failed attempt is not saved. A successful answer can be reused for about a day, so a later outage can still show that earlier text. When local text exists, it is printed, with a note that the local docs look thin and the hosted catalog had nothing better. When no local text exists either, the command exits 3 with the not-found message above, without the `--online` hint.

**Unreadable lockfile.** A lockfile that is present but truncated, invalid, or unreadable stops the command and exits 1. The message names the file and tells you to restore or regenerate it with your package manager. File contents stay out of the message.

---

### vg locale

**Vibgrate Localize** — managed localisation for your application. Locale projects, keys, and
translations live in Vibgrate Cloud and sync with the locale files in your repo.

`vg localize` is a backward-friendly alias; `vg locale` is the canonical form.

```bash
vg locale config --project <slug> [--target-languages fr-FR,de-DE] [--namespaces common,checkout]
vg locale push [--dry-run] [--source-only]
vg locale pull [--language <code>] [--dry-run] [--include-machine]
vg locale save-missing [--dry-run]
vg locale add <key> [value] [--namespace <ns>] [--language <code>]
vg locale remove <keys...> [--namespace <ns>]
vg locale get <key> [--namespace <ns>] [--language <code>]
vg locale status
vg locale format [--dry-run]
```

| Command | Description |
|---------|-------------|
| `vg locale config` | Create or update `vibgrate.locale.yaml` (no credentials are stored in it) |
| `vg locale push` | Upload local locale files to Vibgrate Cloud (`vg locale sync` is an alias) |
| `vg locale pull` | Write translations from Vibgrate Cloud into local files (`vg locale download` is an alias) |
| `vg locale save-missing` | Create only the keys Cloud does not have yet — never overwrites a translation |
| `vg locale add` | Add or update a single key |
| `vg locale remove` | Remove one or more keys |
| `vg locale get` | Show one key and its translations |
| `vg locale status` | Coverage and health per language |
| `vg locale format` | Re-format local locale files in place |

**Local vs Cloud.** `config` and `format` only touch the filesystem — they work on any plan and make
no network call. Everything else reads or writes Vibgrate Cloud and needs a **Team plan or above**.
`vg locale push --dry-run` also works with no credentials, so you can preview what a push would send
before you have logged in.

**Configuration** lives in `vibgrate.locale.yaml`, which is safe to commit — the DSN is never written
to it and resolves at call time from `--dsn`, `VIBGRATE_DSN`, or your stored login, exactly as
`vg push` does.

```yaml
project: acme-web
sourceLanguage: en-US
targetLanguages: [fr-FR, de-DE]
format: nested
path: src/locales/{language}/{namespace}.json
namespaces: [common, checkout]
version: latest
```

**Formats.** `json`, `nested`, `flat`, `yaml`, and `yml` are supported today; the professional
formats (`po`, `xliff`, `xliff2`, `android`, `strings`, `resx`, `csv`, `arb`, `properties`) report
that they are not available yet rather than failing as unknown. Every codec round-trips, and writes
are key-sorted so pulling twice never produces a spurious diff.

**Machine translation is never silently accepted.** `pull` writes only translations a person has
accepted; pass `--include-machine` to also write machine and needs-review entries.

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

**First-party weights.** Code Mode packs are first-party GGUF only: `vg models install` downloads the catalogued refs into the Vibgrate weight store under the cache directory (HTTPS hosts allowlisted, including Hugging Face LFS/Xet CDNs). Catalog entries carry **sha256 pins**; a download that does not match is rejected. Ollama is used only for models you select explicitly (`vg models pull <name>`, `--provider ollama`) — never for a Code Mode pack.

**Foundry Local.** On Windows (or any host running Microsoft Foundry Local), use `--provider foundry-local --model <id>` with the OpenAI-compatible server (default `http://127.0.0.1:5272/v1`, override with `FOUNDRY_LOCAL_BASE_URL`). `vg models status` lists models when the server responds.

**Warm local inference (Approach B default).** Code Mode packs (channel 2026.08.1) install first-party GGUF weights and run on embedded llama.cpp only — there is no Ollama fallback in a pack. When a GGUF is on disk (weight store or `~/models`), `vg code` prefers embedded llama.cpp automatically. Set `VG_PREFER_OLLAMA=1` to try your own Ollama models first outside Code Modes. Spark constrained decoding is **fail-closed**: if the binding cannot attach a PatchIR grammar, generation errors instead of free-text (opt-in raw string GBNF only via `VG_ALLOW_GRAMMAR_STRING_FALLBACK=1`).

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

`install` / `pull` install the **full provider dependency closure** (e.g. runtime npm deps for llama-cpp, then the pinned GGUF from the first-party weight store; `pull` fetches your named model via Ollama). Third-party apps such as Ollama itself are never auto-installed — install them separately if the plan lists them as blocked.

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
| `catalog` | Live hosted model catalog (cached; not used under `--offline`) |
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

### vg module

Manage the **optional local modules** — separately-licensed engines the CLI can load through a narrow seam. Two are supported today: `relevance` (semantic ranking kernel) and `hcs` (the [HCS](#holistic-code-specification-vg-hcs) engine behind `vg hcs`).

```bash
vg module status                  # what is installed, and whether it loads
vg module install hcs             # fetch + unpack (prompts once, unless --yes)
vg module install relevance --force
vg module remove hcs
```

Installation fetches the module from the npm registry **as a plain tarball**, verifies its integrity, and unpacks it into the Vibgrate cache. Your project is never touched, and nothing from the tarball executes at install time. State is per-user, not per-repo, and your answer to the prompt is recorded — a decline is remembered, so nothing re-prompts on every run.

| Subcommand | Description |
|------------|-------------|
| `status` | Installed modules, their versions, whether the seam can load them, and your recorded consent |
| `install <name>` | Install a module (`--yes` to skip the prompt, `--force` to reinstall) |
| `remove <name>` | Delete an installed module |

Set `VIBGRATE_NO_KERNEL=1` to disable optional modules entirely — installs are refused and commands that need an engine exit with `6` ([`ENGINE_UNAVAILABLE`](#exit-codes)) rather than silently degrading. `vg module status` reports the disabled state. Add `--json` to any subcommand for machine-readable output.

---

### vg path

Show how A connects to B — the shortest path through the code map. By default
any edge counts (calls, imports, containment, tests); `--calls` follows call
edges only, which is the path that actually runs, and prints each hop's
call-site line and whether the call is awaited.

```bash
vg path <a> <b>
vg path handler insert --calls
```

| Flag | Description |
|------|-------------|
| `<a>` | Source node |
| `<b>` | Target node |
| `--calls` | Follow call edges only; show the call-site line of each hop |
| `--pick-a <n>` | Pick the nth candidate for A |
| `--pick-b <n>` | Pick the nth candidate for B |
| `--diagram` | Draw the path as a pinned call path instead of text |
| `--format <fmt>` | With `--diagram`: `md` (default) or `json` (a `vg.review.doc.v1` document with `kind: "explain"`) |

With `--json`, `steps` lists each hop's edge kind, resolver, call-site line and
`awaited` flag. The `find_path` MCP tool returns the same as `hops`, and takes
`calls_only: true` for the call-only path.

With `--diagram`, the path becomes a document you can read or hand to an agent:

```bash
vg path placeOrder audit --calls --diagram
```

- **What it is:** each hop in order, with the line that makes it and whether the call is awaited.
- **How it works:** one call path, caller first. Each step is linked to the lines that declare it, and each hop to its call site.

Every element comes from the code map and is pinned to lines in the working tree. A step with no code in the repository (a library function) is left out of the call path and named in the notes.

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
| `--reset` | — | Delete the context-compression ledger (global, under the Vibgrate data directory) |

Add `--json` for machine-readable output.

**Context compression.** When `vg serve --compress`, `vg code` or the SDK wrappers have saved anything, the report gains a second section: requests, tokens before / after and estimated dollars for today, the last 7 days and the last 30 days, split by model, client and project, plus the size of the retrievable store. The ledger is an append-only JSONL file with numbers only — never message content — kept for 30 days. See [Context compression](#context-compression).

---

### vg serve

Start [Vibgrate AI Context](https://vibgrate.com/library) — a local-first [MCP](https://vibgrate.com/glossary/model-context-protocol) serving your code map, drift, and version-correct docs to your AI assistant (fully offline under `--offline`).

```bash
vg serve
```

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | — | Serve over streamable HTTP instead of stdio |
| `--port <n>` | `7437` | Port for `--http` |
| `--host <h>` | `127.0.0.1` | Host for `--http` |
| `--savings` | — | Record local, counts-only usage savings (opt-in) |
| `--share-stats` | — | Also upload the counts-only usage ledger to Vibgrate to improve the local MCP (opt-in; off by default; implies `--savings`; disabled under `--offline`) |
| `--dedup` | — | Collapse a node's heavy relation lists on repeat reads within a session, to save tokens (opt-in) |
| `--no-refresh` | — | Serve the map as built; skip the auto-rebuild when files change |
| `--compress`, `--compress-only`, `--background`, `--compress-port`, `--compress-mode`, `--profile`, `[agent…]` | — | Context compression in the same process — see [vg serve --compress](#vg-serve---compress) |

Via stdio (default), your AI assistant spawns the server. Via `--http`, it runs as a local HTTP endpoint for browser or shared access.

**A live status display shows what the server is doing for you.** While `vg serve` runs in a terminal, a status block on stderr updates in place: uptime, which AI clients are connected (detected from the MCP handshake), calls and average response time per tool, and — for the navigation tools with a grep/read baseline — the context tokens served vs the estimated tokens a grep-and-read agent would have burned instead, with the estimated saving labelled as such. Outside a terminal (when your assistant spawns the server) it degrades to a quiet one-line heartbeat in the server logs every 15 minutes, and only when there has been activity. The display is in-memory only and always on — nothing is written to disk or uploaded (recording and sharing below stay opt-in) — and `--quiet` turns it off.

**Usage stats — local by default, sharing is opt-in.** `--savings` records a *counts-only* ledger under `.vibgrate/` — per navigation call: which tool, how it resolved (complete/partial/miss), the vg-vs-grep token figures, whether it came over the MCP (`mcp`) or the `vg` CLI (`cli`), and a coarse client label (which AI). `vg savings` reports it locally; nothing leaves your machine. `--share-stats` additionally uploads that same counts-only ledger to Vibgrate periodically, so we can see how the local MCP is used and improve it. It **never** sends code, file paths, question text, repo identity, or any credential — only counts, outcomes, token figures, the vg version, your OS/arch, and a random per-install id. It's off unless you pass the flag, is disabled entirely under `--offline`, and the endpoint can be overridden with `VIBGRATE_STATS_ENDPOINT`.

**Attributing CLI calls.** The MCP path detects the calling client automatically from the connection handshake. For CLI calls, pass `--client=<ai>` (e.g. `vg "how does auth work" --client=claude`) so the call is attributed in `vg savings` and any shared stats — this is what `vg install` writes into each assistant's skill. Without `--client`, a bare `vg ask` records nothing.

**The map stays fresh while you (or your AI) edit code.** Each tool call runs a cheap stat-only freshness check against the last build; when files really changed, the server rebuilds the map incrementally in-process — only changed files re-parse — and answers from the updated graph. Probes are debounced with a self-tuning cadence (2s floor, scaling with measured probe cost so probing never exceeds a few percent of serve time even on very large repos), rebuilds are single-flight and cross-process locked, and touch-only changes (a `git checkout`, a re-save with identical content) are recognized by content hash and never trigger a rebuild. There is no filesystem watcher: freshness is checked exactly when it matters — at query time. (`vg daemon` is a separate optional process for multi-workspace IDE/agent sessions; `vg serve` does not require it.) The server also hot-reloads `graph.json` whenever it changes on disk, so an external `vg` build is picked up on the next call too.

The server exposes read-only tools your assistant can call over the code map and dependency data, including:

- `query_graph`, `get_node`, `find_path`, `impact_of`, `tests_for` — navigate and reason about the code map.
- `check_drift` — offline dependency inventory; pass `attribute: true` to add git "who added this / who set the version" attribution.
- `list_vulnerabilities`, `vuln_attribution` — known vulnerabilities and their exposure attribution from the last `vg scan --vulns`.
- `upgrade_impact` — what an upgrade will cost: version distance, how many files import the package, the vulnerabilities it fixes, and — with `changelog: true` — online breaking-change notes between your version and the latest.
- `resolve_library`, `library_docs` — version-correct, drift-annotated library docs.

All tools are read-only. The server is local-first: it always answers from your machine when it can, and its only network touches are the embedder's one-time model fetch, `upgrade_impact`'s `changelog`, and `library_docs`' fall-through to the hosted catalog when the local docs for a library are thin or missing. `--offline` is the hard airgap — it disables all three.

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
| `--diagram` | Explain the node with pinned diagrams instead of text (needs the Architecture module) |
| `--format <fmt>` | With `--diagram`: `md` (default) or `json` (a `vg.review.doc.v1` document with `kind: "explain"`) |

Outputs the qualified name, kind, file location, signature, importance score, area, extends relationships, callees, and callers. For functions and methods it also prints the architecture classification the Architecture module wrote at build time — role, purposes, a one-line description, and any boundary violation — when that module is loaded (`vg module install arch`; installed by default).

With `--diagram`, the same facts become a document for code as it is, not for a change:

```bash
vg show OrderService.save --diagram
vg show src/orders/service.ts:42 --diagram --pick 1 --format json
```

- **What it is:** the kind, the file, the signature, the architecture role, the area, and how many callers and callees it has.
- **How it works:** how the code is reached (the call path from its entry point), what it does (a flow of its statements, branches and error paths), the data it reads and writes when the repository declares its data models, and where it sits (system, packages, components, stores).
- **Callers and callees:** each one linked to the lines that declare it.

Every element is pinned to lines in the working tree and comes from the code map, so nothing is marked new or edited and the call path has no before side. When nothing in the code map calls the code, the flow leads instead. The document is the same `vg.review.doc.v1` that `vg review doc` writes, so the same renderers and checks apply. In VS Code, **Vibgrate: Explain This Code with Diagrams** opens it for the function under the cursor.

#### vg show flow

What a function does, step by step, as one pinned flow diagram: the explain view of `vg show <name> --diagram` with only its flows.

```bash
vg show flow UpdateProductCommandHandler.Handle
vg show flow src/orders/service.ts:42 --format json
```

Each step is a statement the code map recorded (a query, a write, a call, a branch or an error path), linked to its line. When the code map records no steps for the function, `vg show flow` says so and exits 3. It needs the Architecture module (`vg module install arch`).

Agents get the same documents over MCP: under `vg serve --review`, the `review_doc` tool's `explain` op takes `symbol` (and `to` for a call path). It saves nothing unless asked to keep it.

#### vg show scratchpad

One explain scratchpad per repository, for understanding code rather than reviewing a change. Every explanation you keep lands on top, newest first:

```bash
vg show OrderService.save --diagram --keep
vg path placeOrder audit --calls --diagram --keep
vg show scratchpad
vg show scratchpad --clear
```

- **Newest on top.** Each entry starts with a heading. Keeping the same explanation again moves it to the top instead of adding a copy. The 30 newest entries are kept.
- **Agents write here too.** The `review_doc` tool's `explain` op with `keep: true` adds an entry. Ops `get`, `patch`, `check` and `clear` with `doc_id: "scratchpad"` read it, redraw a block by id, and empty it. What an agent writes is marked as written by an agent.
- **Pinned to the working tree.** Code moves under a scratchpad, so a block whose lines no longer exist is reported, not deleted. A patch is refused only when it breaks something that was fine.
- **Local.** It is stored in `.vibgrate/review-docs/scratchpad.json`, never committed, and deleted after 365 days without an update.

In VS Code, **Vibgrate: Explain This Code with Diagrams** keeps its result on the scratchpad, and **Vibgrate: Open Explain Scratchpad** opens it. The tab updates as an agent writes to it.

#### vg show arch

Open a local, interactive architecture map of the same graph in your browser.

```bash
vg show arch                     # vg · arch  http://127.0.0.1:7420
vg show arch --focus UserService # open on one symbol
vg show arch --no-open --json    # print the URL and counts; keep serving
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `7420` | Port |
| `--host <h>` | `127.0.0.1` | Bind address (loopback by default; binding elsewhere prints a warning) |
| `--focus <name>` | — | Open the map on this symbol |
| `--no-open` | — | Print the URL without opening a browser |

The map opens on the **workspace** (one card per package), then drills into a **column slice** (UI / endpoint → application → store). Same-file functions collapse; tests stay hidden; at most 120 cards. Filters (**by job**, **by cluster**, **who calls whom**, **missing steps**, **problems**) apply inside that zoom. Overlay toggles (vulns, drift, ownership, churn) paint on that same canvas — the Health tab opens them; it is not a blank page. Missing scan, CODEOWNERS, or git history is omitted, never a healthy zero, and the map does not invent an Architecture Health Score. With the Architecture module off it is the raw graph’s kinds in the same columns — never a guess. The page is served inline from loopback with no external assets, and `q` / Ctrl-C stops it. `vg show chart` is the pre-rename spelling and still works as a silent alias for one release. The VS Code architecture board hosts the same page and payload. See [docs/show-arch.md](./docs/show-arch.md).

#### vg show savings

Print (and with `--open`, open) the URL of the local savings page served by `vg serve --compress` — see [vg savings / vg show savings](#vg-savings--vg-show-savings).

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

## Context compression

Every turn, an AI coding agent re-sends its whole conversation to the model — the test log it already read, the JSON payload it already parsed, the grep output it already acted on. Vibgrate CLI compresses that context **before** it reaches the model and keeps every original retrievable on your machine, so the model can pull back exactly the lines it needs instead of re-paying for all of them.

Compression is not a second product with its own commands. It is a mode of the
local runtime you already start (`vg serve`), a flag on the installer you
already use (`vg install`), and a section of the report you already read
(`vg savings`). Inside `vg code` it is on by default.

```bash
vg serve --compress          # serve the map *and* compress context, one process
vg install claude --compress # point Claude Code at it and start the listener (undo: `vg uninstall claude`)
vg savings                   # what it saved: today / 7 days / 30 days
```

**How a request is compressed.** The pipeline walks each message and each content block and decides per block:

1. **Exclusions first.** System prompts, user text, assistant text, blocks with `cache_control`, blocks already carrying a marker, retrieval results, error outputs, file reads (`Read`, `cat`, `head`, …) and edits are left alone by default. In `cache` mode only the newest turn (the part after the last assistant message) is eligible, so your provider's prompt cache keeps hitting; `token` mode makes every eligible block a candidate. The last `protectRecent` messages keep their code intact.
2. **Route by shape.** A detector classifies the block — `json`, `source_code`, `search_results`, `build_output`, `git_diff`, `html`, `tabular`, `structured_config`, `plain_text` — with a confidence floor per type, and hands it to the matching compressor.
3. **Lossless first.** Repeated lines, grep and directory headings, path headings, diff index lines and config boilerplate fold into byte-reversible markers that `unfold` restores exactly. Lossy compression runs on top only when it beats the fold by at least `VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS` (default 15%).
4. **Lossy, shape-aware.** JSON arrays keep a head / middle / tail sample plus every error-looking item, rare-status outliers and items matching your question, and render the dropped rows as a compact schema line. Logs collapse near-duplicates and keep errors, stack traces, first and last lines. Grep output is capped per file with matches for your question kept. Diffs keep every changed line and cap context. Source code keeps signatures, imports, exports and docstrings and collapses long bodies (verified to still parse with the bundled grammars). Prose is compressed extractively — a deterministic sentence score, no model.
5. **Guarded.** Anchors (errors, ids, hashes, URLs, test names) may never be dropped; a result that is not smaller, or that fails the recoverability check, is rejected and the original forwarded. A compressor that throws is a passthrough. A per-request deadline (`VG_COMPRESS_DEADLINE_MS`) forwards the original if compression runs long.
6. **Retrievable.** Each lossy block stores its original (secrets redacted) in a local store with a 30-minute TTL and adds a marker — `<<vg-ccr:HASH N_rows_offloaded>>` inside arrays, or a trailing `Retrieve original: hash=… (before → after tokens)` line. When a request carries markers, the proxy adds a `vg_retrieve` tool; if the model calls it, the proxy answers from the store without a client round-trip (up to 3 rounds per request) and, for streaming clients, keeps the connection alive with heartbeats while it does.

Across turns the pipeline also replaces verbatim repeats of earlier tool output with a pointer (cross-turn dedup), marks file reads that a later edit made stale (read lifecycle), holds fresh reads byte-exact for a few turns before they become eligible (maturation), and — opt-in — compacts prior-turn reasoning on models that bill it.

**Savings profiles.** `coding` (default) is cache-mode with reads and edits byte-exact; `balanced` lets older reads compress; `aggressive` is token-mode over everything eligible, for long autonomous runs; `general` is for non-coding chat. Pick one with `--profile` or `VG_COMPRESS_PROFILE`.

**Privacy.** Everything runs on your machine. The proxy binds to loopback unless you pass a token, forwards your provider credentials untouched, strips its own headers before forwarding, never logs message bodies unless you ask (`VG_PROXY_LOG_MESSAGES`), and redacts secret shapes before anything — stored originals, ledgers, logs, memory — is written to disk. Files are created `0600`. There is no beacon and no update check unless you opt in, and `DO_NOT_TRACK` / `VIBGRATE_TELEMETRY=0` win over any opt-in.

---

### vg serve --compress

`vg serve` is the local runtime: it serves your code map to an AI over MCP.
`--compress` adds a second listener to the *same process* — an Anthropic- and
OpenAI-compatible endpoint that shrinks context on its way to the model. One
runtime, two listeners; there is no separate server to start, supervise or stop.

It speaks the Anthropic Messages API (`/v1/messages`), OpenAI Chat Completions
(`/v1/chat/completions`) and Responses (`/v1/responses`), streaming and
non-streaming, and passes `count_tokens`, `embeddings` and `models` through
untouched.

```bash
vg serve --compress                          # MCP on stdio + compression on 127.0.0.1:8787
vg serve --http --compress                   # MCP over HTTP as well
vg serve --compress --profile aggressive     # compress harder
vg serve --compress-only                     # compression only, no code map needed
vg serve --compress --background             # start (or reuse) the listener as a background process, then return
vg serve --compress claude --model claude-sonnet-5   # one session, environment only
```

| Flag | Default | Description |
|------|---------|-------------|
| `--compress` | off | Turn on context compression: the listener, plus the compression MCP tools |
| `--compress-port <n>` | `8787` | Port for the compression listener (independent of `--port`, which is MCP's) |
| `--compress-only` | off | Compression **without** a code map: none is built, none is required, and only the tools that answer without one are listed |
| `--compress-mode <m>` | `cache` | `cache` (newest turn only, prompt-cache safe) or `token` (maximum removal) |
| `--profile <p>` | `coding` | `coding` / `balanced` / `aggressive` / `general` |
| `--background` | off | Start the compression listener as a background process — or reuse the healthy one already on the port — and return. No code map, no MCP; stop it with `vg serve stop`. This is what `vg install <agent> --compress` runs for you |
| `[-- <agent> …]` | — | Run one agent session through the listener (started for you if it is not running), then restore the environment |

Everything else is a setting rather than a flag. There are around 130 `VG_*`
knobs — upstream URLs, spend caps, rate limits, tokens for off-loopback
binding, output shaping, logging — and putting each on the command line would
turn `--help` into a manual. Read them with `vg serve config` and change one
with `vg serve config set KEY VALUE`; hot knobs take effect on the next request.

**Why `--compress` gates the MCP tools too.** Every tool schema an MCP server
advertises is re-sent on every agent step, so a capability listed "just in case"
is a standing tax on people who never use it. `compress_content`,
`retrieve_original` and `compression_stats` are therefore listed only when you
asked for compression. They remain callable either way.

**Sharing a listener.** If a healthy listener is already on the port, a second
`vg serve --compress` attaches to it instead of failing — several assistants
each spawning their own `vg serve` is the normal case, not an error.

Subcommands: `vg serve status [--compress-port <n>] [--json]` (what is
listening, which agents are routed, Copilot sign-in state), `vg serve stop
[--compress-port <n>]`, `vg serve config [--json]` with `set <KEY> <VALUE>` /
`unset <KEY>`.

Local endpoints: `/` (the savings page, see `vg show savings`), `/health`,
`/ready`, `/version`, `/api/stats`, `/api/savings`, `/api/proxy/clients`,
`/metrics` (Prometheus text) — these answer on the listener's own bind and,
when a token is set, require it off-loopback. The admin endpoints
`/api/settings` (GET / POST), `/api/ccr/<hash>`, `/api/proxy/shutdown`,
`/api/cache/clear` and `/api/stats/reset` answer loopback callers only and
return `404` to anyone else. Sidecar endpoints for your own code: `POST
/v1/compress` (a `{ messages, … }` request body in → the same body compressed,
plus accounting) and `POST /v1/retrieve`. Gemini-native calls
(`/v1beta/models/…:generateContent`, `:streamGenerateContent?alt=sse`) pass
through with their query string intact — forwarded, not yet compressed.

Every response carries `x-vg-tokens-before`, `x-vg-tokens-after`,
`x-vg-tokens-saved`, `x-vg-usd-saved` and `x-vg-transforms` headers so a client
can see what happened to its request.

---

### vg install --compress / vg uninstall

`vg install` is the one verb that writes an AI assistant's configuration, so
routing an assistant through compression is a flag on it — not a separate verb
that edits the same files a second way. `vg uninstall` is the one revert.

```bash
vg install claude --compress             # write Claude Code's base URL, repo-local, and start the listener
vg install codex --compress --compress-scope user   # write the home config instead
vg install copilot-cli --compress --login           # device-flow sign-in, then route
vg serve status                          # what is routed right now, and by whom
vg uninstall cursor                      # put its config back, byte-for-byte
```

One command is a working setup. After writing the routing, `--compress` makes
sure the listener it points at is running: it starts `vg serve --compress
--background` (or reuses the healthy listener already on the port) and prints
the URL. For Claude Code it also adds a `SessionStart` hook to the same
`.claude/settings.json` that runs `vg serve --compress --background --quiet`,
so the routing keeps working after a reboot — each new session restarts the
listener if it is gone. The hook needs `vg` on your `PATH` (`npm i -g
@vibgrate/cli`); with `npx` it is skipped and said so. `vg uninstall claude`
removes the hook with the routing. Pointing at a listener vg does not manage —
an explicit `--compress <url>` or `VG_PROXY_URL` — starts nothing.

**Supported agents:** `claude`, `codex`, `cursor`, `aider`, `copilot-cli`,
`opencode`, `cline`, `continue`, `goose`, `openhands`, `gemini`, `qwen`,
`kimi`, `grok`, `crush`, `amp`, `factory` (Droid), `kiro`, `vibe`, `zcode`,
`vscode` (Claude Code in VS Code). Agents that read a config file (Codex
`config.toml`, Claude Code / Droid `settings.json`, OpenCode and Crush JSON,
Continue and Goose YAML) get an atomic edit with a `.vg-backup` beside it, a
marker recording exactly which fields changed, and an owner file so two
concurrent sessions never undo each other. Agents that only read an
environment variable (Cursor, Aider, Cline, OpenHands, Kimi, Grok, Qwen Code,
Gemini CLI, Amp, Kiro, Mistral Vibe, ZCode) have no file to write durably —
run them with `vg serve --compress <agent>`; the install reports that
rather than silently skipping.

| Flag | Description |
|------|-------------|
| `--compress [url]` | Route this assistant; the URL defaults to `VG_PROXY_URL`, else the host/port knobs |
| `--compress-scope <s>` | `project` (repo-local, the team-shareable default) or `user` (home config) |
| `--login` | Copilot only: GitHub device-flow sign-in before writing. The token is stored `0600` at `VG_COPILOT_AUTH_FILE` and never printed |
| `--force` (on `uninstall`) | Restore a file another live session still holds |

**One session instead of durable config.** `vg serve --compress <agent>`
runs a single agent through the listener using the environment only: nothing is
written, and everything is restored when the child exits. The child inherits
your terminal, gets `VG_WRAP_ACTIVE=1`, receives forwarded `SIGTERM` /
`SIGHUP`, and its exit code becomes vg's.

---

### vg savings / vg show savings

`vg savings` reports tokens and dollars saved — a compression section alongside
the grep-baseline numbers for map queries. `vg show savings` opens the same
numbers as a live local page, next to `vg show arch` for the code graph.

```bash
vg savings                       # today / 7 days / 30 days, by model, client, project
vg savings --compression         # just the compression section
vg savings --benchmark           # measure the compressors on built-in fixtures
vg show savings --open           # the live page in your browser
```

`--benchmark` runs the pipeline over one fixture per content type and reports
p50 / p95 latency and the kept ratio. Nothing is sent anywhere; this is how to
check that a change to the compressors did not regress before you rely on it.
`--iterations <n>`, `--fixture <name>` and `--model <id>` tune the run.

The page is served inline by the compression listener — no external assets —
and shows savings for today / 7 days / 30 days, the split by model, client and
project, recent requests with their transforms, the output-verbosity estimate
with its confidence interval, the retrievable store, and an editor for the
hot-reloadable settings.

---

### vg install --learn

Turn your past agent sessions into guardrails the assistant reads next time.
The outcome is "agent instructions written", which is `vg install`'s job, so it
is a mode of the installer rather than a verb of its own.

```bash
vg install claude --learn                    # preview: the block it would write, as a diff
vg install claude --learn --apply            # write it
vg install codex --learn --since 14d --learn-target AGENTS.md --apply
```

It scans the session logs of Claude Code, Codex, Gemini CLI, Grok, OpenCode,
Cursor, Copilot and Aider for this project — narrowed to the assistants you
named — detects loops (the same failing command run again and again, edit /
undo cycles, retry storms), repeated errors and missing-context patterns, and
renders a short block between `<!-- vg:learn:begin -->` and
`<!-- vg:learn:end -->` markers. Re-running replaces the block and leaves the
rest of the file untouched. The analyzer is deterministic and needs no model;
set `VG_LEARN_CLI` to hand the digest to a local CLI of your choice instead.

| Flag | Default | Description |
|------|---------|-------------|
| `--learn` | — | Preview the guardrails; nothing is written |
| `--apply` | — | Write the block (and save the learned output-verbosity profile) |
| `--since <window>` | `7d` | How far back to scan |
| `--min-evidence <n>` | `2` | Occurrences before a non-loop pattern becomes a rule |
| `--learn-target <file>` | the assistant's own | `CLAUDE.local.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `GROK.md`, or any path |
| `--all-projects` | — | Scan sessions from every project, not just this repo |

---

### vg serve memory

Project-scoped memory shared across your AI agents: facts, preferences, rules,
decisions, gotchas, commands and snippets, with an evidence count so a rule is
promoted only after it has been seen enough times (`VG_MEMORY_MIN_EVIDENCE`,
default 3). It nests under `vg serve` because serve is what injects it — the
code graph remains vg's memory of the *code*; this is the small store of things
a session learned that the map cannot know.

```bash
vg serve memory add "Run tests with pnpm test, never npm" --kind rule --tags testing
vg serve memory search "how do we run tests"
vg serve memory list --scope project
vg serve memory export > memories.jsonl
vg serve memory import memories.jsonl
```

Scopes are `project` (keyed by the git top-level, never injected when there is
no repository), `user` and `global`. Storage is a JSONL file per scope under
Vibgrate's data directory (`0600`), searched with a lexical ranker — no model,
works offline. `vg serve --memory` injects the top `VG_MEMORY_TOP_K` matches
into each request and exposes `memory_search` / `memory_save` to the model.
Text is redacted for secret shapes before it is stored.

---

### vg serve compress / vg serve retrieve

The debug paths. In normal use nobody runs these: the listener already
compressed the tool output, and a model that needs an original calls
`retrieve_original` (or the `vg_retrieve` tool the listener injects). They are
here for when you want to see exactly what the pipeline does to a payload.

```bash
cat test-output.log | vg serve compress --tool Bash
vg serve compress transcript.json --model claude-sonnet-4-5 --mode token
vg serve compress big-array.json --dry-run --stats --json

vg serve retrieve 3f9a1c2b7e4d                  # whole original
vg serve retrieve 3f9a1c2b7e4d --grep "Error"   # matching lines only
vg serve retrieve 3f9a1c2b7e4d --lines 120-180
vg serve retrieve 3f9a1c2b7e4d --json-path "[3].status"
vg serve retrieve --list                        # what is retrievable right now
vg serve retrieve --purge                       # drop expired entries
```

`vg serve compress` detects its input automatically: a JSON array of chat
messages (OpenAI or Anthropic shape) or a request body with `messages` goes
through the message pipeline and comes back in the same shape; anything else is
treated as one tool output and routed by content type. Compressed content goes
to stdout, accounting to stderr; `--json` returns both in one object. Its other
flags — `--format`, `--profile`, `--mode`, `--lossless`, `--no-ccr`, `--query`,
`--tool`, `--target-ratio`, `--dry-run`, `--stats` — mirror the pipeline's own
options.

`vg serve retrieve` accepts a bare hash, a whole `<<vg-ccr:…>>` marker, or a
`hash=…` fragment. Entries expire after `VG_CCR_TTL_SECONDS` (default 1800); an
expired hash exits `3`. `--max-tokens` caps the slice; `--head` / `--tail` take
the first / last N lines. Add `--json` for `{ content, found, truncated, … }`.

---

### Configuration reference (`VG_*`)

Every setting is an environment variable; `vg serve config` prints them all with their current value and source, and `vg serve config set KEY VALUE` persists one in `settings.json` (applied only when the variable is not already set in the environment). Precedence: flag → environment → `settings.json` → profile default. Knobs marked *hot* take effect on the next request without a restart.

| Variable | Default | What it does |
|---|---|---|
| `VG_COMPRESS` | `true` | Master switch (off = passthrough) *hot* |
| `VG_COMPRESS_MODE` | `cache` | `cache` or `token` *hot* |
| `VG_COMPRESS_PROFILE` | `coding` | Savings profile *hot* |
| `VG_COMPRESS_MIN_TOKENS` | `500` | Per-message floor before anything is attempted *hot* |
| `VG_COMPRESS_PROTECT_RECENT` | `3` | Keep code intact in the last N messages *hot* |
| `VG_COMPRESS_PROTECT_READS` | `true` | File reads stay byte-exact *hot* |
| `VG_COMPRESS_PROTECT_TOOL_RESULTS` | — | Tool names never lossy-compressed *hot* |
| `VG_COMPRESS_EXCLUDE_TOOLS` | — | Tool names skipped entirely *hot* |
| `VG_COMPRESS_LOSSLESS` | `false` | Folds only *hot* |
| `VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS` | `0.15` | How much lossy must beat lossless by *hot* |
| `VG_COMPRESS_DEDUPE` | `true` | Cross-turn dedup *hot* |
| `VG_COMPRESS_READ_LIFECYCLE` | `true` | Mark reads a later edit made stale *hot* |
| `VG_COMPRESS_THINKING_COMPACT` | `false` | Compact prior-turn reasoning where it is billed *hot* |
| `VG_COMPRESS_TOOL_PROFILES` | — | JSON map: tool → `{skipCompression, losslessOnly, maxItemsAfterCrush, bias, preserveKeywords}` *hot* |
| `VG_COMPRESS_DEADLINE_MS` | `2000` | Per-request budget; over it, the original is forwarded *hot* |
| `VG_CODE_COMPRESS` | `true` | Compress bulky tool results inside the `vg code` loop *hot* |
| `VG_CODE_COMPRESS_MIN_CHARS` | `4000` | Size a `vg code` tool result must reach before it is compressed *hot* |
| `VG_CODE_RETRIEVE_MAX_TOKENS` | `4000` | Cap on one `vg_retrieve` answer inside `vg code`; narrow with `grep` / `lines` / `head` / `tail` *hot* |
| `VG_MODEL_LIMITS` / `VG_MODEL_ALIAS_MAP` / `VG_MODEL_PRICES` | — | Context-window, alias and pricing overrides (also `models.json` in the data dir) *hot* |
| `VG_CCR` | `true` | Keep originals retrievable *hot* |
| `VG_CCR_TTL_SECONDS` | `1800` | How long an original stays retrievable |
| `VG_CCR_MAX_ENTRIES` | `1000` | Store size (LRU) |
| `VG_CCR_BACKEND` | `disk` | `disk` (shared across processes) or `memory` |
| `VG_PROXY_HOST` / `VG_PROXY_PORT` / `VG_PROXY_TOKEN` | `127.0.0.1` / `8787` / — | Bind and auth |
| `VG_PROXY_ANTHROPIC_API_URL` / `VG_PROXY_OPENAI_API_URL` | provider defaults | Upstreams |
| `VG_PROXY_ALLOWED_BASE_URLS` | — | Allow-list of upstream base URLs |
| `VG_PROXY_RPM` / `VG_PROXY_TPM` / `VG_PROXY_BUDGET` | `0` | Limits (0 = off) *hot* |
| `VG_PROXY_MODEL_ROUTES` | — | `requested=served,…` model rewrites *hot* |
| `VG_PROXY_TOOL_SEARCH` | `true` | Defer large tool lists behind a search tool *hot* |
| `VG_PROXY_SYSTEM_COMPACT` | `true` | Compact boilerplate in long system prompts *hot* |
| `VG_PROXY_LOG_FILE` / `VG_PROXY_LOG_MESSAGES` | — / `false` | Request log; bodies only when asked *hot* |
| `VG_PROXY_METRICS` | `true` | Expose `/metrics` |
| `VG_OUTPUT_SHAPER` | `false` | Verbosity steering + effort clamp *hot* |
| `VG_OUTPUT_VERBOSITY_LEVEL` | `L2` | `L1` (lightest) … `L4` *hot* |
| `VG_OUTPUT_HOLDOUT` | `0.1` | Fraction of turns left unsteered to measure the saving *hot* |
| `VG_MEMORY` / `VG_MEMORY_TOP_K` / `VG_MEMORY_MIN_EVIDENCE` | `false` / `5` / `3` | Memory injection *hot* |
| `VG_LEARN_TARGET` / `VG_LEARN_CLI` | `CLAUDE.local.md` / — | `vg install --learn` defaults |
| `VG_WRAP_PROXY_TIMEOUT` / `VG_WRAP_QUIET` | `15` / `false` | One-session run behaviour |
| `VG_CONTEXT_DIR` | data dir `/context` | Where all of this state lives |

The full list — about 130 variables including the per-subsystem tuning knobs — is what `vg serve config` prints.

---

### SDK

The same pipeline is available programmatically from `@vibgrate/cli`, offline, with no proxy running.

```typescript
import { compress, withCompression, compressionMiddleware, CompressionStore } from '@vibgrate/cli';

// One call over a message array (OpenAI or Anthropic shape; same shape back).
const result = await compress(messages, { model: 'claude-sonnet-5', mode: 'token' });
console.log(result.tokensBefore, result.tokensAfter, result.transformsApplied);

// Wrap an SDK client: compresses on the way in, answers vg_retrieve calls itself.
const anthropic = withCompression(new Anthropic(), { profile: 'coding' });
const openai = withCompression(new OpenAI());

// Vercel AI SDK middleware shape.
const model = wrapLanguageModel({ model: baseModel, middleware: compressionMiddleware() });
```

Also exported: `CompressionSession` (per-conversation state: frozen verdicts, dedup, read lifecycle), `SharedContext` (compressed hand-offs between agents), `ContentRouter` and the individual compressors, `detectContentType`, `tokenizerFor`, `modelInfo`, `priceFor`, `costUsd`, the savings ledger (`appendSavingsEvent`, `rollupSavings`) and `MemoryStore`.

---

## Holistic Code Specification (vg hcs)

`vg hcs` turns source into a stream of **deterministic code facts** — one NDJSON line per fact — and then renders, maps, gates, and validates that stream. Same code in, same facts out, on every machine: the whole pipeline is reproducible, so a fact stream is something you can commit, diff, and gate CI on.

Extraction currently covers **Rust, Ruby, PHP, Dart, Swift, Scala, C++, COBOL, and VB6** — including the legacy stacks that rarely have any machine-readable specification at all. The engine reports its own supported set, and `--language` accepts anything in it; an unsupported value lists the valid ones.

**The engine is an optional module.** All HCS computation (fact parsing, decoding, scoring, diffing, rendering) runs inside `@vibgrate/hcs-engine`, a separately-licensed WASM sandbox that makes **no network calls and spawns no processes**. The CLI side is plumbing only — read input, call the engine, write output — so every host gets byte-identical results. The module is auto-provisioned on first use (one-line notice), or install it up front with [`vg module install hcs`](#vg-module).

When the engine is missing and cannot be fetched, every `vg hcs` subcommand exits **`6` (`ENGINE_UNAVAILABLE`)** — deliberately distinct from `2` (`GATE_FAILED`), so CI can never read "engine missing" as a gate verdict.

**Typical path:** `vg hcs extract` → `vg hcs digest` (read it) / `vg hcs map` (see the system) / `vg hcs gate` (guard CI).

```bash
vg hcs extract -o facts.ndjson              # facts for the current tree
vg hcs digest --in facts.ndjson --format md # a readable specification
vg hcs map --facts facts.ndjson --format mermaid
vg hcs gate --baseline main.ndjson --facts facts.ndjson
```

### vg hcs extract

Extract facts from source into an NDJSON stream. Test files are excluded by default; the walk skips vendored, build, and dependency directories, and files above 2 MiB.

```bash
vg hcs extract [dir] -o facts.ndjson
vg hcs extract src --language rust --include-tests
```

**Incremental by default.** When the output stream already exists, extraction is incremental: the engine plans from the previous stream's file-hash index, the CLI re-extracts only added and changed files, and the engine merges — reusing unchanged facts byte-for-byte. So a repeated `-o` run costs only the delta, with output identical to a full extraction. Point `--previous` at a different stream to keep the state file separate from the output, or pass `--full` to re-extract everything from scratch (the merged result still refreshes the index, so the next run stays incremental).

| Flag | Default | Description |
|------|---------|-------------|
| `[dir]` | `.` | Directory to extract from |
| `--language <lang>` | all supported | Extract only this language |
| `--include-tests` | — | Include test files (excluded by default) |
| `-o, --out <file>` | stdout | Write the NDJSON stream to a file |
| `--previous <file>` | the `--out` file | Previous stream to update incrementally (missing file ⇒ full extraction) |
| `--full` | — | Ignore the previous stream and re-extract every file |

### vg hcs digest

Render a fact stream as a human-readable specification.

```bash
vg hcs extract | vg hcs digest --format md -o SPEC.md
vg hcs digest --in facts.ndjson --format html --level full --title "Payments service"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--in <file>` | stdin | NDJSON fact stream to read |
| `-o, --out <file>` | stdout | Write output to a file |
| `--format <format>` | `md` | `md`, `json`, or `html` |
| `--level <level>` | `concise` | `concise` or `full` |
| `--title <title>` | — | Override the document title |

### vg hcs map

Build the **System Map** from a fact stream — the components, their relations, and the structure they imply.

```bash
vg hcs map --facts facts.ndjson --format mermaid
vg hcs map --facts facts.ndjson --profile migration -o map.json
```

| Flag | Default | Description |
|------|---------|-------------|
| `--facts <file>` | stdin | NDJSON fact stream to read |
| `-o, --out <file>` | stdout | Write output to a file |
| `--format <format>` | `json` | `json`, `md`, or `mermaid` |
| `--profile <profile>` | — | Consumer projection: `integration`, `migration`, or `governance` |

Pass the global `--generated-at <iso>` to pin the artifact timestamp for byte-deterministic output.

### vg hcs gate

The **governance gate**: diff two fact streams and fail on material structural regressions. This is the CI-facing command.

```bash
vg hcs gate --baseline main.ndjson --facts pr.ndjson --format sarif -o hcs.sarif
vg hcs gate --baseline main.ndjson --facts pr.ndjson --policy .vibgrate/hcs-gate.json
```

| Flag | Default | Description |
|------|---------|-------------|
| `--baseline <file>` | *required* | Baseline NDJSON facts (the "before" stream) |
| `--facts <file>` | stdin | Current NDJSON facts (the "after" stream) |
| `--policy <file>` | — | Gate policy JSON — thresholds and disabled rules |
| `-o, --out <file>` | stdout | Write the result to a file |
| `--format <format>` | `text` | `text`, `json`, or `sarif` |

Exit codes: `0` when the gate passes, **`2`** on a material structural regression, `6` when the engine is unavailable.

### vg hcs validate

Validate a fact stream against the HCS spec. Exits with the spec's Appendix-I conformance code, so a malformed stream is caught before anything downstream consumes it.

```bash
vg hcs validate facts.ndjson
vg hcs validate facts.ndjson --json
```

Add `--json` for the full machine-readable report (every error with its code and fact id).

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

One read-only diagnostic pass over setup: which config file won, which credential source won (secrets never printed), whether a code map exists and how fresh it is, hosted catalog reachability, what `vg install` would register as the MCP launch, telemetry opt-outs, **local inference** (Code Mode recommendation from free RAM/VRAM, weight catalog pin status, warm host pool size, isolation / sampler env), and **context compression** (is a proxy running and on which port, the active profile and mode, retrievable-store size and expiry, memory scopes, which agents are currently wrapped, and any `VG_*` value that fails validation). Prints state; changes nothing.

```bash
vg doctor
vg doctor --json
vg doctor --local
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON on stdout |
| `--offline` | Skip the hosted reachability probe |
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
| `--offline` | Never touch the network (air-gapped editor sessions) |

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

`vg baseline [path]` is one command. There is no `create` or `update` subcommand. `[path]` is the directory to scan (default `.`). The command runs a full scan and writes the scan artifact to `<path>/.vibgrate/baseline.json`, replacing the file when it already exists. Run that same command again after planned upgrades land on the main branch. That second run is the refresh.

The file is a full scan artifact: scores, findings, and VCS metadata (commit, branch, and remote URL). Userinfo and credential query parameters are stripped from the remote URL before it is stored. `timestamp` and `durationMs` change on every run, so a refresh rewrites the file even when the score is unchanged. See [JSON Artifact](#json-artifact).

Other files under `.vibgrate/`:

- `.vibgrate/scan_result.json`: latest scan artifact
- `.vibgrate/baseline.json`: the snapshot `vg baseline` wrote
- `<project>/.vibgrate/project_score.json`: per-project score snapshots

### Record and refresh

1. On the main branch, record the snapshot:
   ```bash
   vg baseline
   ```
2. In CI, compare the pull request with that file and apply the gates:
   ```bash
   vg scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error
   ```
3. When planned upgrades land on the main branch, run `vg baseline` again and commit the new file.

### CI gates

A failed gate exits `2` (`GATE_FAILED`). See [Exit Codes](#exit-codes).

| Gate | Exit `2` | Stays successful for this gate |
| --- | --- | --- |
| `--drift-budget <score>` | The measured DriftScore is above the budget. A score equal to the budget passes | An unmeasured score (`null`) is not compared. The message is `DriftScore is absent; --drift-budget <score> was not compared.` |
| `--drift-worsening <percent>` | Worsening versus the baseline is above the percent. A measured score with no numeric `delta` also fails | Worsening equal to the percent, or `delta` ≤ 0. An unmeasured score is not compared. The message is `DriftScore is absent; --drift-worsening was not compared.` |
| `--fail-on error` | Any finding at level `error`, including one the baseline already recorded | Warnings and notes |
| `--fail-on warn` | Any finding at level `warning` or `error`, including one the baseline already recorded | Notes |

An unmeasured DriftScore is `null`, not `0`. It skips both `--drift-budget` and `--drift-worsening`, and those two flags then leave the process exit code unchanged. `--fail-on` still applies to findings.

`delta` is set only when `--baseline` names a readable file, this scan's DriftScore is a number, and the baseline DriftScore is a number. With `--drift-worsening` set, a measured score and no `delta` exits `2`: `Failing fitness function: --drift-worsening requires --baseline to compare against previous drift.` That covers a missing `--baseline` flag, a missing or unreadable file, and a baseline whose score was not measured.

With `--drift-budget` or `--drift-worsening` on the command line, the scan judges those flags. `driftBudget` in the project config is applied only when neither flag is set. A config `maxWorseningPercent` with no baseline is reported as not evaluated, and it does not fail the scan.

JUnit `gates` cases follow the same rules. A breach is `<failure>`. An unmeasured score is `<skipped>`. `--drift-worsening` with a measured score and no baseline delta is `<failure>`. A config worsening limit with no baseline, and a warn-mode or shadow breach, are `<skipped>`. See [JUnit](#junit).

### Suppressions

With `--baseline`, a finding that already appears in the snapshot — the same rule at the same location — stays in `findings`. The scan adds `baselineComparison` on the same document:

- `compared` is `true` when the baseline file was read
- `suppressed` is sorted by rule, then location, then id
- each `id` is the first 32 hexadecimal characters of the SHA-256 of that rule and location

The text report prints the count (`1 finding suppressed by baseline`, or `N findings suppressed by baseline`), including when the count is zero. SARIF keeps the result and adds a suppression (`kind: external`, `status: accepted`, justification `Matches the drift baseline`) that cites the same id.

Baselined findings still count toward `--fail-on`. The exit path reads `findings` and does not skip ids listed in `baselineComparison`. An error that the baseline already recorded still fails `--fail-on error` with exit `2`. The suppression is the audit record in JSON, text, and SARIF.

A row that exists only in the baseline is omitted. Nothing in the current scan was suppressed for it.

### What to commit

Commit `.vibgrate/baseline.json` on the main branch after you have read it, or produce that file as a CI artifact from the main branch and restore it in the gate job. The [example](#ci-example) checks the committed file out with the repository.

Leave tokens, a DSN, and `~/.vibgrate/credentials.json` out of the repository. `vg baseline` has no `--dsn` flag. A `VIBGRATE_DSN` value in the environment is still read, and the workspace id is folded into project and solution ids. The DSN string itself is not written into the file. Unset `VIBGRATE_DSN` before you record a snapshot you will commit, and review the file: it holds findings and VCS metadata. `.vibgrate/scan_result.json` is the latest run, not the accepted snapshot.

### CI example

One job. Checkout brings the committed `.vibgrate/baseline.json`. The scan writes `vibgrate.sarif` before a failing gate exits, and the last step stores that file as a workflow artifact. The job sets no DSN and does not send the file to code scanning.

```yaml
name: Drift baseline

on:
  pull_request:

permissions:
  contents: read

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Drift gate
        run: npx @vibgrate/cli scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error --format sarif --out vibgrate.sarif

      - name: Save SARIF artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vibgrate-sarif
          path: vibgrate.sarif
```

Exit `2` fails the Drift gate step. Leave `continue-on-error` unset on that step. `if: always()` keeps `vibgrate.sarif` when the gate fails. Pin the CLI calendar version on a gate you keep; see `examples/github-actions/README.md`.

## DriftScore

### How the Score Is Calculated

The DriftScore is a deterministic, versioned metric (0–100) that represents how far behind your codebase is relative to the current stable ecosystem baseline.

**Lower score = healthier upgrade posture.** 0 means no drift (fully current); 100 means maximum drift. Higher is worse. A component that was not measured is `null` in JSON and `n/a` in text, not 0. When nothing was measured, the overall score is null as well, and `--drift-budget` does not compare it.

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

Dependency identity in this file is `projects[].type` plus `dependencies[].package` and `resolvedVersion`. An advisory match is `extended.vulnerabilities.packages[]` (`ecosystem`, `package`, `version`). `vg sbom export` writes those coordinates as a package URL. The file has no CPE field. See [Component identity](#component-identity). A dependency row has no package digest. `projects[].projectId` and `solutions[].solutionId` identify the project and the solution. See [Package digests](#package-digests).

### SARIF

[Static Analysis Results Interchange Format](https://sarifweb.azurewebsites.net/) (SARIF) 2.1.0. GitHub code scanning and Azure DevOps read this file. It contains findings only. The DriftScore and the other metrics stay in the JSON artifact. Drift findings come first. Vulnerability findings follow when the scan ran with `--vulns`.

Every result includes `partialFingerprints`. Code scanning uses that object to recognize the same finding on a later run, so an unchanged finding stays one alert. The scan time, the result order, and the artifact timestamp are not part of the value. The message text is left as the scanner wrote it.

```bash
vg scan --vulns --format sarif --out vibgrate.sarif
```

#### Result fingerprints

The key on every result is `vg/finding-id/v1`. The value is a content id: 32 lowercase hex characters. What goes into it depends on the result.

| Result | What the value is made from |
| ------ | --------------------------- |
| Drift finding identified by its rule and location (runtime end-of-life, runtime lag, dependency rot) | The rule id and the location. This is the same id `vg scan --baseline` stores when that finding is suppressed. A change to the message, such as a newer latest version, does not change the value. |
| Known vulnerability (`vibgrate/vulnerability`) | The rule id, the location, the ecosystem, the package name, and the advisory id. A package URL is included when the finding has one. Two advisories on one package get two values. The installed version, CVSS score, aliases, and message are not included. |
| Dependency or framework major lag | The rule id, the location, and the package or framework name. The name is the text before ` is <number> major versions behind`. A later count, or a newer latest version, does not change the value. If the message does not have that shape, the whole message is used. |
| License that could not be resolved | The rule id, the location, the declared license text, and the message. The message names the package, so two packages in one manifest stay distinct. |
| Finding suppressed by `--baseline` | The baseline id for that rule and location. The key is unchanged. That id does not include an advisory id, so every suppressed result with that rule and location shares it. |
| Infrastructure finding (`vg scan --iac`) | The finding id. Moving the block without changing the address does not change the value. |

The same finding contents produce the same value. A different finding produces a different value.

#### Advisories with several ids

One advisory often has its own id plus aliases: a GHSA, a CVE, and sometimes another OSV id. SARIF writes **one result per package and advisory**. Every alias stays on that result. A second result appears only when the scan kept a second advisory id. Two advisories stay two results when one lists the other as an alias.

A near-duplicate code-scanning alert is expected in that case. If the vulnerability data returns `GHSA-bbbb` and `CVE-2024-1111` as two advisories for the same package, the file contains two results, and each names the other in `aliases`. Match them on `properties.advisoryId`. A CVE string inside the message is an alias of the primary id.

| Field | What it holds |
| ----- | ------------- |
| `ruleId` | `vibgrate/vulnerability` on every vulnerability result. The rule is listed once, in the order that id first appears among the findings (after any drift rules). |
| `level` | `error` for critical and high, `warning` for moderate, `note` for low and unknown. |
| `message.text` | Starts with `package@version:` and the advisory id. When an alias starts with `CVE-` and that alias is not already the advisory id, the first such alias is added in parentheses. Further CVE aliases stay in `properties.aliases`. |
| `locations[0].physicalLocation.artifactLocation.uri` | The package name. |
| `partialFingerprints["vg/finding-id/v1"]` | Content id for this result. See [Result fingerprints](#result-fingerprints). |
| `properties.advisoryId` | The advisory's own id. This is the primary id. |
| `properties.aliases` | The alias list, in the order the advisory supplied. Distinct advisory ids stay distinct results. |
| `properties` | The finding details, copied as-is: ecosystem, package, installed version, severity, CVSS, and fixing versions, plus introduction details when the scan attributed the advisory. |

The same advisory set always produces the same result order. Packages are ordered by ecosystem, package name, then version. Advisories on one package are ordered by severity from critical down to unknown, then by advisory id. SARIF emits results in that order: drift findings, then those vulnerability results.

The ids in this example show the field shape. A real scan fills them from the advisory it read. The fingerprint is the content id for the rule, the location, the ecosystem, the package, and `GHSA-bbbb` shown here. A critical `GHSA-bbbb` whose aliases are `CVE-2024-1111` and `OSV-1`, fixed in 4.17.21, is one result:

```json
{
  "ruleId": "vibgrate/vulnerability",
  "level": "error",
  "message": {
    "text": "lodash@4.17.20: GHSA-bbbb (CVE-2024-1111) (critical 9.1) — fix available (4.17.21)"
  },
  "locations": [
    {
      "physicalLocation": {
        "artifactLocation": { "uri": "lodash" }
      }
    }
  ],
  "partialFingerprints": {
    "vg/finding-id/v1": "82efba63199c173114225d3195aa15aa"
  },
  "properties": {
    "ecosystem": "npm",
    "package": "lodash",
    "installedVersion": "4.17.20",
    "advisoryId": "GHSA-bbbb",
    "aliases": ["CVE-2024-1111", "OSV-1"],
    "severity": "critical",
    "cvss": 9.1,
    "fixedVersions": ["4.17.21"]
  }
}
```

The same package can also carry `CVE-2024-1111` as its own advisory, with alias `GHSA-bbbb`. That is a second result. Its `properties.advisoryId` is `CVE-2024-1111`, its message names that CVE on its own (the id is already the advisory id), and `properties.aliases` is `["GHSA-bbbb"]`.

#### Severity and `level`

Each vulnerability result's `level` follows the advisory severity, which the result also carries in `properties.severity`:

| `properties.severity` | `level` |
| --------------------- | ------- |
| `critical` | `error` |
| `high` | `error` |
| `moderate` | `warning` |
| `low` | `note` |
| `unknown` | `note` |

`unknown` means the advisory data gave no usable severity, for example no severity label and no CVSS score. It gets `note`, the same as `low`, so an unscored advisory never outranks a scored one. Read `properties.severity` to tell the two apart. The `vibgrate/vulnerability` rule carries no `security-severity` property, so GitHub code scanning shows these alerts as Error, Warning, or Note from `level`.

Test reporters that ingest JUnit can take a companion file from the same scan. See [JUnit](#junit). The process exit code is unchanged either way; see [Exit Codes](#exit-codes).

### Markdown

A clean Markdown report suitable for PRs, wikis, or documentation.

### JUnit

`--junit <file>` writes a JUnit XML report next to whatever `--format` you selected (`text`, `json`, `sarif`, or `md`). GitLab (`artifacts:reports:junit`), Azure DevOps, and Jenkins can publish it without a second scan. The file is local: rule ids, locations, messages, and gate results only — no DSN, repository URL, or scan clock.

The same findings and gates always produce the same bytes. Case order is fixed, `time` is `0`, and the optional JUnit `timestamp` attribute is omitted.

| Suite | When | Test cases |
| ----- | ---- | ---------- |
| `findings` | Always | One case per drift finding. `classname` is `vg.findings`. `name` is `{ruleId} {location}` (` #2`, ` #3`, … on ties). No findings → one passing case, `no findings`. |
| `architecture` | `--fail-on architecture-finding` or `architecture-warning` | One failure per boundary row (`classname` `vg.architecture`), a passing `architecture` case when the gate is clean, or one failure when the gate could not run. |
| `security` | `--fail-on iac-finding` or `security-finding` | One case per security finding when the packs ran (`classname` `vg.security`). Findings below the severity are `<skipped>`. A passing `security` case when there are none. One failure when the gate could not run. |
| `gates` | A drift budget was judged | `drift-budget` / `drift-worsening` for the flags, or `drift-budget maxScore` and `drift-budget maxWorseningPercent` for [`driftBudget`](#drift-budget) in project config. |

A finding is a `<failure>` only when its level fails the drift gate you set. Anything else is `<skipped>` (present, not gating):

| Finding | `--fail-on error` | `--fail-on warn` | no `warn` / `error` gate |
| ------- | ----------------- | ---------------- | ------------------------ |
| `error` | failure | failure | skipped (`drift gate not set`) |
| `warning` | skipped | failure | skipped |
| `note` | skipped | skipped | skipped |

Budget cases follow the same exit rules as the CLI. A `--drift-budget` breach, or an enforced `driftBudget` breach, is a `<failure>`. An unmeasured score is `<skipped>` and does not fail `--drift-budget` or `--drift-worsening`. `--drift-worsening` with a measured score and no baseline delta is a `<failure>`, and the process exits `2`. A config `maxWorseningPercent` with no baseline, and a warn-mode or shadow breach, are `<skipped>` and do not fail the scan. Flag and config rules: [Drift Baselines & Fitness Functions](#drift-baselines--fitness-functions). Every requested gate is included, including gates after the one that stopped the process. The confirmation line goes to stderr, so `--format json` on stdout stays intact. See [Exit Codes](#exit-codes): the XML is written, then the process exits `2` when a gate fails. SARIF stays the code-scanning artifact; see [SARIF](#sarif).

```bash
vg scan --format sarif --out vibgrate.sarif --junit vibgrate.junit.xml --fail-on error --drift-budget 40
```

```yaml
# GitLab CI — SARIF for SAST, JUnit for the test report
vibgrate:
  script:
    - npx @vibgrate/cli scan --format sarif --out vibgrate.sarif --junit vibgrate.junit.xml --fail-on error
  artifacts:
    when: always
    reports:
      junit: vibgrate.junit.xml
      sast: vibgrate.sarif
```

GitHub Actions: [`examples/github-actions/driftscore-junit.yml`](./examples/github-actions/driftscore-junit.yml) uploads the SARIF to code scanning and publishes the JUnit file as a check run and job summary from the same scan. Both publish steps use `if: always()`, so they still run when the gate exits `2`.

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

Also supports `vibgrate.config.js`, `vibgrate.config.json`, and
`.vibgrate/config.yml` (or `.config.yaml`). A project has one config file:
Vibgrate reads the first it finds in the order `.vibgrate/config.yml`,
`.vibgrate/config.yaml`, `vibgrate.config.ts`, `vibgrate.config.js`,
`vibgrate.config.json`, and never merges two. YAML and JSON take exactly the
same settings; `vg doctor` names any config file that is present but ignored.

### Drift budget

`driftBudget` sets limits on DriftScore that `vg scan` and the Vibgrate GitHub
App check enforce:

```yaml
# .vibgrate/config.yml
driftBudget:
  mode: warn              # warn (default) | enforce | shadow
  maxScore: 40            # DriftScore ceiling, 0-100
  maxWorseningPercent: 5  # how much one change may worsen drift
  maxRiskScore: 50        # RiskScore ceiling, 0-100 (Team plan and above)
  maxRiskWorseningPercent: 0
  agents:
    maxWorseningPercent: 0  # stricter limit for bot and coding-agent pull requests
```

- `warn` prints a breach and exits `0`; `enforce` exits `2`; `shadow` reports only.
- `maxWorseningPercent` compares against `--baseline`; without one it is reported
  as not evaluated, never as a failure.
- `maxRiskScore` and `maxRiskWorseningPercent` limit RiskScore, which is a
  separate metric from DriftScore. A local `vg scan` does not compute it, so
  those limits are reported as not evaluated and do not fail the scan. The
  GitHub App computes RiskScore for the pull request on a Team plan or above
  and applies the limits there. On any other plan the check says the limit
  was not applied because RiskScore needs a Team plan or above.
- `agents.maxWorseningPercent` is checked by the GitHub App, which knows who
  opened the pull request.
- `--drift-budget` / `--drift-worsening` still work; passing either uses the flags
  and ignores `driftBudget`.
- A misspelt key, a wrong type, or a `driftBudget` that sets no limit stops the
  command. The error names the file and, when the file makes it clear, the line
  and the key. The value is not printed.

The GitHub App reads `driftBudget` and `review` from the pull request's base
branch, so a change cannot loosen the limits it is checked against. It reads
`.vibgrate/config.yml` or `vibgrate.config.json` only; it never runs a `.ts`/`.js`
config.

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
| `VG_MAX_FILES`        | `100000`                    | Walk-entry ceiling for `vg scan` and `vg build`. Exceeding it stops the walk with guidance (narrow the path, add `--exclude`, or raise this value; `0` disables the budget only). Pointing either command at the filesystem root or an operating-system image stops before the walk, with the same guidance to narrow the path. |
| `VG_TSC_MAX_FILES`    | `10000`                     | Max TS/JS files handed to the in-process TypeScript resolver (the largest single memory consumer). Above it, the heuristic rung is used. |
| `VG_MEMORY_BUDGET_MB` | 90% of the Node heap ceiling | Heap budget checked at phase boundaries. Exceeding it stops the build with a clear, catchable error before V8 hard-crashes.             |
| `VG_JOBS`             | CPU cores − 1               | Default parse worker count when `--jobs` isn't passed. Fewer workers = lower peak memory (each worker loads its own grammar set).       |
| `VG_WORKER_HEAP_MB`   | platform default            | Per-worker old-generation heap cap, so one runaway parse can't take the whole machine.                                                  |

Skips are deterministic functions of the input (file size, file count) — never
of observed memory — so identical input still produces an identical
`graph.json`. To give the build more room instead of limiting it, raise the
Node heap: `NODE_OPTIONS=--max-old-space-size=8192`.

### Symlinks

`vg build` and `vg scan` do not follow symlinks. While walking, a directory
symlink is not entered and a file symlink is not read. That includes a link
that points at its own parent, so a cycle cannot make the walk hang. The link
is left out of the map and out of the scan. Output files do not change, and
the exit code stays the same.

The directory you pass as the root is opened even when that path itself is a
symlink. Links found underneath it are not followed. To include the files a
link points at, point the root at that target, or pass a narrower directory
that already contains them. To leave a link out without a notice, list it in
`.gitignore` or pass `--exclude`.

When a walk skips one or more symlinks, vg prints one notice on stderr and
nothing when there are none. The notice is the count, then the first few
root-relative paths in sorted order (at most five; further links are a
`+N more` count). Paths are relative to the root you passed. Absolute paths
are not printed. The line goes to stderr, so `--format json` and
`vg build --json` keep a JSON document on stdout. `--quiet` hides promotional
text only; it does not hide this notice.

```text
notice: skipped 3 symlinks (alias.ts, nested/cycle, via). vg does not follow symlinks. Point the root at the link target, or pass --exclude or a narrower root.
```

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

- A standards-based SBOM file (`spdx` or `cyclonedx`) is written for downstream governance tooling. How the two formats differ: [Choosing CycloneDX or SPDX](#choosing-cyclonedx-or-spdx).

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

- `examples/github-actions/README.md` (drift gate: when the job fails, warn versus enforce, pins, DriftScore badge)
- `examples/github-actions/driftscore-ci.yml` (JSON artifact + drift gate)
- `examples/github-actions/driftscore-sarif.yml` (SARIF upload to code scanning)
- `examples/github-actions/driftscore-junit.yml` (SARIF upload plus a JUnit test report from one scan)
- `examples/github-actions/vulnerabilities-sarif.yml` (vulnerability gate + SARIF upload)
- `docs/ci/github-actions.md` (integration notes). How `vg build` records a `uses:` pin: [Action pins in the code map](./docs/ci/github-actions.md#action-pins-in-the-code-map)

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

## Troubleshooting: registry, auth, and network

Match the message to the failure, then run the next command. Three cases cover almost every registry, sign-in, and upload failure:

| What failed | What you see | Next command |
| --- | --- | --- |
| No network, or `registry.npmjs.org` refused the check | `Vibgrate cannot connect to the npm registry to check package versions.` | `npm view npm dist-tags.latest`, then either fix registry access or `vg scan --offline --package-manifest <file>` |
| Upload has no DSN, a bad DSN, or the server rejected it | `No DSN provided for push.` / `Invalid DSN format.` / `Upload failed: HTTP 401` or `403` | `vg login`, or set `VIBGRATE_DSN` |
| You asked for no network | no registry banner; drift for packages outside the manifest is `unknown` | `vg scan --offline --package-manifest <file>` |

Examples use placeholders (`<token>`, `<key_id>`, `<secret>`, `<file>`, `<host>`, `<path>`). They are not real values.

A DSN, an npm token, an `Authorization` header, and a URL that contains a username and password are credentials. They must not appear in `vg` output or in CI logs. `vg` removes those shapes from registry and upload errors before it prints them. If a log already contains one, rotate it. In CI, set `VIBGRATE_DSN` in the secret store. `--dsn` puts the value in the process list. `vg dsn create` prints the new DSN once so you can store it. That line is the secret. Do not run `vg dsn create` in a job whose log is kept.

Runtime errors are prefixed with `error:` and a line `(ref <id>)`. The id is a correlation id for that process, not a credential.

### Offline scan

`vg scan --offline` does not call a package registry, does not call OSV, and does not upload, even when a DSN is set. The npm registry banner in the next section is not printed.

Without `--package-manifest`, latest versions are not looked up. Dependency drift for those packages is `unknown`. A missing latest version is not a score of zero.

```bash
vg scan --offline --package-manifest <file>
```

`<file>` is JSON, or a ZIP that contains `package-versions.json`, `manifest.json`, or `index.json`. One published bundle is `https://github.com/vibgrate/manifests/latest-packages.zip`.

A bad manifest stops the command (exit code 1) before the scan. The message names the path and what to pass:

| Situation | Message |
| --- | --- |
| Missing path | `Package manifest not found: <path>. Pass a readable JSON or ZIP package-version manifest to --package-manifest.` |
| Not readable | `Package manifest is not readable: <path>. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.` |
| A directory | `Package manifest is not a file: <path>. Pass a JSON or ZIP package-version manifest to --package-manifest.` |
| Not a manifest | `Package manifest is not usable: <path>. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.` |
| ZIP has none of those files | `Package manifest is not usable: <path>. The ZIP must contain package-versions.json, manifest.json, or index.json.` |
| ZIP and `unzip` is missing | `Package manifest is not readable: <path>. Reading a ZIP manifest needs the unzip command. Pass a JSON package-version manifest to --package-manifest, or install unzip.` |

### npm registry check

An online `vg scan` checks `https://registry.npmjs.org/npm/latest` before it scores.

- A network failure (no response: DNS, timeout, connection refused) falls back to `npm view npm dist-tags.latest`, which uses your `.npmrc`.
- An HTTP response that is not OK, including 401 and 403, fails the check immediately. That path does not fall back to `npm view`, and it does not send your npm token.

Either failure stops the scan (exit code 1):

```text
error:
  ✖ Vibgrate cannot connect to the npm registry to check package versions.

    Possible causes:
    • No internet connection
    • Corporate proxy/firewall blocking registry.npmjs.org
    • npm is not installed or not in PATH

    Try running: npm view npm dist-tags.latest

  (ref <id>) — re-run with --json for detail, or report at https://vibgrate.com/help
```

Next step:

1. Run `npm view npm dist-tags.latest`.
2. If that command cannot resolve a host or times out, you are offline or blocked. Download a package-version manifest and run `vg scan --offline --package-manifest <file>`.
3. If npm says it is not authorized (HTTP 401 or 403), the registry answered and your npm config is wrong. Fix the registry in `.npmrc`, or sign in with your package manager.
4. If `npm view` succeeds and `vg` still prints the banner, `registry.npmjs.org` returned a non-OK status, so the npm fallback did not run. Allow that host, or use the offline manifest.

PyPI, NuGet, Maven Central, RubyGems, crates.io, the Go module proxy, Packagist, pub.dev, Hex, Docker Hub, Artifact Hub, and the Terraform Registry do not print this banner. A failed lookup leaves that package's drift as `unknown`.

`npm view` stderr is not printed. If it contains a token, an authorization header, or a URL with a password, that text is removed before it is kept on the error.

`vg update` uses a separate check against the npm registry. When that check returns nothing, it prints this and exits 1:

```text
Could not reach the npm registry. Check your network connection.
```

The next step is the same as the scan banner: confirm `npm view npm dist-tags.latest`, then re-run `vg update`.

### Vulnerability feed

`vg scan --vulns` queries OSV. When a batch cannot be completed, the vulnerability step says:

```text
OSV unreachable — not checked
```

That line means the feed was not reached. It does not mean the tree has no vulnerabilities. The command still exits 0 unless another gate fails.

`vg scan --vulns --offline` does not contact OSV. Advisories come from `--package-manifest`. When that file has no matching advisories, the step says `none found`.

### Upload authentication

`vg scan` uploads when you pass `--push`, or when a DSN is already available, unless you passed `--offline`. DSN resolution order:

1. `--dsn <dsn>`
2. `VIBGRATE_DSN`
3. The `VIBGRATE_CREDENTIALS` file, if set; otherwise `<project>/.vibgrate/credentials.json` when that file exists; otherwise `~/.vibgrate/credentials.json`

No DSN, from `vg scan --push` (and from a scan that expected to upload):

```text
No DSN provided for push.
Run "vibgrate login", set VIBGRATE_DSN, or use the --dsn flag.
No account yet? Claim this run: https://dash.vibgrate.com/claim?vid=<id>&job=scan_drift&channel=cli
```

`vg push` prints `No DSN provided.` and the same two hint lines. The claim URL identifies this install. It is not a DSN.

Next step: `vg login`, or set `VIBGRATE_DSN`. With `--strict`, the command exits 1. Without `--strict`, the local result is kept and nothing is uploaded.

Invalid DSN:

```text
Invalid DSN format.
```

`vg push` also prints:

```text
Expected: vibgrate+https://<key_id>:<secret>@<host>/<workspace_id>
```

`vg scan --push` does not print the expected format. Next step: `vg login`, or replace `VIBGRATE_DSN`. Do not print the old value.

When the upload request fails:

```text
Upload failed: HTTP <status>: <body>
```

A network error uses the same `Upload failed:` prefix and the client error text. Tokens, authorization headers, and credential-bearing URLs are removed from `<body>` and from that client text. HTTP 401 or 403 means the DSN was rejected. Next step: `vg login`, or check `VIBGRATE_DSN` (key, secret, host, and workspace). With `--strict`, exit code is 1. Without it, the local scan result remains.

Before an upload, scan calls preflight. A transport or HTTP failure prints:

```text
Preflight check failed: <message>
```

`<message>` is `HTTP <status>: <body>` or the client error, with the same redaction. Without `--strict`, the scan continues. With `--strict`, the command exits 1 before the scan.

A plan limit is a separate warning. It names the limit (repository cap, scan credits, or VM minutes), says results will not be uploaded, and the local scan still runs.

`vg login` network failures:

```text
Failed to start login (HTTP <status>).
Could not reach <host>: <message>
```

`<host>` is the ingest host (`us.ingest.vibgrate.com` or `eu.ingest.vibgrate.com`, or the host of `--ingest`). Next step: check the network, then retry `vg login`. `--region` selects `us` or `eu`. An unknown region prints `Unknown region "<id>". Supported: us, eu`. A region that is not live yet prints `Region "<id>" (<label>) is not yet available. Supported: us, eu`. A bad `--ingest` value prints `Invalid ingest URL: <input>` with credentials removed from `<input>`.

Browser outcomes:

```text
✖ Login was denied in the browser.
✖ Login request expired. Run "vibgrate login" again.
✖ Timed out waiting for approval. Run "vibgrate login" again.
```

Next step: `vg login`.

Signed in, workspace not created:

```text
✖ Signed in, but workspace setup failed: Failed to provision workspace: <error>
  Finish setup with "vibgrate dsn create --workspace new".
```

`vg dsn create --workspace new` prints `Failed to provision DSN: <error>` when the provision call fails. `<error>` is the server text or `HTTP <status>`, with credentials removed. Next step: confirm the ingest host, then retry.

### Build and module install

`vg build` fetches the Architecture module when it is missing, unless you passed `--offline` or `--local`. When the registry cannot provide it, and the output is not `--json` or `--quiet`, build prints:

```text
  architecture module could not be installed — role/purpose lines are omitted; vg retries automatically (disable with VIBGRATE_NO_KERNEL=1)
```

The build still finishes. Role and purpose lines are omitted. `--offline` skips the fetch and does not print this line.

`vg module install <name>` (names: `relevance`, `hcs`, `arch`):

```text
install failed: <detail> — check network access to the registry, or retry later
```

Exit code 1. `<detail>` is one of `registry <status>` (for example `registry 401` or `registry 403`), `tarball <status>`, `no published version`, or an integrity message (`integrity mismatch (sha512)`, `integrity mismatch (shasum)`, `malformed integrity metadata`, `registry provided no integrity metadata`). HTTP 401 or 403 means the registry refused the request. A thrown fetch error is `<detail>` as well, cut at 200 characters, with credentials removed.

`vg update`, after the CLI itself is current, prints a module line when a refresh fails:

```text
  <package> module could not be updated — registry unreachable or no published version
```

`registry <status>` or `tarball <status>` appears in that same position when the registry answered. The CLI update itself still succeeds. Next step: restore registry access, then `vg update` or `vg module install <name>`.

`vg install --login` with `--offline` or `--local` exits 5:

```text
--login needs the network; it cannot run under --local/--offline
```

Next step: run `vg install` without `--login` while you are offline, or drop `--offline` / `--local` when you want the device login.

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

## `--offline` vs `--local`

Two different questions, so two flags:

| Flag | Question it answers | Effect |
| --- | --- | --- |
| `--offline` | May this reach the network? | No model download, no catalog fetch, no upload. Available on every command. |
| `--local` | Where does inference run? | On-device backends only, never a hosted model. Consumed by [`vg code`](#vg-code). |

**`--local` implies `--offline`**, so anything that already passes `--local`
keeps its exact behaviour. The converse does not hold, and deliberately so:
forcing on-device inference is a choice you may want on a fully connected
machine — for privacy, cost, or latency — and `--offline` would not say it.

`vg scan --offline` and `vg evidence --offline` mean the same thing they always
have.

---

## Exit Codes

CI and agents branch on these, so they are a stable contract.

| Code | Name                  | Meaning                                                                                  |
| ---- | --------------------- | ---------------------------------------------------------------------------------------- |
| `0`  | `OK`                  | Success                                                                                    |
| `1`  | `ERROR`               | Runtime error                                                                              |
| `2`  | `GATE_FAILED`         | A gate failed: `--fail-on` threshold exceeded, a drift budget breached, `vg hcs gate` regression, `vg bisect --assert` unsatisfied, or `vg build --verify` rejected the attestation |
| `3`  | `NOT_FOUND`           | The thing asked for does not exist (unknown symbol, no version history, an attestation path you named, …) |
| `4`  | `NON_DETERMINISTIC`   | A verification found output that is not reproducible, including the `vg build --verify` self-check |
| `5`  | `USAGE_ERROR`         | Bad invocation: unknown command, invalid flag value, missing argument, a signing key that is missing or not Ed25519, or a retired name such as `vg attest` |
| `6`  | `ENGINE_UNAVAILABLE`  | A required optional module is not installed and could not be fetched (see [`vg module`](#vg-module)) |

`vg scan --junit` writes that file before it exits, including when the code is `2`. See [JUnit](#junit).

`6` is deliberately distinct from `2`: a CI gate must never read "engine missing" as a gate verdict.
The same rule is why [`vg review`](#vg-review) exits `6` when there is no code map, and why `--explain`
exits `6` rather than quietly producing a review no model contributed to.

---

## Warning codes

A warning means the command continued. The process exit code stays the one in [Exit Codes](#exit-codes). Each published code keeps its meaning. A later release may add a code. It does not rename or reuse a code that has shipped. A code never contains a path, a secret, or file contents. When several warnings fire, JSON lists them by code, then by message.

Stderr lines look like `warning [VG_WARN_PARSE_FAILED]: …`. The code is the token a CI check or an assistant asserts on. The sentence after the code can be reworded.

`vg build --json` keeps `warnings` as strings and adds `codedWarnings`: an array of `{ code, message }` in that same order. Each string in `warnings` ends with ` [CODE]`. `codedWarnings` is left out when there are no warnings.

`vg scan --format json` adds `degradations` when a path was skipped or a baseline file could not be read. The field is left out when there are none. `vg report` prints those same rows.

`vg sbom export` prints the code on stderr. CycloneDX adds a `vibgrate:warningCode` property next to the existing warning property. SPDX adds an annotation whose comment is `warningCode=VG_WARN_…`. The warning sentences already stored on the document stay as they are.

License findings keep the rule id `vibgrate/license-parse-failed` and also carry `warnCode`. CVSS findings keep `cvss-vector-parse-failed` and also carry `warnCode`.

A truncated or invalid lockfile stops the command. Warning codes cover conditions that let the command continue.

| Code | Command | Meaning |
| --- | --- | --- |
| `VG_WARN_PARSE_FAILED` | `vg build` | A source file failed to parse. The map continues without its symbols. |
| `VG_WARN_BUILD_FILE_OVERSIZE` | `vg build` | A file exceeded the per-file size cap and was left out of the map. |
| `VG_WARN_TSC_RESOLVER_SKIPPED` | `vg build` | The TypeScript resolver was skipped because the corpus exceeded its file cap. |
| `VG_WARN_YAML_PARSE_FAILED` | `vg build` | YAML for an infrastructure file failed to parse. |
| `VG_WARN_YAML_DOCUMENT_SKIPPED` | `vg build` | A YAML document in a stream had errors and was skipped. |
| `VG_WARN_YAML_DOCUMENT_UNMATERIALISED` | `vg build` | A YAML document could not be materialised. |
| `VG_WARN_TOOLCHAIN_EXTRACTION_FAILED` | `vg build` | An infrastructure extractor failed. That file contributes no structure. |
| `VG_WARN_TOOLCHAIN_NODE_CAP` | `vg build` | An extractor stopped at the per-file node cap. |
| `VG_WARN_HCL_GRAMMAR_UNAVAILABLE` | `vg build` | The HCL grammar was unavailable, so no Terraform structure was extracted. |
| `VG_WARN_HCL_NO_TREE` | `vg build` | HCL parse produced no tree. |
| `VG_WARN_HCL_PARTIAL` | `vg build` | HCL parse recovered from a syntax error. Extraction may be partial. |
| `VG_WARN_WORKFLOW_STEP_CAP` | `vg build` | A workflow job listed more steps than the extractor enumerates. |
| `VG_WARN_SCAN_PATH_SKIPPED` | `vg scan` | A scan path timed out and was skipped. |
| `VG_WARN_SCAN_FILE_OVERSIZE` | `vg scan` | A scan file exceeded the size cap and was skipped. |
| `VG_WARN_BASELINE_UNREADABLE` | `vg scan` | A baseline file could not be read. The scan continues without a comparison. |
| `VG_WARN_LICENSE_UNPARSEABLE` | `vg scan`, `vg sbom` | A declared license string could not be resolved to SPDX. |
| `VG_WARN_LICENSE_UNREPRESENTABLE` | `vg sbom` | A declared license cannot be represented in an SBOM. |
| `VG_WARN_CVSS_UNPARSEABLE` | `vg scan` | A CVSS vector was present and could not be parsed. |
| `VG_WARN_PURL_UNAVAILABLE` | `vg sbom` | A package URL could not be formed. The component is included without a purl. |
| `VG_WARN_SBOM_LOSSY_EDGES` | `vg sbom` | Merge dropped a different dependency list for one package. |
| `VG_WARN_SBOM_LOSSY_MANIFEST` | `vg sbom` | Merge dropped differing manifest metadata for one package. |
| `VG_WARN_SBOM_UNKNOWN_ECOSYSTEM` | `vg sbom` | Merge recorded an unknown ecosystem as npm. |
| `VG_WARN_SBOM_UNTRACKED_EDGES` | `vg sbom` | A lockfile format does not record dependency edges. |

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
