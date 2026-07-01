# GitHub Actions integration

Vibgrate already supports CI gating and SARIF export through the core `scan` command.

## Copy-paste workflows

- CI drift gate template: `examples/github-actions/driftscore-ci.yml`
- SARIF upload template: `examples/github-actions/driftscore-sarif.yml`
- Vulnerability gate + SARIF template: `examples/github-actions/vulnerabilities-sarif.yml`

Copy any template into your repository under `.github/workflows/`.

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

## Drift gate behavior

The CI template uses existing scan-time gates:

- `--fail-on error` to fail on error-level findings
- `--drift-budget <score>` to fail when drift score exceeds your budget

Example gate command:

```bash
npx @vibgrate/cli scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

## SARIF upload behavior

The SARIF template produces and uploads SARIF using GitHub's CodeQL upload action.

```bash
npx @vibgrate/cli scan --format sarif --out vibgrate-results.sarif --fail-on error
```
