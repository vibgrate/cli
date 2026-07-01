# Vibgrate Quick Start Prompt

**Copy this entire block and paste it into your AI coding assistant (Copilot, Cursor, Claude, etc.):**

---

```markdown
## Setup Vibgrate - Upgrade Drift Tracking

I want to start tracking upgrade drift in this project with Vibgrate. Complete these steps:

### Step 1: Install CLI & Create DSN
Install the CLI and create a DSN token:
```bash
npm install -g @vibgrate/cli@latest
npx vibgrate dsn create --workspace new
```

Copy the DSN output (starts with `vibgrate+https://...`)

### Step 2: Save DSN to Environment
Add the DSN to my shell profile:
```bash
echo 'export VIBGRATE_DSN="<dsn-from-step-1>"' >> ~/.zshrc && source ~/.zshrc
```

### Step 3: Run Scan with Dashboard Push
Run a scan and push results to the dashboard:
```bash
npx vibgrate scan --push --no-color
```

### Step 4: Explain My Results
After the scan, tell me:
- My drift score (0-100) and risk level
- Top 3 packages I should upgrade first
- Any EOL or deprecated dependencies

### Step 5: Create CI Workflow (Optional)
If I want CI integration, create `.github/workflows/drift.yml`:

```yaml
name: Drift Check
on: [push, pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx @vibgrate/cli scan --format sarif -o drift.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: drift.sarif }
      - run: npx @vibgrate/cli push
        env: { VIBGRATE_DSN: '${{ secrets.VIBGRATE_DSN }}' }
```

Start with Step 1 now.
```

---

## What This Does

1. **Installs CLI & creates DSN** — Uses `dsn create --workspace new` to generate a token
2. **Configures env** — Adds `VIBGRATE_DSN` to your shell profile
3. **Scans with push** — Runs drift scan and uploads to dashboard
4. **Explains results** — Tells you what's outdated and what to fix first
5. **Creates CI workflow** — Tracks drift on every commit

## DSN Token Format

Your DSN will look like:
```
vibgrate+https://abc123def456:secret789xyz@us.ingest.vibgrate.com/workspace123
```

Keep this secret! Add it to:
- `~/.zshrc` or `~/.bashrc` for local development
- GitHub Secrets as `VIBGRATE_DSN` for CI
