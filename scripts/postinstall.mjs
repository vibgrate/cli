#!/usr/bin/env node
// Checks whether `vg` is already occupied by another tool on PATH.
// If it is, prints a one-time notice that `vibgrate` is an identical alias.
// Exits 0 regardless — a conflict is not an install failure.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

// Resolve the directory this package installed its own bin links into.
// __filename → scripts/postinstall.mjs → ../../dist/cli.js (the actual binary)
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownBin = path.join(pkgRoot, 'dist', 'cli.js');

function which(cmd) {
  try {
    const out = execFileSync(
      isWindows ? 'where' : 'which',
      [cmd],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

function realpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

const vgOnPath = which('vg');

if (!vgOnPath) {
  // `vg` not on PATH yet (e.g. local install, PATH not updated) — nothing to warn about.
  process.exit(0);
}

// Resolve symlinks so we compare actual files, not wrapper scripts.
const resolvedVg = realpath(vgOnPath);
const resolvedOwn = realpath(ownBin);

if (resolvedVg === resolvedOwn) {
  // Our binary is the one that wins — no conflict.
  process.exit(0);
}

// Something else owns `vg` on this machine.
console.log('');
console.log(
  '\x1b[33m⚠\x1b[0m  \x1b[1m@vibgrate/cli:\x1b[0m \x1b[33mThe `vg` command is already used by another tool on this system.\x1b[0m',
);
console.log(
  '   Use \x1b[1mvibgrate\x1b[0m instead — it is installed alongside `vg` and is identical in every way.',
);
console.log('');
console.log('   Examples:');
console.log('     vibgrate scan');
console.log('     vibgrate build');
console.log('     vibgrate serve');
console.log('');
console.log(
  '   See https://vibgrate.com/cli for full documentation.',
);
console.log('');

process.exit(0);
