# GitHub Actions integration

Vibgrate already supports CI gating and SARIF export through the core `scan` command.

## Quick start

```bash
vg init --ci github
```

This writes `.github/workflows/vibgrate.yml`: it scans every pull request and
push to `main` with the `vibgrate/cli` Action and uploads SARIF to GitHub
Security. It never overwrites an existing workflow, and it does not fail the
build until you opt in (`fail-on`, `--drift-budget`) using the commented lines
in the file. SARIF upload to private repositories needs GitHub code scanning.

## Gate on the DriftScore

The `vibgrate/cli` Action fails the job when the DriftScore is above a budget
you choose. `max-score` takes a number from 0 to 100 (lower is better) and maps
to `--drift-budget`; leave it empty to never fail on the score. A non-numeric
value, or one outside 0 to 100, fails the step with a clear error before the
scan runs.

```yaml
- uses: actions/checkout@v4
- uses: vibgrate/cli@v1
  with:
    upload-sarif: true
    max-score: 40
```

## Read the score in a later step

The Action exposes the result as step outputs, and adds a line to the job
summary:

| Output | Value |
|---|---|
| `drift-score` | DriftScore, 0-100 (lower is better). Empty when drift could not be measured, never `0` |
| `risk-level` | `low`, `moderate` or `high` |
| `score-delta` | Change since the baseline (positive = worse). Empty without a baseline |
| `summary-file` | Path of the JSON the scan wrote (`vibgrate-summary.json`) |

```yaml
- id: drift
  uses: vibgrate/cli@v1
  with:
    upload-sarif: true
- run: echo "DriftScore is ${{ steps.drift.outputs.drift-score }}"
```

The outputs need a scanner image that supports `--summary-out`, and `jq` on the
runner (present on GitHub-hosted runners). With an older `image-tag` the scan
still runs and the outputs stay empty, with a notice in the log.

## Fail when drift gets worse

Create a baseline once, commit it, and point the Action at it:

```bash
vg baseline
git add .vibgrate/baseline.json
```

```yaml
- uses: actions/checkout@v4
- uses: vibgrate/cli@v1
  with:
    upload-sarif: true
    baseline: .vibgrate/baseline.json
    max-worsening: 5 # fail when drift worsens by more than 5% vs the baseline
```

`baseline` is a path inside the repository. `max-worsening` maps to
`--drift-worsening` and needs `baseline`. Refresh the baseline when you accept a
new level of drift. `vg init --ci github --baseline` writes the baseline and a
workflow that already references it, with `max-worsening` left commented out.

## Copy-paste workflows

- Drift gate (failure versus warn, pins, DriftScore badge): `examples/github-actions/README.md`
- CI drift gate template: `examples/github-actions/driftscore-ci.yml`
- SARIF upload template: `examples/github-actions/driftscore-sarif.yml`
- SARIF plus JUnit test report template: `examples/github-actions/driftscore-junit.yml`
- Vulnerability gate + SARIF template: `examples/github-actions/vulnerabilities-sarif.yml`

Copy any template into your repository under `.github/workflows/`. The README is enough to add the basic gate: the workflow, when the job fails, and how a README badge is filled in.

## Vulnerability gate (`--vulns`)

Use the maintained `vibgrate/cli` Action to scan for known vulnerabilities, gate
the pull request, and upload SARIF to code scanning in one step:

```yaml
permissions:
  contents: read
  security-events: write   # required to upload SARIF

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0        # full history → exposure attribution + remediation MTTR
  - uses: vibgrate/cli@v1
    with:
      vulns: true
      fail-on: error        # critical/high block the merge
      upload-sarif: true
      category: vibgrate-vulns
```

The Action inputs map to scan flags: `vulns: true` adds `--vulns`, `fail-on` adds
`--fail-on`, and `upload-sarif: true` runs `github/codeql-action/upload-sarif`
after the scan (with `always()`, so findings still surface when the gate fails).
Prefer raw CLI steps? `npx @vibgrate/cli scan --vulns --format sarif --out
vibgrate-vulns.sarif --fail-on error`, then upload the file yourself.

## Infrastructure misconfiguration gate (`--iac`)

The same scan can evaluate Terraform, Kubernetes, Helm and Dockerfile facts
against the Architecture module's `iac-cis-v1` pack and gate on the result.
Findings carry content-addressed ids, so the SARIF you upload tracks the same
alert across rebases instead of re-opening it when a line moves.

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v4
  - run: npx @vibgrate/cli scan --full --format sarif --out vibgrate.sarif --fail-on iac-finding
  - uses: github/codeql-action/upload-sarif@v3
    if: always()
    with:
      sarif_file: vibgrate.sarif
      category: vibgrate
```

`--fail-on iac-finding` exits 2 on a high or critical infrastructure finding;
`--fail-on iac-finding=medium` lowers the bar, and a comma list combines it
with the drift gate (`--fail-on error,iac-finding`). The gate needs the code
map the scan builds and the Architecture module, which the CLI provisions on
first use; on an air-gapped runner install it with `vg module install arch`
from a bundle or set `VIBGRATE_ARCH_PATH`. A gate that cannot be evaluated
exits 2 with a one-line reason rather than passing. Rule catalogue and output
shapes: [`../security-packs.md`](../security-packs.md). How `.tf` and `.tofu`
files are treated, including a `.tofu`-only tree:
[Terraform and OpenTofu files](../security-packs.md#terraform-and-opentofu-files).

## Drift gate behavior

The full table — finding gates, budget flags, `warn` / `enforce` / `shadow`, pins, and the DriftScore badge — is in [`examples/github-actions/README.md`](../../examples/github-actions/README.md). The short form:

`--fail-on warn` **fails** the job (exit 2) when a warning or error finding exists. `driftBudget.mode: warn` **does not**. That mode prints a breached budget and exits 0. `shadow` reports only and exits 0. `enforce` exits 2.

`--drift-budget` and `--drift-worsening` always exit 2 on a breach, and they ignore `driftBudget` in the project config. A score equal to the budget passes. A DriftScore that was not measured does not fail either flag (it is absent, not 0). `--drift-worsening` without `--baseline` exits 2 when a score was measured. The same worsening key in config, with no baseline, is not evaluated and does not fail.

A `driftBudget` or `review` block with an unknown key, a bad mode, or a value of the wrong type exits 1 before the scan. The error names the file and the key, and the line when it can, and it does not print the value.

Do not set `continue-on-error` on the gate step. Exit 2 is what blocks the merge. Upload SARIF or the JSON report with `if: always()` — the file is already written when the gate exits.

```bash
vg scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

Other scan-time gates on the same command:

- `--fail-on error` fails on error-level findings. Warnings do not fail this gate.
- `--fail-on architecture-finding` fails on a hard boundary finding from the architecture module (an HTTP handler that writes the store, domain code that does I/O); `architecture-warning` also fails on warnings. Needs the code map the scan builds and the Architecture module (`vg module install arch`); the rules come from `.vibgrate/architecture.toml` (`policy = "hexagonal-v1"`, `"layered-v1"` or `"vertical-v1"`, plus any `[[overlay]]` rules of your own; a `deny` overlay with `severity = "hard"` fails the gate like a baked violation). Each failing line is `file:line  symbol  violation: … (rule)`. A gate that cannot be evaluated exits 2.
- `--drift-budget <score>` fails when DriftScore is above the budget.

## SARIF upload behavior

The SARIF template produces and uploads SARIF using GitHub's CodeQL upload action.

```bash
npx @vibgrate/cli scan --format sarif --out vibgrate-results.sarif --fail-on error
```

## JUnit XML

`--junit <file>` writes a second, deterministic JUnit report beside the SARIF or JSON artifact. GitHub's code scanning still wants SARIF (above). Systems that ingest JUnit — GitLab test reports, Azure DevOps, Jenkins — publish this file. It does not change the exit code: a gate failure is still exit `2` ([Exit Codes](../../DOCS.md#exit-codes)), and the XML is on disk when the step fails.

```bash
npx @vibgrate/cli scan --format sarif --out vibgrate-results.sarif --junit vibgrate.junit.xml --fail-on error --drift-budget 40
```

What each testcase means (finding vs budget gate, pass / failure / skipped) is in [JUnit](../../DOCS.md#junit).

To publish it on GitHub as a check run and job summary next to the SARIF upload, start from `examples/github-actions/driftscore-junit.yml`.

## DriftScore badge

The gate workflow does not publish a badge and does not take a credential. Embed the hosted image (replace `OWNER` and `REPO`):

```markdown
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

A public GitHub repository Vibgrate has not scanned shows `scanning…` on the first DriftScore request, then the score on a later request. No account is required for that badge. A repository already scanned in Vibgrate Cloud shows its score after the public badge is turned on. Colour is the score band (0–30 green, 31–60 amber, 61–100 red; lower is better), not a CI result. Details: [`examples/github-actions/README.md`](../../examples/github-actions/README.md) and [vibgrate.com/badges](https://vibgrate.com/badges).

## Action pins in the code map

`vg build` reads a workflow file that sits directly in `.github/workflows/` and whose name ends in `.yml` or `.yaml`. A file in a subdirectory of that folder is not extracted here. Only the first YAML document in the file is read.

Each step with a `uses:` string becomes a step node and an external node, joined by a `depends_on` edge. The string is copied as it is written. The map has no field that labels the pin a commit SHA, a tag, a branch, a local path, or a `docker://` image.

| Node | Kind | Signature | Qualified name | What holds the pin |
| --- | --- | --- | --- | --- |
| Step | `step` | `gha.step.uses` | `job:<job key>#<index>` | `doc` is `uses <string>`. `name` is the step's `name:` when that key is set, otherwise the `uses` string, cut at 80 characters |
| Action | `external` | `gha.action` | `action:<string>` | `name` is the text before the first `@`, or the whole string when there is no `@` |

The index starts at 0 and follows the step's place in `steps`. The edge runs from the step to the action, with `resolution` `heuristic`, `epistemic` `declared`, and `confidence` 1. `with:` inputs are not copied onto the action node. A job with more than 100 steps records the first 100.

`doc` is a short summary, and that summary passes through credential redaction. A run of 40 or more letters and digits is replaced with `[REDACTED]`. A full commit SHA is 40 hex characters, and the hex of an image digest is longer, so those summaries do not keep the pin. A tag, a branch name, a local `./` path, and `docker://image:tag` stay in `doc` as `uses <string>` when they contain no such run. The action's qualified name, and the step's `name` when the step has no `name:` key, are not summaries. They keep the original string, including a SHA.

| Form | `uses` value | Action `name` | Action qualified name | Step `doc` |
| --- | --- | --- | --- | --- |
| Commit SHA | `actions/checkout@0123456789abcdef0123456789abcdef01234567` | `actions/checkout` | `action:actions/checkout@0123456789abcdef0123456789abcdef01234567` | `uses actions/checkout@[REDACTED]` |
| Tag | `actions/checkout@v4` | `actions/checkout` | `action:actions/checkout@v4` | `uses actions/checkout@v4` |
| Branch | `actions/checkout@main` | `actions/checkout` | `action:actions/checkout@main` | `uses actions/checkout@main` |
| Local path | `./.github/actions/build` | `./.github/actions/build` | `action:./.github/actions/build` | `uses ./.github/actions/build` |
| Docker image | `docker://alpine:3.8` | `docker://alpine:3.8` | `action:docker://alpine:3.8` | `uses docker://alpine:3.8` |
| Docker digest | `docker://alpine@sha256:` plus 64 hex characters | `docker://alpine` | `action:` plus the whole `uses` string | `uses docker://alpine@sha256:[REDACTED]` |

The 40 hex characters in the SHA row are an example, so the redaction is visible. They are not a published commit of `actions/checkout`.

### A SHA-pinned step and a tag-pinned step

```yaml
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
      - uses: actions/checkout@v4
```

Saved as `.github/workflows/ci.yml`, `vg build` records:

| | SHA step (line 7) | Tag step (line 8) |
| --- | --- | --- |
| Step qualified name | `job:build#0` | `job:build#1` |
| Step `name` | `actions/checkout@0123456789abcdef0123456789abcdef01234567` | `actions/checkout@v4` |
| Step `doc` | `uses actions/checkout@[REDACTED]` | `uses actions/checkout@v4` |
| Action qualified name | `action:actions/checkout@0123456789abcdef0123456789abcdef01234567` | `action:actions/checkout@v4` |
| Action `name` | `actions/checkout` | `actions/checkout` |

`vg show` prints the qualified name, the file and line, and the signature. That is where the two pins differ on the terminal. The command also prints importance, area, `calls`, and `called by`. Those lines do not carry the pin. `calls` is empty: `vg show` lists `call` and `references` edges, and this link is `depends_on`. The step summary's `doc` is on the node in the map (`.vibgrate/graph.json`, or the file from `vg build -o`). `vg show` does not print `doc`.

```text
action:actions/checkout@0123456789abcdef0123456789abcdef01234567  (external)
  .github/workflows/ci.yml:7
  gha.action
```

```text
action:actions/checkout@v4  (external)
  .github/workflows/ci.yml:8
  gha.action
```

```bash
vg show action:actions/checkout@v4
```

Both action nodes share the short name `actions/checkout`, so `vg show actions/checkout` is ambiguous until you pass the qualified name or `--pick`.

### Local copy, unchanged pin

The nodes are a copy of the workflow file on disk. The same file produces the same nodes. This copy does not call GitHub, does not use a token, and does not resolve a tag or a branch to a commit. Nothing in the CLI reads an `actions.lock` file while building the map.

`vg build` without `--offline` can still download the Architecture module, and on an interactive terminal it can download an embedding model. Those fetches belong to the rest of the build. See [`--offline` vs `--local`](../../DOCS.md#--offline-vs---local).

`vg build --attest` signs the map after it is written. The signature is of that map. It does not classify a `uses:` pin and it does not resolve one. See [Sign and check the map](../../DOCS.md#sign-and-check-the-map).

`vg scan --iac` evaluates the Architecture module's `iac-cis-v1` pack. The rules in that pack are Terraform, Kubernetes, Helm, and Dockerfile checks. A workflow `uses:` line is outside the pack, so a tag and a commit SHA are the same result for that scan: no finding from this line. Catalogue: [Rules in `iac-cis-v1`](../security-packs.md#rules-in-iac-cis-v1-version-1).

A reusable workflow is a `uses:` on the job, not on a step. The job is still a node. That string is not copied to an action node.

Which pin to write in a gate workflow you keep is a separate choice: [Pins](../../examples/github-actions/README.md#pins).

## Related

- Full CI reference (Azure DevOps, GitLab CI, generic pipelines): [DOCS.md](../../DOCS.md#ci-integration)
- Vibgrate CLI overview and live demo: <https://vibgrate.com/cli>
- What the gates measure: [DriftScore](https://vibgrate.com/driftscore)
