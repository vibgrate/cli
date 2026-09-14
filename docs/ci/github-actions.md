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
shapes: [`../security-packs.md`](../security-packs.md).

## Drift gate behavior

The CI template uses existing scan-time gates:

- `--fail-on error` to fail on error-level findings
- `--fail-on architecture-finding` to fail on a hard boundary finding from the architecture module (an HTTP handler that writes the store, domain code that does I/O); `architecture-warning` also fails on warnings. Needs the code map the scan builds and the Architecture module (`vg module install arch`); the rules come from `.vibgrate/architecture.toml` (`policy = "hexagonal-v1"`, `"layered-v1"` or `"vertical-v1"`, plus any `[[overlay]]` rules of your own; a `deny` overlay with `severity = "hard"` fails the gate like a baked violation). Each failing line is `file:line  symbol  violation: … (rule)`
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

## Related

- Full CI reference (Azure DevOps, GitLab CI, generic pipelines): [DOCS.md](../../DOCS.md#ci-integration)
- Vibgrate CLI overview and live demo: <https://vibgrate.com/cli>
- What the gates measure: [DriftScore](https://vibgrate.com/driftscore)
