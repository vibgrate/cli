# Installing `vg`

`vg` ships as the `vg` command inside the published **`@vibgrate/cli`** package
(the bare `vg` npm name is unavailable). Node.js ≥ 20 is required. Every install
path below lands the same `vg` command.

## One-liners

```bash
# npx (no install)
npx @vibgrate/cli vg

# npm (global)
npm install -g @vibgrate/cli

# curl | sh   (POSIX)
curl -fsSL https://vibgrate.com/vg/install.sh | sh

# irm | iex   (Windows PowerShell)
irm https://vibgrate.com/vg/install.ps1 | iex
```

## Package managers

```bash
# Homebrew (tap)
brew install vibgrate/tap/vg

# Scoop (bucket)
scoop install vibgrate/vg

# Docker / GHCR
docker run --rm -v "$PWD":/repo ghcr.io/vibgrate/vg vg -C /repo
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
