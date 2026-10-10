// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Fail closed on a lockfile that is truncated or syntactically invalid.
 *
 * A mid-file cut (editor crash, partial CI artifact) must not become an empty
 * success or a graph built from whatever prefixes happened to parse. Callers
 * surface {@link LockfileParseError} and exit non-zero. The message names the
 * file and what to do; it never includes file contents, because lockfiles can
 * carry registry tokens.
 *
 * Parsing stays on the caller thread. A bad lockfile is rejected before the
 * source parse pool starts, so the failure cannot leave a worker behind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseAllDocuments } from 'yaml';
import { inspectUtf8 } from './text-bytes.js';

export type LockfileKind =
  | 'JSON'
  | 'YAML'
  | 'TOML'
  | 'yarn.lock'
  | 'go.sum'
  | 'gradle.lockfile'
  | 'Gemfile.lock';

const KIND_BY_BASENAME: Readonly<Record<string, LockfileKind>> = {
  'package-lock.json': 'JSON',
  'npm-shrinkwrap.json': 'JSON',
  'composer.lock': 'JSON',
  'packages.lock.json': 'JSON',
  'package.resolved': 'JSON',
  'pipfile.lock': 'JSON',
  'pnpm-lock.yaml': 'YAML',
  'pubspec.lock': 'YAML',
  'poetry.lock': 'TOML',
  'uv.lock': 'TOML',
  'pdm.lock': 'TOML',
  'cargo.lock': 'TOML',
  'yarn.lock': 'yarn.lock',
  'go.sum': 'go.sum',
  'gradle.lockfile': 'gradle.lockfile',
  'gemfile.lock': 'Gemfile.lock',
};

/** Kind we know how to syntax-check, or undefined for lockfiles we do not parse. */
export function lockfileKind(basename: string): LockfileKind | undefined {
  return KIND_BY_BASENAME[basename.toLowerCase()];
}

/**
 * Actionable, content-free lockfile failure. `kind` is a format name
 * (`JSON`, `YAML`, …) or `unreadable` when the file could not be opened.
 */
export class LockfileParseError extends Error {
  readonly filePath: string;
  readonly kind: string;

  constructor(filePath: string, kind: string) {
    const detail =
      kind === 'unreadable'
        ? 'could not be read'
        : kind === 'binary'
          ? 'is binary or not UTF-8'
          : `is truncated or invalid ${kind}`;
    const action =
      kind === 'unreadable'
        ? 'Check that the file is accessible, then re-run the command.'
        : kind === 'binary'
          ? 'Leave it out with a .gitignore entry or pass --exclude, or replace it with a text lockfile, then re-run the command.'
          : 'Restore or regenerate the file with your package manager, then re-run the command.';
    super(`${filePath}: lockfile ${detail}. ${action}`);
    this.name = 'LockfileParseError';
    this.filePath = filePath;
    this.kind = kind;
  }
}

/** Re-throw a lockfile failure so a best-effort `catch` cannot turn it into an empty graph. */
export function rethrowLockfileParseError(err: unknown): void {
  if (err instanceof LockfileParseError) throw err;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse JSON lockfile text. Throws {@link LockfileParseError}; never echoes the source. */
export function parseLockfileJson(filePath: string, text: string): unknown {
  const body = stripBom(text);
  if (!body.trim()) throw new LockfileParseError(filePath, 'JSON');
  try {
    return JSON.parse(body);
  } catch {
    throw new LockfileParseError(filePath, 'JSON');
  }
}

/**
 * Reject truncated or invalid lockfile text. A missing file is the caller's
 * concern (absence is not an error); this only runs on bytes that were read.
 */
export function assertLockfileText(filePath: string, text: string, kind: LockfileKind): void {
  // A NUL survived a lossy decode. Reject before a parser can quote the bytes.
  if (text.includes('\u0000')) throw new LockfileParseError(filePath, 'binary');
  switch (kind) {
    case 'JSON':
      parseLockfileJson(filePath, text);
      return;
    case 'YAML':
      assertYaml(filePath, text);
      return;
    case 'TOML':
      assertToml(filePath, text);
      return;
    case 'yarn.lock':
      assertYarn(filePath, text);
      return;
    case 'go.sum':
      assertGoSum(filePath, text);
      return;
    case 'gradle.lockfile':
      assertGradle(filePath, text);
      return;
    case 'Gemfile.lock':
      assertGemfile(filePath, text);
      return;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Syntax-check a lockfile on disk when its basename is one we parse.
 * `ENOENT` is ignored (the file disappeared between listing and reading).
 * Other read failures and bad syntax throw {@link LockfileParseError}.
 */
export function assertLockfileFile(filePath: string): void {
  const kind = lockfileKind(path.basename(filePath));
  if (!kind) return;
  let text: string;
  try {
    const inspected = inspectUtf8(fs.readFileSync(filePath));
    if (!inspected.ok) throw new LockfileParseError(filePath, 'binary');
    text = inspected.text;
  } catch (err) {
    if (err instanceof LockfileParseError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new LockfileParseError(filePath, 'unreadable');
  }
  assertLockfileText(filePath, text, kind);
}

function assertYaml(filePath: string, text: string): void {
  if (!stripBom(text).trim()) throw new LockfileParseError(filePath, 'YAML');
  let docs: Array<{ errors: unknown[] }>;
  try {
    docs = parseAllDocuments(stripBom(text), { logLevel: 'silent', uniqueKeys: false });
  } catch {
    throw new LockfileParseError(filePath, 'YAML');
  }
  if (docs.some((doc) => doc.errors.length > 0)) throw new LockfileParseError(filePath, 'YAML');
}

function assertToml(filePath: string, text: string): void {
  const body = stripBom(text);
  if (!body.trim()) throw new LockfileParseError(filePath, 'TOML');
  try {
    const doc = parseToml(body);
    if (!doc || typeof doc !== 'object') throw new LockfileParseError(filePath, 'TOML');
  } catch (err) {
    if (err instanceof LockfileParseError) throw err;
    throw new LockfileParseError(filePath, 'TOML');
  }
}

function assertYarn(filePath: string, text: string): void {
  if (!text.trim()) throw new LockfileParseError(filePath, 'yarn.lock');
  // Yarn Berry lockfiles are YAML. Classic (v1) is a custom text format.
  const head = text.split('\n').slice(0, 40).join('\n');
  if (/^__metadata:\s*$/m.test(head)) {
    assertYaml(filePath, text);
    return;
  }
  let pendingHeader = false;
  for (const raw of text.split('\n')) {
    if (unbalancedQuotes(raw)) throw new LockfileParseError(filePath, 'yarn.lock');
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      if (!/:\s*$/.test(raw)) throw new LockfileParseError(filePath, 'yarn.lock');
      pendingHeader = true;
      continue;
    }
    if (pendingHeader && /^\s+version:?\s+\S/.test(raw)) pendingHeader = false;
  }
  if (pendingHeader) throw new LockfileParseError(filePath, 'yarn.lock');
}

function assertGoSum(filePath: string, text: string): void {
  if (!text.trim()) throw new LockfileParseError(filePath, 'go.sum');
  const lineRe = /^\S+\s+v\S+\s+h1:\S+$/;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!lineRe.test(line)) throw new LockfileParseError(filePath, 'go.sum');
  }
}

function assertGradle(filePath: string, text: string): void {
  if (!text.trim()) throw new LockfileParseError(filePath, 'gradle.lockfile');
  const lineRe = /^[^:=\s]+:[^:=\s]+:[^=\s]+=/;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('empty=')) continue;
    if (!lineRe.test(line)) throw new LockfileParseError(filePath, 'gradle.lockfile');
  }
}

function assertGemfile(filePath: string, text: string): void {
  if (!text.trim()) throw new LockfileParseError(filePath, 'Gemfile.lock');
  for (const raw of text.split('\n')) {
    if (unbalancedQuotes(raw) || countChar(raw, '(') !== countChar(raw, ')')) {
      throw new LockfileParseError(filePath, 'Gemfile.lock');
    }
  }
}

function unbalancedQuotes(line: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}

function countChar(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}
