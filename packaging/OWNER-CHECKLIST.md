# Public install channels — owner checklist

Strangers install `vg` through more than npm. The workflows in this package
publish those artifacts from **github.com/vibgrate/cli** (the public replica).
Code cannot create org repos or Hub credentials. Each channel below is either
already working or has **one concrete owner action**.

Live CLI version this checklist targets: **2026.914.1**.

## Already working (2026-09-14/15 retest)

- `npx @vibgrate/cli` / `npm install -g @vibgrate/cli` / `install.sh`
- `docker pull ghcr.io/vibgrate/cli:2026.914.1` and `:latest` (anonymous)

## 1. Helm — `oci://ghcr.io/vibgrate/charts/vibgrate`

**What the code does:** `helm.yml` packages, signs, and pushes the chart. A
chart `version` bump (this tree: `0.1.1` → `0.1.2`, `appVersion` `2026.914.1`)
or a CLI `package.json` version change publishes automatically. After push it
calls `scripts/ghcr-set-visibility.mjs` so the GHCR package is public.

**Owner action (if anonymous `helm pull` still 401s):**

1. Sign in as a `vibgrate` org owner.
2. Open https://github.com/orgs/vibgrate/packages/container/charts/vibgrate/settings
   (the package appears after the first successful Helm publish).
3. **Change visibility → Public**. GitHub warns this is hard to undo.
4. Confirm:
   ```bash
   helm pull oci://ghcr.io/vibgrate/charts/vibgrate --version 0.1.2
   ```

**Optional, so future publishes flip visibility without the UI:** add repo
secret `PACKAGES_ADMIN_TOKEN` on `vibgrate/cli` — a PAT that can administer
GHCR packages (`write:packages` plus the org package-admin grant).

**If the chart was never published:** after this change reaches `vibgrate/cli`
`main`, either wait for the sync PR to merge (chart version change fires
Helm) or **Actions → Helm → Run workflow** (`dry-run = false`).

## 2. Docker Hub — `vibgrate/cli`

**What the code does:** `docker.yml` still publishes GHCR first. The Hub
mirror now always targets `docker.io/vibgrate/cli` (not `$USERNAME/cli`).
`docker-hub-mirror.yml` mirrors an existing GHCR tag without a rebuild.

**Owner action:**

1. On Docker Hub, create the public repository **`vibgrate/cli`** if it does
   not exist (account that owns the `vibgrate` namespace).
2. Create a Hub access token with **Read & Write**.
3. On **github.com/vibgrate/cli** → Settings → Secrets and variables → Actions,
   add:
   - `DOCKERHUB_USERNAME` — Hub account that can push to `vibgrate`
   - `DOCKERHUB_TOKEN` — the token from step 2
4. **Actions → Docker Hub mirror → Run workflow**, tag `2026.914.1`
   (`also-latest` on). This copies the signed GHCR digest; it does not rebuild.
5. Confirm:
   ```bash
   docker pull vibgrate/cli:2026.914.1
   docker run --rm vibgrate/cli --version
   ```

Later releases mirror automatically from `docker.yml` once those secrets exist.

## 3. Homebrew — `brew install vibgrate/tap/vg`

**What the code does:** `scripts/stamp-packaging.mjs` writes
`packaging/homebrew-tap/Formula/vg.rb` pinned to `2026.914.1` with the npm
tarball sha256. `packaging.yml` pushes that tree to `vibgrate/homebrew-tap`.

**Owner action:**

1. Create a **public** empty repo: https://github.com/organizations/vibgrate/repositories/new
   → name `homebrew-tap` (this is what `brew tap vibgrate/tap` clones).
2. On **github.com/vibgrate/cli**, add secret `PACKAGING_REPOS_TOKEN` — a PAT
   with **contents: write** on `vibgrate/homebrew-tap` and `vibgrate/scoop-bucket`
   (one token covers both channels).
3. **Actions → Packaging (Homebrew + Scoop) → Run workflow**, version
   `2026.914.1`.
4. Confirm:
   ```bash
   brew install vibgrate/tap/vg
   vg --version
   ```

Until the repo exists, `brew install vibgrate/tap/vg` 404s. The formula
content is already in this tree at `packaging/homebrew-tap/`.

## 4. Scoop — `scoop bucket add vibgrate https://github.com/vibgrate/scoop-bucket`

**What the code does:** same workflow as Homebrew. Manifest:
`packaging/scoop-bucket/vg.json` pinned to `2026.914.1`.

**Owner action:**

1. Create a **public** empty repo named `scoop-bucket` in the `vibgrate` org.
2. Same `PACKAGING_REPOS_TOKEN` as step 3.2.
3. Re-run **Packaging (Homebrew + Scoop)** if you already ran it for Homebrew.
4. Confirm:
   ```powershell
   scoop bucket add vibgrate https://github.com/vibgrate/scoop-bucket
   scoop install vibgrate/vg
   vg --version
   ```

## Secrets on `github.com/vibgrate/cli` (summary)

| Secret | Used by | Purpose |
|---|---|---|
| `DOCKERHUB_USERNAME` | `docker.yml`, `docker-hub-mirror.yml` | Hub login |
| `DOCKERHUB_TOKEN` | `docker.yml`, `docker-hub-mirror.yml` | Hub push |
| `PACKAGING_REPOS_TOKEN` | `packaging.yml` | Push to `homebrew-tap` + `scoop-bucket` |
| `PACKAGES_ADMIN_TOKEN` | `docker.yml`, `helm.yml` | Optional. Make GHCR packages public without a UI click |

Do not invent or commit credentials. Create them in the provider UI, store
them only as Actions secrets.

## After this change reaches `vibgrate/cli` `main`

Workflows in `.github/workflows/` run in the public replica, not the
monorepo. Once the sync PR merges:

1. Helm publishes chart `0.1.2` (appVersion `2026.914.1`) — flip package
   visibility if the API could not.
2. **Docker Hub mirror** and **Packaging (Homebrew + Scoop)** are
   dispatchable immediately (they do not wait for another CLI version bump).
