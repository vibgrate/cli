#!/usr/bin/env sh
# vg installer (curl | sh). Installs the @vibgrate/cli package which provides the
# `vg` command. Requires Node.js >= 20 and npm. Honest: this wraps npm; it does
# not download an unsigned binary.
set -eu

PKG="@vibgrate/cli"

if ! command -v node >/dev/null 2>&1; then
  echo "vg: Node.js >= 20 is required (https://nodejs.org). Aborting." >&2
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "${NODE_MAJOR}" -lt 20 ] 2>/dev/null; then
  echo "vg: Node.js >= 20 is required (found $(node --version)). Upgrade at https://nodejs.org. Aborting." >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  echo "vg: installing ${PKG} globally via npm…"
  npm install -g "${PKG}"
  echo "vg: done. Run 'vg' in a project to build its code map."
else
  # npx ships with npm, so it cannot help in this branch — a Node install
  # without npm needs npm first.
  echo "vg: npm not found. Install Node.js with npm from https://nodejs.org, then rerun." >&2
  exit 1
fi
