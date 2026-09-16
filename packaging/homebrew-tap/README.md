# vibgrate/tap

Homebrew tap for the [Vibgrate CLI](https://vibgrate.com/cli) (`vg` / `@vibgrate/cli`).

```bash
brew install vibgrate/tap/vg
```

The formula installs the published npm package from
`https://registry.npmjs.org/@vibgrate/cli/-/cli-<version>.tgz` (checksum-verified)
and exposes the `vg` command. Node.js is a Homebrew dependency.

This repository is published from `github.com/vibgrate/cli` by the
`Packaging (Homebrew + Scoop)` workflow. Do not edit `Formula/vg.rb` by hand —
change the template at `packaging/homebrew/vg.rb` in the CLI repo and re-run
the stamper.

Source: [github.com/vibgrate/cli](https://github.com/vibgrate/cli) · License: Apache-2.0
