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

// Directories never worth walking — dependency trees, build output, and
// VCS/IDE metadata. Kept aligned with the scanner's skip list (core-open
// `utils/fs.ts` SKIP_DIRS): the engine stays self-contained (no runtime
// import), and `test/discover-skips.test.ts` asserts this set covers the
// scanner's, so the graph can never index a package folder the scanner
// already decided is third-party.
//
// Exact names only. For prefix patterns (`.venv-*`, `venv-*`) and install
// trees (`site-packages`), use {@link isSkippedDirName}.
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
 * True when a directory basename must be pruned from discovery / scoring walks.
 * Covers exact {@link SKIP_DIRS} names plus common virtualenv naming variants
 * (`.venv-contextbench`, `venv-tools`, …) and Python install trees
 * (`site-packages`) that mint hundreds of phantom nested "projects".
 */
export function isSkippedDirName(name: string): boolean {
  if (!name) return false;
  if (SKIP_DIRS.has(name)) return true;
  // Custom-named virtualenvs (uv/poetry/team convention: `.venv-<purpose>`).
  if (name.startsWith('.venv') || name.startsWith('venv-')) return true;
  // Python install tree — never source we own.
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
    if (SKIP_FILES.has(path.basename(abs).toLowerCase())) return; // lockfiles etc.
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
        if (isSkippedDirName(entry.name)) continue;
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
