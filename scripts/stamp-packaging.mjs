#!/usr/bin/env node
// Stamp the Homebrew formula and Scoop manifest from the packaging templates.
//
// Templates (`packaging/homebrew/vg.rb`, `packaging/scoop/vg.json`) stay
// unpinned. This writes the release-pinned copies that the tap / bucket
// publish workflow pushes to github.com/vibgrate/homebrew-tap and
// github.com/vibgrate/scoop-bucket:
//
//   packaging/homebrew-tap/Formula/vg.rb
//   packaging/scoop-bucket/vg.json
//
// Version + sha256 come from the published npm tarball
// `https://registry.npmjs.org/@vibgrate/cli/-/cli-<version>.tgz` — the same
// artifact Homebrew downloads and checksum-verifies.
//
// Usage:
//   node scripts/stamp-packaging.mjs                 # stamp package.json version
//   node scripts/stamp-packaging.mjs --version X.Y.Z # stamp an explicit version
//   node scripts/stamp-packaging.mjs --check         # exit 1 if stamped files drift
//   node scripts/stamp-packaging.mjs --dry-run       # print the plan, write nothing
//   node scripts/stamp-packaging.mjs --sha256 HEX    # skip the tarball download

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@vibgrate/cli';

export const FORMULA_TEMPLATE = 'packaging/homebrew/vg.rb';
export const SCOOP_TEMPLATE = 'packaging/scoop/vg.json';
export const FORMULA_STAMPED = 'packaging/homebrew-tap/Formula/vg.rb';
export const SCOOP_STAMPED = 'packaging/scoop-bucket/vg.json';

export function npmTarballUrl(version) {
  return `https://registry.npmjs.org/${PKG}/-/${PKG.split('/')[1]}-${version}.tgz`;
}

// Pure: fill the Homebrew formula template. VERSION is the calendar version
// in the tarball URL; REPLACED_AT_RELEASE is the sha256 placeholder.
export function stampFormula(template, { version, sha256 }) {
  if (!template.includes('VERSION') || !template.includes('REPLACED_AT_RELEASE')) {
    throw new Error('Homebrew formula template is missing VERSION or REPLACED_AT_RELEASE');
  }
  return template.replaceAll('VERSION', version).replaceAll('REPLACED_AT_RELEASE', sha256);
}

// Pure: fill the Scoop manifest. Version placeholder is REPLACED_AT_RELEASE;
// optional SHA256 / TARBALL_URL tokens are filled when present so a future
// url+hash manifest stays in lockstep.
export function stampScoop(template, { version, sha256, tarballUrl }) {
  if (!template.includes('REPLACED_AT_RELEASE')) {
    throw new Error('Scoop manifest template is missing REPLACED_AT_RELEASE');
  }
  let out = template.replaceAll('REPLACED_AT_RELEASE', version);
  if (template.includes('SHA256')) out = out.replaceAll('SHA256', sha256);
  if (template.includes('TARBALL_URL')) out = out.replaceAll('TARBALL_URL', tarballUrl);
  return out;
}

export async function sha256OfUrl(url, { retries = 4, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`download failed (${res.status}): ${url}`);
      }
      const hash = crypto.createHash('sha256');
      const reader = res.body?.getReader?.();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
        }
      } else {
        hash.update(Buffer.from(await res.arrayBuffer()));
      }
      return hash.digest('hex');
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function readRel(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function writeRel(rel, text) {
  const dest = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function pinnedCliVersion() {
  // Prefer the committed image/chart pin (the version strangers can pull)
  // over package.json, which may sit one calendar tick ahead of npm.
  const chart = readRel('charts/vibgrate/Chart.yaml');
  const m = chart.match(/appVersion:\s*"([^"]+)"\s*#\s*vibgrate:cli-version/);
  return m?.[1] ?? packageVersion();
}

export function renderStamped({ version, sha256, tarballUrl }) {
  return {
    formula: stampFormula(readRel(FORMULA_TEMPLATE), { version, sha256 }),
    scoop: stampScoop(readRel(SCOOP_TEMPLATE), { version, sha256, tarballUrl }),
  };
}

function sha256FromStampedFormula(text) {
  const m = text.match(/^\s*sha256\s+"([0-9a-f]{64})"/m);
  return m?.[1] ?? '';
}

function versionFromStampedFormula(text) {
  const m = text.match(/@vibgrate\/cli\/-\/cli-([0-9][^"]+)\.tgz/);
  return m?.[1] ?? '';
}

async function resolveInputs(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(name);
  // `--check` validates the committed tap/bucket copies against the
  // templates using the version+sha already in those copies (offline).
  // A pin/stamp lag after a CLI release is not a check failure — the
  // Packaging workflow refreshes the stamps once the npm tarball exists.
  let version = (arg('--version') ?? '').replace(/^v/, '').trim();
  if (!version && has('--check')) {
    version = versionFromStampedFormula(readRel(FORMULA_STAMPED));
  }
  if (!version) version = (pinnedCliVersion() ?? '').replace(/^v/, '').trim();
  if (!version) {
    throw new Error('stamp-packaging: no version (pass --version or set the chart appVersion pin).');
  }
  const tarballUrl = npmTarballUrl(version);
  let sha256 = (arg('--sha256') ?? '').trim();
  if (!sha256 && has('--check') && !has('--online')) {
    sha256 = sha256FromStampedFormula(readRel(FORMULA_STAMPED));
  }
  if (!sha256) sha256 = await sha256OfUrl(tarballUrl);
  return { version, sha256, tarballUrl };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (name) => argv.includes(name);

  const inputs = await resolveInputs(argv);
  const rendered = renderStamped(inputs);

  if (has('--check')) {
    const drift = [];
    if (readRel(FORMULA_STAMPED) !== rendered.formula) drift.push(FORMULA_STAMPED);
    if (readRel(SCOOP_STAMPED) !== rendered.scoop) drift.push(SCOOP_STAMPED);
    if (drift.length) {
      console.error(`Stamped packaging files are stale — run \`node scripts/stamp-packaging.mjs --version ${inputs.version}\`:\n  ${drift.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`Packaging stamps in sync at ${inputs.version} (sha256 ${inputs.sha256}).`);
    return;
  }

  if (has('--dry-run')) {
    console.log(`${FORMULA_STAMPED}: version ${inputs.version}, sha256 ${inputs.sha256}`);
    console.log(`${SCOOP_STAMPED}: version ${inputs.version}`);
    console.log(`tarball: ${inputs.tarballUrl}`);
    return;
  }

  writeRel(FORMULA_STAMPED, rendered.formula);
  writeRel(SCOOP_STAMPED, rendered.scoop);
  console.log(`Stamped ${inputs.version} (sha256 ${inputs.sha256}) into ${FORMULA_STAMPED} and ${SCOOP_STAMPED}.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
