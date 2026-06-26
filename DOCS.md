# Vibgrate CLI — Full Documentation

> Continuous Drift Intelligence for Node, .NET, Python, and Java (all supported in the CLI today)

For a quick overview, see the [README](./README.md). This document covers everything in detail.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Choosing a rollout model: one-off vs CI](#choosing-a-rollout-model-one-off-vs-ci)
- [Commands Reference](#commands-reference)
  - [vibgrate init](#vibgrate-init)
  - [vibgrate scan](#vibgrate-scan)
  - [vibgrate baseline](#vibgrate-baseline)
  - [vibgrate report](#vibgrate-report)
  - [vibgrate sbom](#vibgrate-sbom)
  - [vibgrate push](#vibgrate-push)
  - [vibgrate dsn create](#vibgrate-dsn-create)
  - [vibgrate update](#vibgrate-update)
- [Upgrade Drift Score](#upgrade-drift-score)
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
  - [Architecture Layers](#architecture-layers)
  - [Code Quality Metrics](#code-quality-metrics)
  - [OWASP Category Mapping](#owasp-category-mapping)
- [CI Integration](#ci-integration)
  - [GitHub Actions](#github-actions)
  - [Azure DevOps](#azure-devops)
  - [GitLab CI](#gitlab-ci)
  - [Generic Pipelines](#generic-pipelines)
- [Dashboard Upload](#dashboard-upload)
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
4. **Generates** a deterministic Upgrade Drift Score (0–100)
5. **Produces** findings, a full JSON artifact, and optional SARIF output

Core drift analysis does not execute source code. Optional security scanners can run lightweight secret heuristics and local toolchain checks. Dashboard upload remains optional.

---

## Choosing a rollout model: one-off vs CI

Most teams adopt Vibgrate in two steps:

1. **One-off scan** to establish a baseline and identify immediate upgrade priorities.
2. **CI integration** to continuously detect drift regression on every pull request/build.

| Mode               | Benefits                                                                    | Typical command                                           |
| ------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| One-off scan       | Fast snapshot of current upgrade debt, useful for audits and planning       | `npx @vibgrate/cli scan .`                                |
| CI-integrated scan | Continuous governance with automated failure thresholds and SARIF surfacing | `npx @vibgrate/cli scan . --format sarif --fail-on error` |

In practice, one-off scans tell you where you are today; CI keeps you from drifting back tomorrow.

---

## Feature coverage and practical usage guide

This section summarizes what the CLI supports today and how to use each capability effectively.

### Supported project ecosystems

Vibgrate currently discovers and evaluates projects in:

- **Node.js / TypeScript** (`package.json`, lockfiles)
- **.NET** (`.sln`, `.csproj`)
- **Python** (`requirements.txt`, `pyproject.toml`-style manifests)
- **Java** (`pom.xml`, Gradle-style manifests)

### End-to-end workflow (recommended)

1. Run an initial scan.
2. Save a baseline on your main branch.
3. Enforce drift gates in CI.
4. Export/report artifacts for stakeholders.

Example:

```bash
# Step 1: first scan
vibgrate scan .

# Step 2: baseline
vibgrate baseline .

# Step 3: policy in CI
vibgrate scan . --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error

# Step 4: produce report
vibgrate report --in .vibgrate/scan_result.json --format md
```

Expected results:

- Teams get a stable score trend instead of one-time snapshots.
- CI fails early when drift budgets are exceeded (exit code `2`).
- Markdown/JSON/SARIF outputs are ready for engineering and governance workflows.

## Commands Reference

### vibgrate init

Initialise Vibgrate in a project.

```bash
vibgrate init [path] [--baseline] [--yes]
```

| Flag         | Description                                 |
| ------------ | ------------------------------------------- |
| `--baseline` | Create an initial drift baseline after init |
| `--yes`      | Skip confirmation prompts                   |

Creates:

- `.vibgrate/` directory
- `vibgrate.config.ts` with sensible defaults

---

### vibgrate scan

The primary command. Scans your project for upgrade drift.

```bash
vibgrate scan [path] [--format text|json|sarif|md] [--out <file>] [--fail-on warn|error] [--offline] [--package-manifest <file>] [--no-local-artifacts] [--max-privacy] [--baseline <file>] [--drift-budget <score>] [--drift-worsening <percent>] [--changed-only] [--concurrency <n>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format` | `text` | Output format: `text`, `json`, `sarif`, or `md` |
| `--out <file>` | — | Write output to a file |
| `--fail-on <level>` | — | Exit with code 2 if findings at this level exist |
| `--baseline <file>` | — | Compare against a previous baseline |
| `--changed-only` | — | Only scan changed files |
| `--concurrency <n>` | `8` | Max concurrent npm registry calls |
| `--drift-budget <score>` | — | Fitness gate: fail if drift score is above this budget |
| `--drift-worsening <percent>` | — | Fitness gate: fail if drift worsens by more than % vs baseline |
| `--push` | — | Upload scan artifact to dashboard after a successful scan |
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
vibgrate scan .

# JSON output for automation
vibgrate scan . --format json --out scan.json

# CI gate with baseline regression protection
vibgrate scan . --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5 --fail-on error

# Upload result in the same command
vibgrate scan . --push --strict
```

Expected results:

- Clear score/risk output in terminal (or JSON/SARIF when selected).
- Exit code `2` when configured quality gates are exceeded.
- When `--push` is enabled, artifact upload is attempted after scan completion.

---

### vibgrate baseline

Create a drift baseline snapshot for delta comparison.

```bash
vibgrate baseline [path]
```

Runs a full scan and saves the result to `.vibgrate/baseline.json`. Use this as the starting point for tracking drift over time.

---

### vibgrate report

Generate a human-readable report from a scan artifact.

```bash
vibgrate report [--in <file>] [--format md|text|json]
```

| Flag       | Default                      | Description                            |
| ---------- | ---------------------------- | -------------------------------------- |
| `--in`     | `.vibgrate/scan_result.json` | Input artifact file                    |
| `--format` | `text`                       | Output format: `md`, `text`, or `json` |

---

### vibgrate sbom

Export SBOMs from an existing scan artifact or compare two artifacts.

```bash
vibgrate sbom export [--in <file>] [--format cyclonedx|spdx] [--out <file>]
vibgrate sbom delta --from <file> --to <file> [--out <file>]
vibgrate sbom vex [--from <file>] [--statement <json>...] [--product <ref>] [--out <file>]
```

| Command | Description |
|---------|-------------|
| `vibgrate sbom export` | Emit CycloneDX or SPDX JSON from a scan artifact |
| `vibgrate sbom delta` | Compare dependencies between two artifacts (added/removed/changed + drift delta) |
| `vibgrate sbom vex` | Emit a spec-compliant OpenVEX document (exploitability statements) for attestation |

Use this to treat SBOMs as operational intelligence instead of static compliance output.

`vibgrate sbom vex` is input-agnostic: it assembles a complete OpenVEX document from the statements you supply (`--from <file>` and/or repeatable `--statement`), so it works regardless of which scanner flagged the components. A zero-statement document is valid and honest — it asserts no known affected components.

---

### vibgrate push

Upload scan results to the Vibgrate dashboard API.

```bash
vibgrate push [--dsn <dsn>] [--file <file>] [--region <region>] [--strict]
```

| Flag       | Default                      | Description                                 |
| ---------- | ---------------------------- | ------------------------------------------- |
| `--dsn`    | `VIBGRATE_DSN` env           | DSN token for authentication                |
| `--file`   | `.vibgrate/scan_result.json` | Scan artifact to upload                     |
| `--region` | —                            | Override data residency region (`us`, `eu`) |
| `--strict` | —                            | Fail hard on upload errors                  |

Upload is always optional. Best-effort by default — use `--strict` in CI if you want the pipeline to fail on upload errors.

---

### vibgrate dsn create

Generate an HMAC-signed DSN token for API authentication.

```bash
vibgrate dsn create --workspace <id|new> [--region <region>] [--ingest <url>] [--write <path>]
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

### vibgrate update

Check for and install updates.

```bash
vibgrate update [--check] [--pm <manager>]
```

| Flag      | Description                                            |
| --------- | ------------------------------------------------------ |
| `--check` | Only check for updates, don't install                  |
| `--pm`    | Force a package manager (`npm`, `pnpm`, `yarn`, `bun`) |

---

## Drift Baselines & Fitness Functions

Vibgrate stores scan state under `.vibgrate/`:

- `.vibgrate/scan_result.json`: latest scan artifact
- `.vibgrate/baseline.json`: explicit baseline snapshot (`vibgrate baseline`)
- `<project>/.vibgrate/project_score.json`: per-project score snapshots

Recommended workflow:

1. Create baseline once on main branch:
   ```bash
   vibgrate baseline .
   ```
2. In CI, run scan with comparison and gates:
   ```bash
   vibgrate scan --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5
   ```
3. When planned upgrades land, refresh baseline:
   ```bash
   vibgrate baseline .
   ```

This makes drift a formal quality gate (fitness function), not just reporting.

## Upgrade Drift Score

### How the Score Is Calculated

The Upgrade Drift Score is a deterministic, versioned metric (0–100) that represents how far behind your codebase is relative to the current stable ecosystem baseline.

**Lower score = healthier upgrade posture.** 0 means no drift (fully current); 100 means maximum drift. Higher is worse.

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

Run `vibgrate init` to generate the config file, or create one manually:

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

---

## Extended Scanners

Beyond the core drift score, Vibgrate runs a suite of extended scanners that collect high-value migration intelligence. All scanners:

- Are **read-only** — they never write files or execute project code
- Run **in parallel** — failures in one scanner never affect the others
- Can be **individually toggled** in the config
- Collect **zero sensitive data** — no source code, no secrets, no PII

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

Vibgrate supports both direct SBOM export (`vibgrate sbom export`) and raw inventory consumption from `scan_result.json`, so teams can choose either built-in output or custom SBOM pipelines.

Example:

```bash
vibgrate sbom export --in .vibgrate/scan_result.json --format spdx --out sbom.spdx.json
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
- `docs/ci/github-actions.md` (integration notes)

```yaml
steps:
  - name: Vibgrate Scan
    run: npx @vibgrate/cli scan . --format sarif --out vibgrate.sarif --fail-on error

  - name: Upload SARIF
    uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: vibgrate.sarif

  # Optional: push metrics to dashboard
  - name: Push Vibgrate Metrics
    env:
      VIBGRATE_DSN: ${{ secrets.VIBGRATE_DSN }}
    run: npx @vibgrate/cli push --file .vibgrate/scan_result.json
```

### Azure DevOps

```yaml
steps:
  - script: npx @vibgrate/cli scan . --format sarif --out vibgrate.sarif --fail-on error
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
    - npx @vibgrate/cli scan . --format sarif --out vibgrate.sarif --fail-on error
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

## Dashboard Upload

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

- **Node.js** >= 20.0.0
- Works on macOS, Linux, and Windows

---

## Links

- [Website](https://vibgrate.com)
- [npm](https://www.npmjs.com/package/@vibgrate/cli)

---

Copyright © 2026 Vibgrate. All rights reserved. See [LICENSE](https://vibgrate.com/license) for terms.
