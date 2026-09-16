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

# Docker / GHCR (canonical; the image entrypoint is `vg`)
docker run --rm -v "$PWD":/work -w /work ghcr.io/vibgrate/cli scan

# Docker Hub (mirror of the same signed image)
docker run --rm -v "$PWD":/work -w /work docker.io/vibgrate/cli scan
```

## Helm (Kubernetes)

```bash
helm install vibgrate oci://ghcr.io/vibgrate/charts/vibgrate \
  --set dsn="$VIBGRATE_DSN" \
  --set repository.url=https://github.com/your-org/your-repo
```

Chart details live in `charts/vibgrate/`. First-time org setup (GHCR package
visibility, Hub secrets, tap/bucket repos) is in [`OWNER-CHECKLIST.md`](./OWNER-CHECKLIST.md).

## Templates in this directory

| File | Purpose |
|---|---|
| `install.sh` / `install.ps1` | curl/irm bootstrap (wraps npm; no unsigned binaries) |
| `Dockerfile` | container image (publish to GHCR/Docker Hub) |
| `homebrew/vg.rb` | Homebrew formula template (sha256/version stamped at release) |
| `scoop/vg.json` | Scoop manifest (auto-checkver against npm) |
| `homebrew-tap/` | Stamped tap tree pushed to `github.com/vibgrate/homebrew-tap` |
| `scoop-bucket/` | Stamped bucket tree pushed to `github.com/vibgrate/scoop-bucket` |
| `OWNER-CHECKLIST.md` | One-time org-owner steps for Helm / Hub / brew / scoop |

The release pipeline stamps versions/checksums and publishes signed artifacts +
an SBOM. `homebrew/vg.rb` and `scoop/vg.json` are templates; the tap and bucket
copies are pinned to the current public CLI release.

## Wire it into your assistant

```bash
vg install --list           # the support matrix (20+ assistants)
vg install claude cursor    # skill + advisory nudge + MCP registration
vg serve                    # run the local MCP server directly
```
