#!/usr/bin/env node
// Resolve and stamp the release version into package.json AND src/version.ts
// (the latter is embedded in the build for `vg --version`), so every publish
// gets a fresh, correctly-incremented version instead of the committed
// placeholder.
//
// Versioning is the calendar scheme shared with the monorepo: YYYY.MDD.N
//   YYYY  full year
//   MDD   month (no leading zero) + zero-padded day  (June 26 -> 626)
//   N     1-based release counter for the current UTC day
//
// N is derived from what is ALREADY published to npm for @vibgrate/cli (the
// count of versions matching today's YYYY.MDD, plus one). Using the registry as
// the counter means each publish auto-increments with no git tag to manage and
// no risk of a tag-push re-trigger loop.
//
// Usage:
//   node scripts/stamp-version.mjs                 # compute next calendar version
//   node scripts/stamp-version.mjs --version 1.2.3 # use an explicit version (tag push)
//   node scripts/stamp-version.mjs --dry-run       # print only, write nothing
//
// Prints the resolved version to stdout (capture it in CI).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@vibgrate/cli';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

function todayBase() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12, no leading zero
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}.${month}${day}`;
}

// How many versions are already on npm for today's YYYY.MDD track.
function npmCountForBase(base) {
  try {
    const out = execSync(`npm view ${PKG_NAME} versions --json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    const versions = Array.isArray(parsed) ? parsed : [parsed];
    return versions.filter((v) => typeof v === 'string' && v.startsWith(`${base}.`)).length;
  } catch {
    // Package not published yet (404) or npm unavailable — start the day at 1.
    return 0;
  }
}

function calendarVersion() {
  const base = todayBase();
  return `${base}.${npmCountForBase(base) + 1}`;
}

const explicit = arg('--version');
const version = (explicit ? explicit.replace(/^v/, '') : calendarVersion()).trim();

if (!has('--dry-run')) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const verPath = path.join(ROOT, 'src/version.ts');
  const src = fs.readFileSync(verPath, 'utf8');
  const next = src.replace(/export const VERSION\s*=\s*'[^']*';/, `export const VERSION = '${version}';`);
  if (next === src && !/export const VERSION/.test(src)) {
    throw new Error(`could not find VERSION export to stamp in ${verPath}`);
  }
  fs.writeFileSync(verPath, next);
}

process.stdout.write(version);
