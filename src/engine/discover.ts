import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { langForExtension, langById, type LanguageDef } from './languages.js';
import { requireDataConfig } from '../core-open/config.js';
import { dropBlankPatterns, gitignoreWithoutBlankLines } from '../core-open/utils/glob.js';
import { assertLockfileFile, lockfileKind, LockfileParseError } from '../core-open/utils/lockfile-parse.js';
import { assertSafeWalkRoot, createWalkBudget, noteWalkEntry } from '../core-open/utils/root-safety.js';
import { emitSkippedSymlinkNotice } from '../core-open/utils/skipped-symlinks.js';

/**
 * Deterministic file discovery.
 *
 * Respects `.gitignore` (including nested ones), explicit config excludes, and a
 * built-in SKIP_DIRS set consistent with the scanner. Results are returned
 * sorted by relative POSIX path so the build is order-independent of the
 * filesystem.
 */

// Directories never worth walking — dependency trees, build output, and
// VCS/IDE metadata. Kept aligned with the scanner's skip list (core-open
// `utils/fs.ts` SKIP_DIRS): the engine stays self-contained (no runtime
// import), and `test/discover-skips.test.ts` asserts this set covers the
// scanner's, so the graph can never index a package folder the scanner
// already decided is third-party.
//
// Exact names only. Hidden directories (except {@link SCANNED_HIDDEN_DIRS})
// and prefix patterns (`venv-*`, `site-packages`) use {@link isSkippedDirName}.
export const SKIP_DIRS = new Set<string>([
  // Version control, IDE & tool metadata
  '.git', '.svn', '.hg',
  '.idea', '.vscode', '.vs',
  // Claude Code agent state / worktrees (full monorepo copies under .claude/worktrees/)
  '.claude',
  '.vibgrate', '.wrangler', '.turbo', '.cache',
  // Migration / tool backup trees (NativeScript, codemods, agent worktrees)
  '.migration_backup', '.update_backup', '.backup', '.bak',
  '.history', '.snapshots', '.snapshots_bak',
  // JavaScript / Node — installed dependency trees
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.pnpm-store', '.yarn',
  // JS/TS meta-framework & bundler build output
  '.next', '.nuxt', '.output', '.svelte-kit', '.astro',
  '.vercel', '.netlify', '.angular', '.parcel-cache', '.docusaurus',
  'storybook-static',
  // Generic build / dist / coverage output
  'dist', 'build', 'out', 'coverage',
  // Native mobile platform build trees (NativeScript / Cordova / Capacitor)
  'platforms', 'App_Resources',
  // Vendored third-party source trees
  'vendor', 'Pods', 'Carthage',
  // Python — virtualenvs & tool caches
  '.venv', 'venv', 'virtualenv', '.tox', '.nox',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.eggs', '.ipynb_checkpoints',
  // Ruby
  '.bundle',
  // Rust / Maven / sbt / Clojure — all build into target/
  'target',
  // JVM (Gradle / Maven) & .NET build output
  '.gradle', 'bin', 'obj', 'TestResults',
  // Swift / Xcode
  '.build', '.swiftpm', 'DerivedData',
  // Dart / Flutter
  '.dart_tool',
  // Elixir / Erlang
  '_build', 'deps',
  // Haskell (Cabal / Stack)
  'dist-newstyle', '.stack-work',
  // Infrastructure-as-code build/state
  '.terraform', '.serverless', 'cdk.out', '.aws-sam',
]);

/**
 * Hidden directories that still hold first-party metadata we walk
 * (CI workflows). Every other `.*` directory is agent/tool state
 * (Claude/Cursor/Codex/Grok worktrees, IDE metadata, caches) and
 * must never be scanned or indexed. Keep aligned with core-open
 * `utils/fs.ts` {@link SCANNED_HIDDEN_DIRS}.
 */
export const SCANNED_HIDDEN_DIRS = new Set(['.github', '.circleci']);

/**
 * True when a directory basename must be pruned from discovery / scoring walks.
 * Covers every hidden directory except {@link SCANNED_HIDDEN_DIRS}, exact
 * {@link SKIP_DIRS} names, custom virtualenv names (`venv-tools`, …), and
 * Python install trees (`site-packages`) that mint hundreds of phantom
 * nested "projects".
 */
export function isSkippedDirName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  // Agent worktrees live under hidden folders (.claude/worktrees, .cursor/…).
  // Skip every dot-directory so a new agent does not need a new skip entry.
  if (name.startsWith('.')) return !SCANNED_HIDDEN_DIRS.has(name);
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('venv-')) return true;
  if (name === 'site-packages') return true;
  return false;
}

// Lockfiles and generated dependency manifests — never hand-written source,
// and single files can run to many MB (a pnpm-lock.yaml, a Yarn PnP .pnp.cjs).
// Most carry extensions the graph doesn't parse anyway, but the ones that do
// (`.pnp.cjs` is JavaScript) would otherwise be indexed as huge phantom
// modules. Aligned with the scanner's SOURCE_EXCLUDE_FILES (core-open
// `utils/fs.ts`), enforced by `test/discover-skips.test.ts`. Matched
// case-insensitively against the basename; every entry must be lowercase.
export const SKIP_FILES = new Set<string>([
  // JavaScript / Node
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'deno.lock',
  '.pnp.cjs', '.pnp.data.json', '.pnp.loader.mjs',
  // Python
  'poetry.lock', 'pipfile.lock', 'pdm.lock', 'uv.lock',
  'pylock.toml', 'conda-lock.yml',
  // Ruby
  'gemfile.lock',
  // PHP
  'composer.lock',
  // Rust
  'cargo.lock',
  // Go
  'go.sum', 'go.work.sum', 'gopkg.lock', 'glide.lock',
  // .NET
  'packages.lock.json',
  // Java / JVM (Gradle)
  'gradle.lockfile',
  // Swift / Xcode
  'package.resolved',
  // Dart / Flutter
  'pubspec.lock',
  // Elixir
  'mix.lock',
  // Haskell (Cabal / Stack)
  'cabal.project.freeze', 'stack.yaml.lock',
  // Julia
  'manifest.toml',
  // R
  'renv.lock',
  // Perl (Carton)
  'cpanfile.snapshot',
  // CocoaPods / Carthage
  'podfile.lock', 'cartfile.resolved',
  // Terraform / IaC
  '.terraform.lock.hcl',
  // Helm
  'chart.lock',
  // C / C++ (Conan)
  'conan.lock',
  // Bazel
  'module.bazel.lock',
  // Nix
  'flake.lock',
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
  /**
   * Ceiling on files and directories visited. `0` disables.
   * Default: `VG_MAX_FILES`, else 100000.
   */
  maxEntries?: number;
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

/**
 * Project-local exclude globs from the project config (`.vibgrate/config.yml`
 * or `vibgrate.config.json`). `.ts`/`.js` configs stay scan-side (they can
 * execute). A missing file is an empty list. A data file that does not parse
 * throws — an unreadable config must not scan as if nothing were excluded.
 */
export function readConfigExcludes(root: string): string[] {
  const exclude = requireDataConfig(root).config?.exclude;
  if (!Array.isArray(exclude)) return [];
  return dropBlankPatterns(exclude.filter((x): x is string => typeof x === 'string'));
}

/** Config excludes plus caller extras, de-duplicated, config-first. Blank entries are dropped. */
export function mergeExcludes(root: string, extra?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of [...readConfigExcludes(root), ...dropBlankPatterns(extra ?? [])]) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/**
 * Ignore matcher for a repo root: `.gitignore` plus extra exclude globs.
 * Blank lines and blank excludes are omitted. A newline- or CR-only rule
 * matches every path, which would skip the whole tree.
 */
export function loadRootIgnore(root: string, exclude: string[]): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(root, '.gitignore');
  try {
    if (fs.existsSync(gitignorePath)) {
      const rules = gitignoreWithoutBlankLines(fs.readFileSync(gitignorePath, 'utf8'));
      if (rules) ig.add(rules);
    }
  } catch {
    // Unreadable .gitignore: walk the tree rather than fail the build.
  }
  const patterns = dropBlankPatterns(exclude);
  if (patterns.length) ig.add(patterns);
  return ig;
}

interface ProjectWalk {
  root: string;
  exclude?: string[];
  paths?: string[];
  maxEntries?: number;
  /** Source files to keep. Omit when the caller only validates lockfiles. */
  found?: Map<string, DiscoveredFile>;
  allowLang?: (lang: LanguageDef) => boolean;
  /**
   * Symlinks this walk skipped. Omit to stay quiet — `vg scan` validates
   * lockfiles before the file walk that prints the one notice.
   */
  skippedSymlinks?: string[];
}

/**
 * The invalid lockfile whose path sorts first. Directory entries are sorted
 * before the walk, and this pick does not depend on which of two bad files
 * `readdir` returned first.
 */
function firstLockfileError(errors: readonly LockfileParseError[]): LockfileParseError | undefined {
  if (errors.length === 0) return undefined;
  return [...errors].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))[0];
}

/**
 * Walk a project the way {@link discover} does. Lockfiles are syntax-checked
 * here, on this thread, before any source parse worker exists. A truncated
 * file is recorded and the walk continues so the reported path is stable.
 */
function walkProject(options: ProjectWalk): LockfileParseError[] {
  const root = path.resolve(options.root);
  const rootIg = loadRootIgnore(root, options.exclude ?? []);
  const allowLang = options.allowLang ?? ((): boolean => true);
  const found = options.found;
  const skippedSymlinks = options.skippedSymlinks;
  const lockfileErrors: LockfileParseError[] = [];
  const budget = createWalkBudget(root, options.maxEntries);

  const scopeAbs = (options.paths && options.paths.length
    ? options.paths.map((p) => path.resolve(root, p))
    : [root]
  ).filter((p) => fs.existsSync(p));

  const considerFile = (abs: string): void => {
    const rel = toPosix(path.relative(root, abs));
    if (rel.startsWith('..')) return; // outside root
    if (rel === '' || rootIg.ignores(rel)) return;
    if (SKIP_FILES.has(path.basename(abs).toLowerCase())) {
      // Lockfiles are not source. A truncated one must fail the command
      // rather than be skipped into an empty dependency graph.
      if (lockfileKind(path.basename(abs))) {
        try {
          assertLockfileFile(abs);
        } catch (err) {
          if (err instanceof LockfileParseError) {
            lockfileErrors.push(err);
            return;
          }
          throw err;
        }
      }
      return;
    }
    if (!found) return;
    const lang = langForExtension(path.extname(abs));
    if (!lang || !allowLang(lang)) return;
    found.set(rel, { rel, abs, lang });
  };

  const note = (): void => {
    const over = noteWalkEntry(budget);
    if (!over) return;
    // A lockfile we already know is bad is the error to show. The budget
    // still stops a walk that has not seen one.
    const lockfileError = firstLockfileError(lockfileErrors);
    if (lockfileError) throw lockfileError;
    throw over;
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the build
    }
    // Sorted so two invalid lockfiles always surface the same path.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isSymbolicLink()) {
        if (rel && (rootIg.ignores(rel) || rootIg.ignores(`${rel}/`))) continue;
        if (rel && skippedSymlinks) skippedSymlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (isSkippedDirName(entry.name)) continue;
        if (rel && rootIg.ignores(`${rel}/`)) continue;
        note();
        walk(abs);
      } else if (entry.isFile()) {
        if (rel && rootIg.ignores(rel)) continue;
        note();
        considerFile(abs);
      }
    }
  };

  for (const scope of scopeAbs) {
    const stat = fs.statSync(scope);
    if (stat.isDirectory()) {
      assertSafeWalkRoot(scope);
      walk(scope);
    } else if (stat.isFile()) considerFile(scope);
  }

  return lockfileErrors;
}

export function discover(options: DiscoverOptions): DiscoveredFile[] {
  const onlyLangs = (options.only ?? []).filter(Boolean);
  const allowLang = (lang: LanguageDef): boolean =>
    onlyLangs.length === 0 || onlyLangs.includes(lang.id);

  // Validate `--only` ids early so a typo is a usage error, not silent emptiness.
  for (const id of onlyLangs) {
    if (!langById(id)) {
      throw new UsageError(`unknown language "${id}" for --only`);
    }
  }

  const found = new Map<string, DiscoveredFile>();
  // Symlinks are not followed. Dirent.isDirectory() / isFile() are false for a
  // link, so a directory link to its parent cannot re-enter this walk. The
  // notice lists the ones this walk skipped; ignored links stay quiet.
  const skippedSymlinks: string[] = [];
  const lockfileError = firstLockfileError(walkProject({
    root: options.root,
    exclude: options.exclude,
    paths: options.paths,
    maxEntries: options.maxEntries,
    found,
    allowLang,
    skippedSymlinks,
  }));
  // Before the symlink notice, and before the caller starts parse workers.
  if (lockfileError) throw lockfileError;
  emitSkippedSymlinkNotice(skippedSymlinks);
  return [...found.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Fail when any in-scope lockfile is truncated or invalid. Same skip and
 * ignore rules as {@link discover}. Does not print the symlink notice and
 * does not start parse workers. `vg scan` calls this before drift scoring.
 */
export function assertDiscoveredLockfiles(
  options: Pick<DiscoverOptions, 'root' | 'exclude' | 'paths' | 'maxEntries'>,
): void {
  const lockfileError = firstLockfileError(walkProject({
    root: options.root,
    exclude: options.exclude,
    paths: options.paths,
    maxEntries: options.maxEntries,
  }));
  if (lockfileError) throw lockfileError;
}

/** A usage error that maps to exit code 5 at the CLI boundary. */
export class UsageError extends Error {
  readonly isUsageError = true;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
