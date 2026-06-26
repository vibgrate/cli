# GitHub Actions integration

Vibgrate already supports CI gating and SARIF export through the core `scan` command.

## Copy-paste workflows

- CI drift gate template: `examples/github-actions/driftscore-ci.yml`
- SARIF upload template: `examples/github-actions/driftscore-sarif.yml`

Copy either template into your repository under `.github/workflows/`.

## Drift gate behavior

The CI template uses existing scan-time gates:

- `--fail-on error` to fail on error-level findings
- `--drift-budget <score>` to fail when drift score exceeds your budget

Example gate command:

```bash
npx @vibgrate/cli scan . --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

## SARIF upload behavior

The SARIF template produces and uploads SARIF using GitHub's CodeQL upload action.

```bash
npx @vibgrate/cli scan . --format sarif --out vibgrate-results.sarif --fail-on error
```
