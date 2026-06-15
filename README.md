<p align="center">
  <a href="https://vibgrate.com"><img src="https://vibgrate.com/img/vibgrate-logo-512.png" alt="Vibgrate" width="96" height="96" /></a>
</p>

<p align="center">
  <strong>@vibgrate/cli</strong>
  <br />
  Continuous Upgrade Drift Intelligence for engineering teams
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vibgrate/cli"><img src="https://img.shields.io/npm/v/@vibgrate/cli?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@vibgrate/cli"><img src="https://img.shields.io/npm/dm/@vibgrate/cli?color=green" alt="npm downloads" /></a>
  <a href="https://vibgrate.com/cli"><img src="https://img.shields.io/badge/live%20demo-vibgrate.com%2Fcli-3FB0A4" alt="live demo" /></a>
  <img src="https://img.shields.io/node/v/@vibgrate/cli" alt="node version" />
</p>

Vibgrate answers one question for any repo:
**how far behind is it, and what should we upgrade first?**

One command gives you a deterministic **Upgrade Drift Score** (0–100), a clear
risk level, runtime + framework major-version lag, dependency age and EOL
proximity, and a ranked list of what to fix next — across **Node.js/TypeScript,
.NET, Python, and Java**.

---

## See it run

<p align="center">
  <a href="https://vibgrate.com/cli">
    <img src="https://vibgrate.com/img/cli/cli.png" alt="Vibgrate CLI scanning a repository and producing a drift report" width="640" />
  </a>
</p>

<p align="center">
  <a href="https://vibgrate.com/cli"><strong>▶ Try the live, interactive CLI simulator →</strong></a><br />
  <sub>Replays real <code>@vibgrate/cli</code> runs against sample repos — nothing executes in your browser.</sub>
</p>

---

## Try it in 10 seconds

No install, no signup:

```bash
npx @vibgrate/cli scan .
```

You get an overall score + risk level, detected projects (Node/.NET/Python/Java),
runtime and framework lag, and a ranked list of priority actions — printed to
your terminal.

Install it locally for repeat runs:

```bash
npm install -D @vibgrate/cli
npx vibgrate scan .
```

> Local binaries live in `node_modules/.bin`, so use `npx` (or an npm script)
> unless you install globally.

---

## Track drift over time → create a free workspace

The CLI is fully useful offline. When you want **trends across runs and repos**
— so drift becomes a metric you manage, not a surprise you discover — push your
scans to a workspace:

1. **Create a workspace** at **[dash.vibgrate.com](https://dash.vibgrate.com)** and copy your DSN.
2. **Connect the CLI** and push in one command:

```bash
VIBGRATE_DSN="vibgrate+https://<key_id>:<secret>@us.ingest.vibgrate.com/<workspace_id>" \
  npx @vibgrate/cli scan . --push
```

Upload is opt-in — nothing leaves your machine until you run `--push`. For CI,
store the DSN as a secret, never commit it.

**[→ Create your workspace](https://dash.vibgrate.com)**

---

## Why teams adopt Vibgrate

Most systems don't fail all at once. They accumulate upgrade debt silently until
migrations become expensive. Vibgrate makes that debt measurable and repeatable:

- **Developers** run a one-off scan to understand current debt.
- **CI pipelines** run it every PR to stop regression.
- **Engineering leaders** track trends over time in the dashboard.

| Mode | What you get | Best for |
| --- | --- | --- |
| **One-off scan** | Fast snapshot of score, lag, and findings | Audits, due diligence, migration planning |
| **CI-integrated scan** | Continuous drift signal, SARIF annotations, regression guardrails | Keeping upgrade debt under control long-term |

Recommended rollout: scan once now, add Vibgrate to CI this week.

---

## What the report contains

- **Overall score** and risk level (**Low / Moderate / High**)
- **Score breakdown** — runtime, frameworks, dependencies, EOL
- **Per-project detail** across Node, .NET, Python, and Java
- **Actionable findings** (notes / warnings / errors)
- **Top priority actions** ranked by likely impact

Output stays plain and operational, so it converts straight into backlog items
and CI policy.

---

## Quick start with AI assistants

Paste this into your AI coding tool (Copilot, Cursor, Claude, etc.):

```
Set up Vibgrate for upgrade drift tracking:
1. Install: npm install -g @vibgrate/cli@latest
2. Create DSN: npx vibgrate dsn create --workspace new
3. Save DSN: echo 'export VIBGRATE_DSN="<dsn>"' >> ~/.zshrc && source ~/.zshrc
4. Scan: npx vibgrate scan . --push
Then explain my drift score and top 3 upgrade priorities.
```

See [docs/QUICKSTART-PROMPT.md](./docs/QUICKSTART-PROMPT.md) for the full prompt.

---

## CI integration

Drop Vibgrate into any pipeline to turn drift scoring into a quality gate.
Copy-paste templates live in this package:

- `examples/github-actions/driftscore-ci.yml` — JSON artifact + drift gate
- `examples/github-actions/driftscore-sarif.yml` — SARIF upload to code scanning
- `docs/ci/github-actions.md` — integration notes

```yaml
# GitHub Actions
- name: Vibgrate scan
  env:
    VIBGRATE_DSN: ${{ secrets.VIBGRATE_DSN }}
  run: npx @vibgrate/cli scan . --push --format sarif --out vibgrate.sarif --fail-on error

- name: Upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: vibgrate.sarif
```

Gate on drift budgets and regression relative to a baseline:

```bash
npx vibgrate baseline .
npx vibgrate scan . --baseline .vibgrate/baseline.json --drift-budget 40 --drift-worsening 5
```

- `--drift-budget <score>` fails the build if the absolute drift score exceeds your budget.
- `--drift-worsening <percent>` fails the build if drift worsens by more than X% vs baseline.

Azure DevOps and GitLab CI snippets are in [DOCS.md](./DOCS.md#ci-integration).

---

## Capabilities at a glance

Beyond core drift scoring, Vibgrate also surfaces:

- Multi-language workspace scanning (Node.js/TypeScript, .NET, Python, Java)
- Platform matrix and native-module risk
- Dependency risk, graph duplication, and phantom dependencies
- Tooling inventory and build/deploy surface
- TypeScript modernity and breaking-change exposure
- File hotspots and structural security posture
- Service dependency and architecture-layer mapping
- Code-quality metrics and OWASP category mapping
- **SBOM export** (CycloneDX / SPDX) and **SBOM delta** between runs

```bash
npx vibgrate sbom export --format cyclonedx --out sbom.cdx.json
npx vibgrate sbom delta --from .vibgrate/baseline.json --to .vibgrate/scan_result.json --out sbom-delta.txt
```

Full scanner details and configuration: **[DOCS.md](./DOCS.md)** ·
**[commercial-grade scanners](./docs/commercial-grade-scanners.md)**.

---

## Privacy & offline-first

- No data leaves your machine unless you run `--push` / `vibgrate push`.
- Core drift analysis reads manifests/configs — **not your source code**.
- Works without login and without SaaS dependencies.
- `--offline` disables registry/network lookups; `--package-manifest <file>`
  feeds drift scoring a local version bundle.
- `--max-privacy` suppresses local artifact writes and high-context scanners;
  `--no-local-artifacts` skips writing `.vibgrate/*.json` to disk.

```bash
vibgrate scan . --offline --package-manifest ./package-versions.zip --max-privacy --format json --out scan.json
```

Add `.vibgrate/` to your `.gitignore` — those are regenerated local outputs.

---

## Command reference

| Command | Description |
| --- | --- |
| `vibgrate scan [path]` | Scan for upgrade drift |
| `vibgrate scan --push` | Scan and push to your dashboard |
| `vibgrate baseline [path]` | Create a drift baseline |
| `vibgrate report` | Generate a report from a scan artifact |
| `vibgrate sbom export` | Export a CycloneDX or SPDX SBOM |
| `vibgrate sbom delta` | Compare two artifacts for SBOM drift |
| `vibgrate init [path]` | Initialise config and `.vibgrate/` |
| `vibgrate push` | Upload scan results to your dashboard |
| `vibgrate dsn create` | Generate a DSN token |
| `vibgrate update` | Check for and install updates |

```bash
vibgrate scan [path] [--format text|json|sarif|md] [--out <file>] [--fail-on warn|error] \
  [--offline] [--package-manifest <file>] [--no-local-artifacts] [--max-privacy]
```

Full command, flag, and configuration reference: **[DOCS.md](./DOCS.md)** ·
**[CLI reference on vibgrate.com](https://vibgrate.com/cli)**.

---

## Requirements

- Node.js **20+**
- macOS, Linux, Windows

---

<p align="center">
  <a href="https://dash.vibgrate.com"><strong>Create a free workspace →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://vibgrate.com/cli">Try the live demo</a>
  &nbsp;·&nbsp;
  <a href="./DOCS.md">Read the docs</a>
</p>

<p align="center">
  <sub>Copyright © 2026 Vibgrate. All rights reserved. See the <a href="https://vibgrate.com/license">Vibgrate CLI License</a> for terms.</sub>
</p>
