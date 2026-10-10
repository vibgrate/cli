import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { assertSafeWalkRoot } from '../core-open/utils/root-safety.js';
import { isSkippedDirName, SKIP_FILES } from './discover.js';

/**
 * Stop `vg scan` / `vg build` when a lockfile is truncated or not valid
 * syntax. Readers that swallow a parse error keep going and can emit a
 * partial dependency graph (or look successful with nothing resolved). This
 * check runs before source parse workers start, so a bad file never leaves
 * workers running and never reaches graph construction.
 *
 * The message names the lockfile and says to regenerate it. Parser errors are
 * discarded: they quote the source, and a lockfile must not be echoed back.
 */

const MESSAGE_SUFFIX = 'truncated or not valid syntax. Regenerate it with your package manager.';

/** Generated JavaScript bundles, not lock documents. */
const SKIP_VALIDATION = new Set(['.pnp.cjs', '.pnp.loader.mjs']);

const JSON_LOCKS = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'composer.lock',
  'packages.lock.json',
  'package.resolved',
  'pipfile.lock',
  'bun.lock',
  'deno.lock',
  '.pnp.data.json',
  'renv.lock',
  'flake.lock',
  'conan.lock',
  'module.bazel.lock',
]);

const YAML_LOCKS = new Set([
  'pnpm-lock.yaml',
  'pubspec.lock',
  'conda-lock.yml',
  'chart.lock',
  'stack.yaml.lock',
  'glide.lock',
]);

const TOML_LOCKS = new Set([
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'cargo.lock',
  'pylock.toml',
  'gopkg.lock',
  'manifest.toml',
]);

const BINARY_LOCKS = new Set(['bun.lockb']);

export class LockfileSyntaxError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(`invalid lockfile ${paths.join(', ')}: ${MESSAGE_SUFFIX}`);
    this.name = 'LockfileSyntaxError';
    this.paths = paths;
  }
}

/** Throw {@link LockfileSyntaxError} when any lockfile under `root` is unusable. */
export function assertLockfilesValid(root: string): void {
  const abs = path.resolve(root);
  assertSafeWalkRoot(abs);
  const bad = findLockfiles(abs).filter((rel) => !lockfileFileValid(abs, rel));
  if (bad.length) throw new LockfileSyntaxError(bad);
}

function findLockfiles(root: string): string[] {
  const ig = ignore();
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch {
      // Unreadable ignore file: still walk, and skip the usual dependency dirs.
    }
  }

  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (entry.name === '.' || entry.name === '..') continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (!rel || rel.startsWith('..')) continue;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
        // Directory links can cycle. A linked lockfile is still read.
        if (isDir) continue;
      }
      if (isDir) {
        if (isSkippedDirName(entry.name)) continue;
        if (ig.ignores(`${rel}/`)) continue;
        walk(abs);
        continue;
      }
      if (!isFile) continue;
      if (ig.ignores(rel)) continue;
      const base = entry.name.toLowerCase();
      if (!SKIP_FILES.has(base) || SKIP_VALIDATION.has(base)) continue;
      found.push(rel);
    }
  };

  walk(root);
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return found;
}

function lockfileFileValid(root: string, rel: string): boolean {
  const abs = path.join(root, rel);
  const base = path.posix.basename(rel).toLowerCase();
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    // Unreadable: nothing was parsed, so there is no partial graph to stop.
    return true;
  }
  if (BINARY_LOCKS.has(base)) return buf.length > 0;
  return !lockfileTextInvalid(base, stripBom(buf.toString('utf8')));
}

function lockfileTextInvalid(basename: string, text: string): boolean {
  if (JSON_LOCKS.has(basename)) return jsonLockInvalid(text);
  if (YAML_LOCKS.has(basename)) return yamlLockInvalid(text);
  if (TOML_LOCKS.has(basename)) return tomlLockInvalid(text);
  if (basename === 'yarn.lock') return yarnInvalid(text);
  if (basename === 'go.sum' || basename === 'go.work.sum') return goSumInvalid(text);
  if (basename === 'gradle.lockfile') return gradleInvalid(text);
  if (basename === 'gemfile.lock') return gemfileInvalid(text);
  return structuralInvalid(text);
}

function jsonLockInvalid(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const doc: unknown = JSON.parse(text);
    return !isRecord(doc);
  } catch {
    return true;
  }
}

function yamlLockInvalid(text: string): boolean {
  if (!text.trim()) return true;
  try {
    return !isRecord(parseYaml(text));
  } catch {
    return true;
  }
}

function tomlLockInvalid(text: string): boolean {
  if (!text.trim()) return true;
  try {
    return !isRecord(parseToml(text));
  } catch {
    return true;
  }
}

/** Classic and Berry yarn.lock. A block that never reaches `version` is cut off. */
function yarnInvalid(text: string): boolean {
  if (!text.trim()) return true;
  if (unbalancedDoubleQuotes(text)) return true;
  let open = false;
  let sawVersion = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      if (open && !sawVersion) return true;
      if (!line.trimEnd().endsWith(':')) return true;
      open = true;
      sawVersion = false;
      continue;
    }
    if (!open) return true;
    if (/^\s+version:?\s+\S/.test(line)) sawVersion = true;
  }
  return open && !sawVersion;
}

/** `go.sum` / `go.work.sum`. Empty is a module with no dependencies. */
function goSumInvalid(text: string): boolean {
  if (!text.trim()) return false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    if (!/^\S+\s+\S+\s+h1:\S+$/.test(line)) return true;
  }
  return false;
}

function gradleInvalid(text: string): boolean {
  if (!text.trim()) return true;
  let sawEntry = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('empty=')) {
      sawEntry = true;
      continue;
    }
    if (!/^[^:=\s#][^:=\s]*:[^:=\s]+:[^=\s]+=\S+/.test(line)) return true;
    sawEntry = true;
  }
  return !sawEntry;
}

function gemfileInvalid(text: string): boolean {
  if (!text.trim()) return true;
  if (unbalancedDelimiters(text)) return true;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^ {4}\S/.test(line) && !/^ {4}[A-Za-z0-9._-]+ \([^()]+\)$/.test(line.trimEnd())) return true;
  }
  return false;
}

function structuralInvalid(text: string): boolean {
  if (!text.trim()) return true;
  return unbalancedDelimiters(text);
}

function unbalancedDoubleQuotes(text: string): boolean {
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') open = !open;
  }
  return open;
}

function unbalancedDelimiters(text: string): boolean {
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    if (brace < 0 || bracket < 0 || paren < 0) return true;
  }
  return quote || brace !== 0 || bracket !== 0 || paren !== 0;
}

function isRecord(doc: unknown): doc is Record<string, unknown> {
  return !!doc && typeof doc === 'object' && !Array.isArray(doc);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
