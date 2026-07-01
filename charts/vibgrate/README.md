# Vibgrate Helm chart

Scheduled upgrade-drift & supply-chain scanning for Kubernetes. The chart deploys
the **signed Vibgrate scanner image** as a `CronJob` that scans a repository and
pushes results to your Vibgrate workspace. Built for regulated K8s estates where
the broker/scanner is deployed in-cluster rather than run on a laptop.

## Install

```bash
# From the OCI registry (canonical)
helm install vibgrate oci://ghcr.io/vibgrate/charts/vibgrate \
  --set dsn="$VIBGRATE_DSN" \
  --set repository.url=https://github.com/your-org/your-repo
```

Also listed on **Artifact Hub** with signed + security-report badges.

## Provenance

The scanner image is **cosign-signed (keyless)** with **SLSA build provenance** and
a **CycloneDX SBOM** attestation, and so is this chart. Verify before deploying —
recipe at <https://vibgrate.com/trust>.

## Key values

| Key | Default | Description |
|-----|---------|-------------|
| `image.repository` | `ghcr.io/vibgrate/cli` | Scanner image. |
| `image.tag` | `""` → chart `appVersion` | Pinned, tested CLI release. |
| `dsn` | `""` | Workspace DSN. Required unless `existingSecret` is set. |
| `existingSecret` | `""` | Use a Secret you already manage instead of inlining `dsn`. |
| `repository.url` | `""` | Git repo to clone + scan (via an init container). |
| `repository.ref` | `""` | Branch/tag/SHA to scan. |
| `schedule` | `0 3 * * *` | CronJob schedule. |
| `scanArgs` | `[scan, /work, --push]` | Scanner arguments. |
| `runOnInstall` | `false` | Also run a one-off Job on install. |
| `policy.enabled` | `false` | Ship cluster admission policies (see below). |
| `policy.engine` | `policy-controller` | `policy-controller` \| `kyverno` \| `both`. |
| `policy.identityRegexp` | `^https://github.com/vibgrate/cli/.*` | Required signing identity. |
| `policy.require{Slsa,Sbom,Hcs,Vex}` | `true`/`true`/`true`/`false` | Attestations the image must carry. |

Pod defaults are hardened: non-root, read-only root filesystem, all capabilities
dropped, `RuntimeDefault` seccomp.

## Admission enforcement (optional)

Set `policy.enabled=true` to also install a Sigstore `ClusterImagePolicy` and/or a
Kyverno `verifyImages` policy so the cluster **only runs Vibgrate images** that
carry the full signed-and-attested set (keyless signature + SLSA provenance +
CycloneDX SBOM + our HCS self-attestation). Disabled by default; requires the
chosen controller to be installed. See
[`docs/SIGNING-AND-PROVENANCE.md`](../../docs/SIGNING-AND-PROVENANCE.md).

```bash
helm install vibgrate oci://ghcr.io/vibgrate/charts/vibgrate \
  --set dsn=... --set policy.enabled=true --set policy.engine=both
```

## Scan your own source

Set `repository.url` (with `repository.tokenSecret` for private repos), or mount
an existing source volume at `/work` via `extraVolumes` / `extraVolumeMounts`.
