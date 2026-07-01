# Vibgrate Onboarding Prompt

Copy and paste the prompt below into your AI coding assistant (GitHub Copilot, Cursor, Claude, Windsurf, etc.) to get started with Vibgrate in under 2 minutes.

---

## The Prompt

```
Help me set up Vibgrate to track upgrade drift in this project. Do the following:

1. Install the Vibgrate CLI:
   npm install -g @vibgrate/cli@latest

2. Create a DSN token for Vibgrate Cloud uploads:
   npx vibgrate dsn create --workspace new
   
   Copy the DSN output (starts with vibgrate+https://...)

3. Save the DSN to my shell profile:
   - Add to ~/.zshrc (or ~/.bashrc): export VIBGRATE_DSN="<the-dsn-from-step-2>"
   - Source it: source ~/.zshrc

4. Run a scan with Vibgrate Cloud push:
   npx vibgrate scan --push

5. After the scan completes, tell me:
   - My overall drift score and risk level
   - The top 3 priority actions I should take
   - Which packages are most behind

Start now - run step 1.
```

---

## What Happens

When you paste this prompt, your AI assistant will:

1. **Install the CLI** — Gets the latest Vibgrate CLI globally
2. **Create a DSN** — Generates a token using `dsn create --workspace new`
3. **Configure your environment** — Adds `VIBGRATE_DSN` to your shell profile
4. **Run a scan with push** — Scans and uploads results to Vibgrate Cloud
5. **Explain the results** — Summarizes your drift score and top priorities

---

## Alternative: Quick Start Without Vibgrate Cloud

If you just want to scan without creating an account, use this simpler prompt:

```
Run a Vibgrate scan on this project to check for upgrade drift:

npx @vibgrate/cli scan

After the scan, explain:
1. What is my drift score and what does it mean?
2. What are the top 3 things I should upgrade?
3. Are any of my dependencies end-of-life or deprecated?
```

---

## Setting Up CI Integration

After onboarding, paste this prompt to add drift tracking to your CI pipeline:

```
Add Vibgrate to my CI pipeline to track upgrade drift on every build.

1. Create a GitHub Actions workflow at .github/workflows/drift.yml that:
   - Runs on push to main and on pull requests
   - Executes: npx @vibgrate/cli scan --format sarif --output drift.sarif
   - Uploads the SARIF file to GitHub Code Scanning
   - Pushes results to Vibgrate Cloud using secrets.VIBGRATE_DSN

2. Add instructions for setting up the VIBGRATE_DSN secret in GitHub

Show me the complete workflow file.
```

---

## Environment Variable Reference

| Variable | Description |
|----------|-------------|
| `VIBGRATE_DSN` | Your workspace's DSN token for authenticated API uploads |

The DSN format:
```
vibgrate+https://<key_id>:<secret>@<ingest_host>/<workspace_id>
```

Store this securely:
- **Local development**: Add to `~/.zshrc` or `~/.bashrc`
- **GitHub Actions**: Add as a repository secret
- **Other CI**: Add as an environment variable / secret

---

## Troubleshooting Prompts

### "My scan failed"
```
The Vibgrate scan failed. Please:
1. Check if there's a package.json, .csproj, requirements.txt, or pom.xml in the project
2. Run with verbose output: npx @vibgrate/cli scan --verbose
3. Explain what went wrong and how to fix it
```

### "Push isn't working"
```
Vibgrate push is failing. Help me debug:
1. Check if VIBGRATE_DSN is set: echo $VIBGRATE_DSN
2. Verify the DSN format is correct (starts with vibgrate+https://)
3. Run push with verbose: npx @vibgrate/cli push --verbose
4. If the DSN is invalid, create a new one: npx vibgrate dsn create --workspace new
```

### "Scan is slow"
```
The Vibgrate scan is taking too long. Help me speed it up:
1. Check how many package.json files exist: find . -name "package.json" | wc -l
2. Add exclusions to vibgrate.config.ts for node_modules, dist, and vendor directories
3. Run: npx @vibgrate/cli init . to create a config file if one doesn't exist
```
