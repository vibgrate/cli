# vibgrate Scoop bucket

Scoop bucket for the [Vibgrate CLI](https://vibgrate.com/cli) (`vg` / `@vibgrate/cli`).

```powershell
scoop bucket add vibgrate https://github.com/vibgrate/scoop-bucket
scoop install vibgrate/vg
```

The manifest installs the published `@vibgrate/cli` npm package (Node.js is a
Scoop dependency) and exposes the `vg` command.

This repository is published from `github.com/vibgrate/cli` by the
`Packaging (Homebrew + Scoop)` workflow. Do not edit `vg.json` by hand —
change the template at `packaging/scoop/vg.json` in the CLI repo and re-run
the stamper.

Source: [github.com/vibgrate/cli](https://github.com/vibgrate/cli) · License: Apache-2.0
