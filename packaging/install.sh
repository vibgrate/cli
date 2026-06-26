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

if command -v npm >/dev/null 2>&1; then
  echo "vg: installing ${PKG} globally via npm…"
  npm install -g "${PKG}"
  echo "vg: done. Run 'vg' in a project to build its code map."
else
  echo "vg: npm not found. Run with npx instead: npx ${PKG} vg" >&2
  exit 1
fi
