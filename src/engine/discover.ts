import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { langForExtension, langById, type LanguageDef } from './languages.js';

/**
 * Deterministic file discovery.
 *
 * Respects `.gitignore` (including nested ones), explicit config excludes, and a
 * built-in SKIP_DIRS set consistent with the scanner. Results are returned
 * sorted by relative POSIX path so the build is order-independent of the
 * filesystem.
 */

// Directories never worth walking. Kept in sync conceptually with the scanner's
// skip list; this engine is self-contained so we don't import it.
export const SKIP_DIRS = new Set<string>([
  '.git',
  'node_modules',
  '.vibgrate',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor',
  'target', // rust / java
  'bin',
  'obj', // .NET
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
]);

export interface DiscoverOptions {
  /** Absolute root directory. */
  root: string;
  /** Restrict to these language ids (e.g. ['ts','py']). Empty = all. */
  only?: string[];
  /** Additional ignore globs (gitignore syntax), e.g. from config `exclude`. */
  exclude?: string[];
  /** Explicit sub-paths to scope to (relative or absolute). */
  paths?: string[];
}

export interface DiscoveredFile {
  /** Relative POSIX path from root. */
  rel: string;
  /** Absolute path. */
  abs: string;
  lang: LanguageDef;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Build the ignore matcher from the repo's .gitignore plus extra excludes. */
function buildRootIgnore(root: string, exclude: string[]): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }
  if (exclude.length) ig.add(exclude);
  return ig;
}

export function discover(options: DiscoverOptions): DiscoveredFile[] {
  const root = path.resolve(options.root);
  const onlyLangs = (options.only ?? []).filter(Boolean);
  const allowLang = (lang: LanguageDef): boolean =>
    onlyLangs.length === 0 || onlyLangs.includes(lang.id);

  // Validate `--only` ids early so a typo is a usage error, not silent emptiness.
  for (const id of onlyLangs) {
    if (!langById(id)) {
      throw new UsageError(`unknown language "${id}" for --only`);
    }
  }

  const rootIg = buildRootIgnore(root, options.exclude ?? []);

  // Scope roots: explicit paths, or the whole repo.
  const scopeAbs = (options.paths && options.paths.length
    ? options.paths.map((p) => path.resolve(root, p))
    : [root]
  ).filter((p) => fs.existsSync(p));

  const found = new Map<string, DiscoveredFile>();

  const considerFile = (abs: string): void => {
    const rel = toPosix(path.relative(root, abs));
    if (rel.startsWith('..')) return; // outside root
    if (rel === '' || rootIg.ignores(rel)) return;
    const lang = langForExtension(path.extname(abs));
    if (!lang || !allowLang(lang)) return;
    found.set(rel, { rel, abs, lang });
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the build
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (rel && rootIg.ignores(`${rel}/`)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        considerFile(abs);
      }
    }
  };

  for (const scope of scopeAbs) {
    const stat = fs.statSync(scope);
    if (stat.isDirectory()) walk(scope);
    else if (stat.isFile()) considerFile(scope);
  }

  return [...found.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** A usage error that maps to exit code 5 at the CLI boundary. */
export class UsageError extends Error {
  readonly isUsageError = true;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
