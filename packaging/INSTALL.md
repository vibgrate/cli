# Installing `vg`

`vg` ships as the `vg` command inside the published **`@vibgrate/cli`** package
(the bare `vg` npm name is unavailable). Node.js ≥ 22 is required. Every install
path below lands the same `vg` command. Product overview and live demo:
[vibgrate.com/cli](https://vibgrate.com/cli).

## One-liners

```bash
# npx (no install)
npx @vibgrate/cli scan

# npm (global)
npm install -g @vibgrate/cli

# curl | sh   (POSIX)
curl -fsSL https://vibgrate.com/install.sh | sh

# irm | iex   (Windows PowerShell)
irm https://vibgrate.com/install.ps1 | iex
```

## Package managers

```bash
# Homebrew (tap)
brew install vibgrate/tap/vg

# Scoop (add the bucket once, then install)
scoop bucket add vibgrate https://github.com/vibgrate/scoop-bucket
scoop install vibgrate/vg

# Docker / GHCR (the image entrypoint is `vg`; default command scans /work)
docker run --rm -v "$PWD":/work -w /work ghcr.io/vibgrate/cli scan
```

## Templates in this directory

| File | Purpose |
|---|---|
| `install.sh` / `install.ps1` | curl/irm bootstrap (wraps npm; no unsigned binaries) |
| `Dockerfile` | container image (publish to GHCR/Docker Hub) |
| `homebrew/vg.rb` | Homebrew formula template (sha256/version stamped at release) |
| `scoop/vg.json` | Scoop manifest (auto-checkver against npm) |

The release pipeline stamps versions/checksums and publishes signed artifacts +
an SBOM. These files are templates, not pinned releases — honest by construction.

## Wire it into your assistant

```bash
vg install --list           # the support matrix (20+ assistants)
vg install claude cursor    # skill + advisory nudge + MCP registration
vg serve                    # run the local MCP server directly
```
