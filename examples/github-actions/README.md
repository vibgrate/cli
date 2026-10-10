# GitHub Actions — drift gate

Copy the workflow below into `.github/workflows/driftscore-ci.yml` (the same file is checked in here). It needs no token, no DSN, and no Vibgrate Cloud workspace. The job reads the repository, writes a JSON report, and fails the check when the gate says so.

`vg` is the command after install. `npx @vibgrate/cli` runs the same binary when you would rather not install globally. Do not put a trailing `.` on `vg` or `vg scan` — the current directory is the default.

## Recommended workflow

```yaml
name: DriftScore CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  drift-score:
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

      # Pin the calendar version you tested. Do not use @latest on a gate.
      # 2026.1005.1 is the scanner image pin in action.yml (image-tag).
      - name: Install Vibgrate CLI
        run: npm install -g @vibgrate/cli@2026.1005.1

      - name: Drift gate
        run: vg scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40

      # --out is written before a failing gate exits. always() keeps the report.
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vibgrate-report
          path: vibgrate-report.json
```

That step exits **2** when an error-level finding exists or DriftScore is above 40. GitHub then marks the step failed. Do not set `continue-on-error` on the gate step — that turns a failed gate into a green job. `vibgrate-review-sarif.yml` uses `continue-on-error` only because that file is not the gate.

The same flags without a global install:

```bash
npx @vibgrate/cli@2026.1005.1 scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

### Pins

| What | Pin |
| --- | --- |
| Node.js | 22 or newer (`actions/setup-node@v4`, `node-version: 22`). |
| Checkout, setup-node, upload-artifact, CodeQL upload | These examples use major tags: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `github/codeql-action/upload-sarif@v3`. In a repository you keep, pin each `uses:` to a full commit SHA. |
| CLI on the runner | `npm install -g @vibgrate/cli@<calendar version>`, then `vg`. A gate should not float on `@latest`. |
| Composite Action | `uses: vibgrate/cli@v1` moves the wrapper. The scanner image stays on `image-tag`. The default in `action.yml` is `2026.1005.1`. Set `image-tag` when `v1` must not pick up a newer image. |

`vg build` copies each `uses:` string into the code map. It does not resolve a tag to a commit. See [Action pins in the code map](../../docs/ci/github-actions.md#action-pins-in-the-code-map).

Omit `image-tag` to use that default. Omit `fail-on` and the job does not fail on findings. A budget you still want enforced goes in `args`:

```yaml
- uses: vibgrate/cli@v1
  with:
    format: json
    output: vibgrate-report.json
    fail-on: error
    args: --drift-budget 40
    image-tag: "2026.1005.1"
```

## When the job fails, and when it only warns

Two different knobs both use the word "warn". They do not mean the same thing.

- `--fail-on warn` is a **finding** gate. It **fails** the process (exit 2) when any finding is a warning or an error.
- `driftBudget.mode: warn` is a **budget** mode. It **prints** a breached DriftScore limit and exits **0**. The job stays green.

`--fail-on error` fails on error-level findings only. Warnings stay in the report and do not fail that gate. Omitting `--fail-on` does not fail the job for findings at all.

`--drift-budget` and `--drift-worsening` are flags. They have no warn mode. On a breach they exit 2. If either flag is present, `driftBudget` in the project config is ignored.

| Situation | Exit | Job |
| --- | --- | --- |
| No `--fail-on`, no budget flag, and no enforced config budget | 0 | Pass. Findings are still in the report. |
| `--fail-on error`, and no error-level finding | 0 | Pass. Warnings do not fail this gate. |
| `--fail-on error`, and at least one error-level finding | 2 | Fail. |
| `--fail-on warn`, and any warning or error finding | 2 | Fail. |
| `--drift-budget 40`, DriftScore **above** 40 | 2 | Fail. A score equal to 40 passes. |
| `--drift-budget 40`, DriftScore not measured | 0 | Pass. The score is absent, not 0, and the budget is not compared. |
| `--drift-worsening 5`, score measured, no `--baseline` | 2 | Fail. The flag cannot compare. |
| `--drift-worsening 5`, DriftScore not measured | 0 | Pass. The flag is not compared. |
| `--drift-worsening 5`, worsening **above** 5% versus the baseline | 2 | Fail. |
| `driftBudget.mode: warn` (default) and a breach | 0 | Pass. The breach is printed. The log says to set `enforce` to fail the scan. |
| `driftBudget.mode: shadow` and a breach | 0 | Pass. The breach is printed. Nothing is gated. |
| `driftBudget.mode: enforce` and a breach | 2 | Fail. |
| `driftBudget` the CLI cannot parse (unknown key, bad mode, wrong type) | 1 | Fail. The error names the file and the key. The scan does not run. |
| `maxRiskScore` or `maxRiskWorseningPercent` on a local scan | 0 | Pass. The limit is printed as not evaluated. The GitHub App computes RiskScore on a Team plan or above. |
| Unknown `--fail-on` value | 5 | Fail before the scan. This is a usage error, not a gate result. |
| Architecture or infrastructure gate requested, but the tree was not evaluated | 2 | Fail. An unevaluated gate is not a pass. |
| A required module is missing and could not be fetched | 6 | Fail. This is not a gate verdict. Do not treat 6 as "within budget". |

Exit **1** is a runtime error (bad manifest, unreadable path). It also fails the job. It is not a drift verdict.

Config form, warn versus enforce:

```yaml
# .vibgrate/config.yml
driftBudget:
  mode: warn          # warn (default) | enforce | shadow
  maxScore: 40
  maxWorseningPercent: 5
```

```bash
vg scan --format json --out vibgrate-report.json
```

With `mode: warn` or `mode: shadow`, a DriftScore above 40 prints and the process exits 0. With `mode: enforce`, that same score exits 2. `maxWorseningPercent` needs a baseline (`vg scan --baseline .vibgrate/baseline.json`). Without one it is reported as not evaluated, and it does not fail the scan. `agents.maxWorseningPercent` is not applied by `vg scan`.

Passing the flag uses the flag and ignores that file:

```bash
vg scan --format json --out vibgrate-report.json --drift-budget 40
```

That exits 2 when the measured score is above 40, whatever `mode` says.

### GitHub App check

The **Vibgrate DriftScore** check on a pull request is not this workflow. It reads `driftBudget` from the base branch (`.vibgrate/config.yml` or `vibgrate.config.json`). Conclusions:

| Mode | Within the limit | Breach |
| --- | --- | --- |
| `enforce` | success | failure |
| `warn` | success | neutral (not green, and it does not fail the check) |
| `shadow` | neutral | neutral |

A missing or invalid budget is neutral. The check does not block the merge unless you mark it required, and even then only an `enforce` breach is a failure.

### JUnit

`--junit vibgrate.junit.xml` writes that file before the process exits, including on exit 2. A warn-mode or shadow breach is `<skipped>` and does not fail the scan. An enforced budget breach is `<failure>`. The exit code is unchanged. See [JUnit](../../DOCS.md#junit) and [Exit Codes](../../DOCS.md#exit-codes).

### Assertions

The workflow above talks to the package registry, so DriftScore can move when a package publishes. That is the gate you want on a real repository.

A test that asserts on the report needs a frozen input. Pass `--offline` and a committed `--package-manifest`. The same tree and the same manifest produce the same finding order and the same advisory ids. Do not assert on `timestamp` or `durationMs` — those change every run. An absent DriftScore is `null`, not `0`.

```bash
vg scan --offline --package-manifest ./package-versions.json --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

## DriftScore badge

This workflow does not publish a badge. It does not take a credential, and there is no `vg` command that writes the SVG.

To show DriftScore on a README, embed the hosted image. Replace `OWNER` and `REPO` with the GitHub owner and repository name. The URL names that one repository:

```markdown
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

The image is `https://badges.vibgrate.com/OWNER/REPO`. The link opens a page that states which repository the badge is for. For a branch other than the default:

```markdown
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO?branch=develop)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

How the image gets a number:

- **Public GitHub repository, no account.** The first request for a DriftScore badge Vibgrate has not scanned shows `scanning…` while a scan runs. A later request shows the score. This applies to the DriftScore badge on public GitHub repositories.
- **Already scanned in Vibgrate Cloud.** Turn the public badge on for that repository. The same markdown then reads the score that scan published. That switch is in the dashboard. Do not add a DSN to the gate job to light the badge.

Other images you can get back: `unknown` (no score yet), `unavailable` (the automatic scan did not run — scan the repository yourself), `private` (the public badge is off), `not found` (the repository has no score and is not eligible for the automatic scan).

Colour is the score band, not a CI result. Lower is better: **0–30 green, 31–60 amber, 61–100 red**. A red badge does not fail the job. The job fails only on the exit codes in the table above.

More on the badge host: [vibgrate.com/badges](https://vibgrate.com/badges). What the number measures: [DriftScore](https://vibgrate.com/driftscore).

## Other workflows in this folder

| File | What it does |
| --- | --- |
| `driftscore-ci.yml` | The workflow on this page. JSON report plus a failing drift gate. |
| `driftscore-sarif.yml` | SARIF upload to code scanning. Upload runs with `if: always()` so a failed gate still files the alerts. |
| `driftscore-junit.yml` | SARIF to code scanning plus `--junit` published as a test report, from one scan. Both publish steps run with `if: always()`. |
| `vulnerabilities-sarif.yml` | Known-vulnerability gate via the composite Action (`fail-on: error` fails the job on critical and high). |
| `vibgrate-review.yml` | `vg review` with `--fail-on fail`. Only a `fail` decision stops the job. |
| `vibgrate-review-sarif.yml` | Review SARIF only. `continue-on-error` so the upload still runs. The pass/fail job is `vibgrate-review.yml`. |

Integration notes for SARIF, infrastructure gates, and JUnit: [`docs/ci/github-actions.md`](../../docs/ci/github-actions.md).
