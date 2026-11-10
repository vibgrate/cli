// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, readJsonFile, pathExists, FileCache } from '../utils/fs.js';
import { recordedSemver, splitBuildMetadata } from '../utils/recorded-semver.js';
import { withTimeout } from '../utils/timeout.js';
import { RubyGemsCache } from './rubygems-cache.js';
import { rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { loadGemfileLockIndex, type GemfileLockIndex } from './gemfile-lock.js';
import type { LockfileIo } from './npm-lockfile.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

/** Well-known Ruby frameworks / libraries to track */
const KNOWN_RUBY_FRAMEWORKS: Record<string, string> = {
  // ── Web Frameworks ──
  'rails': 'Ruby on Rails',
  'sinatra': 'Sinatra',
  'hanami': 'Hanami',
  'padrino': 'Padrino',
  'roda': 'Roda',
  'grape': 'Grape',
  'cuba': 'Cuba',
  'camping': 'Camping',
  'ramaze': 'Ramaze',

  // ── API & Serialization ──
  'jsonapi-resources': 'JSONAPI::Resources',
  'active_model_serializers': 'AMS',
  'blueprinter': 'Blueprinter',
  'alba': 'Alba',
  'grape-entity': 'Grape Entity',
  'jbuilder': 'Jbuilder',
  'graphql': 'GraphQL Ruby',

  // ── ORM & Database ──
  'activerecord': 'ActiveRecord',
  'sequel': 'Sequel',
  'rom-rb': 'ROM',
  'mongoid': 'Mongoid',
  'redis': 'redis-rb',
  'pg': 'pg (PostgreSQL)',
  'mysql2': 'mysql2',
  'sqlite3': 'sqlite3',

  // ── Background Jobs ──
  'sidekiq': 'Sidekiq',
  'resque': 'Resque',
  'delayed_job': 'Delayed Job',
  'good_job': 'GoodJob',
  'solid_queue': 'Solid Queue',
  'que': 'Que',

  // ── Testing ──
  'rspec': 'RSpec',
  'rspec-rails': 'RSpec Rails',
  'minitest': 'Minitest',
  'capybara': 'Capybara',
  'factory_bot': 'FactoryBot',
  'factory_bot_rails': 'FactoryBot Rails',
  'faker': 'Faker',
  'shoulda-matchers': 'Shoulda Matchers',
  'vcr': 'VCR',
  'webmock': 'WebMock',
  'simplecov': 'SimpleCov',
  'cucumber': 'Cucumber',

  // ── Authentication & Authorization ──
  'devise': 'Devise',
  'omniauth': 'OmniAuth',
  'pundit': 'Pundit',
  'cancancan': 'CanCanCan',
  'rodauth': 'Rodauth',
  'jwt': 'JWT',
  'doorkeeper': 'Doorkeeper',

  // ── Frontend & Assets ──
  'turbo-rails': 'Turbo',
  'stimulus-rails': 'Stimulus',
  'importmap-rails': 'Importmap Rails',
  'sprockets': 'Sprockets',
  'webpacker': 'Webpacker',
  'cssbundling-rails': 'CSS Bundling',
  'jsbundling-rails': 'JS Bundling',
  'tailwindcss-rails': 'Tailwind CSS Rails',
  'propshaft': 'Propshaft',

  // ── HTTP Clients ──
  'faraday': 'Faraday',
  'httparty': 'HTTParty',
  'rest-client': 'REST Client',
  'typhoeus': 'Typhoeus',
  'httpx': 'HTTPX',

  // ── Server ──
  'puma': 'Puma',
  'unicorn': 'Unicorn',
  'thin': 'Thin',
  'passenger': 'Passenger',
  'falcon': 'Falcon',

  // ── DevOps & Deployment ──
  'capistrano': 'Capistrano',
  'kamal': 'Kamal',
  'mina': 'Mina',

  // ── Monitoring & Logging ──
  'sentry-ruby': 'Sentry',
  'sentry-rails': 'Sentry Rails',
  'newrelic_rpm': 'New Relic',
  'datadog': 'Datadog',
  'lograge': 'Lograge',

  // ── Linting & Code Quality ──
  'rubocop': 'RuboCop',
  'rubocop-rails': 'RuboCop Rails',
  'rubocop-rspec': 'RuboCop RSpec',
  'rubocop-performance': 'RuboCop Performance',
  'brakeman': 'Brakeman',
  'bundler-audit': 'Bundler Audit',
  'standard': 'Standard',

  // ── Pagination & Search ──
  'kaminari': 'Kaminari',
  'pagy': 'Pagy',
  'ransack': 'Ransack',
  'searchkick': 'Searchkick',
  'elasticsearch-rails': 'Elasticsearch Rails',

  // ── File Uploads ──
  'carrierwave': 'CarrierWave',
  'shrine': 'Shrine',
  'active_storage': 'Active Storage',

  // ── Admin & CMS ──
  'activeadmin': 'ActiveAdmin',
  'administrate': 'Administrate',
  'avo': 'Avo',

  // ── State Machine ──
  'aasm': 'AASM',
  'statesman': 'Statesman',

  // ── Configuration & Environment ──
  'dotenv': 'dotenv',
  'figaro': 'Figaro',
};

// Latest Ruby major.minor is resolved at scan time — see runtime-baselines.ts

type RubyGemGroup = 'default' | 'development' | 'test';

interface RubyDependency {
  name: string;
  spec: string;
  /** Group: :default, :development, :test */
  group: RubyGemGroup;
}

/**
 * Bundler group symbols from a group list.
 *
 * `group :development, :test do` and `group [:development, :test] do`
 * both yield `['development', 'test']`. The same list text is what an
 * inline `group:` keyword carries (`group: :development` or
 * `group: [:development, :test]`). Callers decide how to classify it.
 */
function gemfileGroupSymbols(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/:(\w+)/g)) {
    names.push(match[1]!);
  }
  return names;
}

/**
 * A `group ... do` block is development or test only when every symbol is
 * `:development`, `:dev`, or `:test`. Any other symbol (`:default`,
 * `:production`, or a custom group) means the gems ship, so the block is
 * the production default.
 */
function classifyGemfileGroupBlock(names: string[]): RubyGemGroup {
  const lowered = names.map((name) => name.toLowerCase());
  const devOrTest = (name: string) => name === 'development' || name === 'dev' || name === 'test';
  if (lowered.length === 0 || !lowered.every(devOrTest)) return 'default';
  if (lowered.every((name) => name === 'test')) return 'test';
  return 'development';
}

/**
 * Quoted string arguments that follow a gem or dependency name, stopped at
 * the first argument that is not a string (`require:`, `group:`, a comment,
 * a symbol). Joined with `, ` so `">= 7.0", "< 8"` stays `>= 7.0, < 8`.
 * A line with no version string stays `*`.
 */
function quotedVersionConstraints(afterName: string): string {
  const constraints: string[] = [];
  let i = 0;
  while (i < afterName.length) {
    while (i < afterName.length && (afterName[i] === ' ' || afterName[i] === '\t' || afterName[i] === ',')) {
      i++;
    }
    if (i >= afterName.length) break;
    const quote = afterName[i];
    if (quote !== "'" && quote !== '"') break;
    i++;
    let value = '';
    let closed = false;
    while (i < afterName.length) {
      const ch = afterName[i]!;
      if (ch === '\\' && i + 1 < afterName.length) {
        value += afterName[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    if (!closed) break;
    const trimmed = value.trim();
    if (trimmed) constraints.push(trimmed);
  }
  return constraints.length > 0 ? constraints.join(', ') : '*';
}

/**
 * Parse a Gemfile line to extract gem name and version constraint.
 *
 * Handles:
 *   gem 'rails', '~> 7.1'
 *   gem 'pg', '>= 0.18', '< 2.0'
 *   gem "rails", ">= 7.0", "< 8"
 *   gem "pg", "~> 1.5", require: false
 *   gem "puma", "~> 6.0"
 *   gem 'sidekiq'
 *   gem 'rspec-rails', group: :development
 *   gem 'rspec-rails', groups: [:development, :test]
 */
function parseGemfileLine(line: string): { name: string; spec: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Match gem 'name' or gem "name", then every quoted constraint before a keyword.
  const match = trimmed.match(/^\s*gem\s+['"]([^'"]+)['"]/);
  if (!match) return null;

  const name = match[1]!;
  const spec = quotedVersionConstraints(trimmed.slice(match[0].length));

  return { name, spec };
}

/**
 * Extract pinned or minimum version from a Ruby version constraint.
 * Examples:
 *   '~> 7.1' → '7.1.0'
 *   '~> 7.1.3' → '7.1.3'
 *   '>= 3.0.0' → '3.0.0'
 *   '= 7.0.8' → '7.0.8'
 *   '2.0.0' → '2.0.0'
 * Returns null if no version can be extracted.
 */
function extractGemVersion(spec: string): string | null {
  if (spec === '*') return null;

  // Match version number after optional operator, including a `+build` suffix.
  const match = spec.match(/(?:~>|>=|>|=|<=|<)?\s*(\d+(?:\.\d+)*(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/);
  if (!match) return null;

  return match[1]!;
}

/**
 * Convert a Ruby gem version string to semver.
 */
function rubyVersionToSemver(ver: string): string | null {
  const { core, build } = splitBuildMetadata(ver.trim());
  if (/(?:\.pre|\.rc|\.beta|\.alpha|\.dev)/i.test(core)) return null;

  const parts = core.split('.');
  if (parts.length < 2) return null;
  while (parts.length < 3) parts.push('0');
  const semverStr = parts.slice(0, 3).join('.');
  return recordedSemver(build ? `${semverStr}${build}` : semverStr);
}

/**
 * Code of a Gemfile line with quoted strings and a trailing comment removed,
 * so a keyword check does not see text inside `'...'`, `"..."`, or `# ...`.
 */
function gemfileCode(trimmed: string): string {
  const noQuotes = trimmed.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  const hash = noQuotes.indexOf('#');
  return (hash === -1 ? noQuotes : noQuotes.slice(0, hash)).trim();
}

/**
 * A block closed by a later bare `end` that does not change the group:
 * a `do` opener (`platforms`, `install_if -> { ... } do`, `source ... do`)
 * or a statement-form `if` / `unless`. A modifier (`gem 'x' if cond`) does
 * not open a block. A same-line `end` closes the block here, so it takes
 * no stack frame. `:end` is a symbol, not the keyword.
 */
function opensNonGroupBlock(trimmed: string): boolean {
  const code = gemfileCode(trimmed);
  if (!code) return false;
  const closedHere = /(?:^|[\s;])end\s*$/.test(code) && !/:end\s*$/.test(code);
  if (closedHere) return false;
  if (/^(?:if|unless)\b/.test(code)) return true;
  return /\bdo\b/.test(code);
}

/**
 * Parse a Gemfile to extract dependencies.
 */
function parseGemfile(content: string): RubyDependency[] {
  const deps: RubyDependency[] = [];
  let currentGroup: RubyGemGroup = 'default';
  const groupStack: RubyGemGroup[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Track group blocks. Read every symbol on the line (`:a, :b` and
    // `[:a, :b]`). Nested `do` / `if` / `unless` blocks push the current
    // group unchanged so their `end` does not close the group.
    const groupHeader = trimmed.match(/^group\s+(.+)$/);
    const groupNames = groupHeader ? gemfileGroupSymbols(groupHeader[1]!) : [];
    if (groupNames.length > 0) {
      groupStack.push(currentGroup);
      currentGroup = classifyGemfileGroupBlock(groupNames);
    } else if (opensNonGroupBlock(trimmed)) {
      groupStack.push(currentGroup);
    }

    if (trimmed === 'end' && groupStack.length > 0) {
      currentGroup = groupStack.pop()!;
      continue;
    }

    const parsed = parseGemfileLine(trimmed);
    if (!parsed) continue;

    // Inline group. `group:` keeps the substring check. `groups:` (symbol or
    // array) is development/test only when every listed symbol is
    // :development, :dev, or :test; any other symbol is production.
    let group = currentGroup;
    const inlineGroupMatch = trimmed.match(/(groups?):\s*(?::(\w+)|\[([^\]]+)\])/);
    if (inlineGroupMatch) {
      const key = inlineGroupMatch[1]!;
      const symbol = inlineGroupMatch[2];
      const arrayBody = inlineGroupMatch[3];
      if (key === 'group') {
        const g = (symbol ?? arrayBody ?? '').toLowerCase();
        if (g.includes('development') || g.includes('dev')) group = 'development';
        else if (g.includes('test')) group = 'test';
      } else {
        const listed = symbol
          ? [symbol.toLowerCase()]
          : [...(arrayBody ?? '').matchAll(/:(\w+)/g)].map((match) => match[1]!.toLowerCase());
        const devOrTest = (name: string) =>
          name === 'development' || name === 'dev' || name === 'test';
        if (listed.length > 0 && listed.every(devOrTest)) {
          group = listed.every((name) => name === 'test') ? 'test' : 'development';
        } else if (listed.length > 0) {
          group = 'default';
        }
      }
    }

    deps.push({
      name: parsed.name,
      spec: parsed.spec,
      group,
    });
  }

  return deps;
}

/**
 * Parse a .gemspec file to extract dependencies.
 *
 * Handles:
 *   spec.add_dependency 'rails', '~> 7.1'
 *   spec.add_dependency "rack", ">= 2.2", "< 4"
 *   spec.add_development_dependency 'rspec', '~> 3.12'
 *   s.add_runtime_dependency "pg"
 */
function parseGemspec(content: string): RubyDependency[] {
  const deps: RubyDependency[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Match add_dependency, add_runtime_dependency, add_development_dependency,
    // then every quoted constraint before a non-string argument.
    const match = trimmed.match(
      /\.add_(runtime_|development_)?dependency\s+['"]([^'"]+)['"]/,
    );
    if (!match || match.index === undefined) continue;

    const depType = match[1] ?? 'runtime_';
    const name = match[2]!;
    const spec = quotedVersionConstraints(trimmed.slice(match.index + match[0].length));

    deps.push({
      name,
      spec,
      group: depType.startsWith('development') ? 'development' : 'default',
    });
  }

  return deps;
}

/**
 * Extract Ruby version from a Gemfile.
 *
 * Handles:
 *   ruby '3.2.2'
 *   ruby "3.3.0"
 *   ruby ">= 3.1"
 */
function extractRubyVersion(content: string): string | undefined {
  const match = content.match(/^\s*ruby\s+['"]([^'"]+)['"]/m);
  return match?.[1];
}

// ── Ruby project file names ──

const RUBY_MANIFEST_FILES = new Set([
  'Gemfile',
]);

/**
 * Check if a filename is a .gemspec file.
 */
function isGemspec(name: string): boolean {
  return name.endsWith('.gemspec');
}

/**
 * Discover and scan all Ruby projects in the workspace.
 */
export async function scanRubyProjects(
  rootDir: string,
  rubygemsCache: RubyGemsCache,
  cache?: FileCache,
  projectScanTimeout?: number,
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
): Promise<ProjectScan[]> {
  // Find Ruby manifest files (Gemfile and .gemspec)
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => RUBY_MANIFEST_FILES.has(name) || isGemspec(name))
    : await findRubyManifests(rootDir);

  // Group manifests by directory to form "projects"
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const [dir, files] of projectDirs) {
    try {
      const scanPromise = scanOneRubyProject(dir, files, rootDir, rubygemsCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Ruby project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      rethrowLockfileParseError(e);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Ruby project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findRubyManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => RUBY_MANIFEST_FILES.has(name) || isGemspec(name));
}

async function scanOneRubyProject(
  dir: string,
  manifestFiles: string[],
  rootDir: string,
  rubygemsCache: RubyGemsCache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  let projectName = path.basename(dir === rootDir ? rootDir : dir);
  let rubyVersion: string | undefined;
  const allDeps = new Map<string, RubyDependency>();

  // Parse each manifest file, preferring Gemfile > .gemspec
  for (const f of manifestFiles) {
    const fileName = path.basename(f);
    const content = cache ? await cache.readTextFile(f) : await readTextFile(f);

    if (fileName === 'Gemfile') {
      const parsedVersion = extractRubyVersion(content);
      if (parsedVersion) rubyVersion = parsedVersion;

      for (const dep of parseGemfile(content)) {
        if (!allDeps.has(dep.name)) allDeps.set(dep.name, dep);
      }
    } else if (isGemspec(fileName)) {
      // Use gemspec name as project name
      const gemName = fileName.replace(/\.gemspec$/, '');
      if (gemName) projectName = gemName;

      for (const dep of parseGemspec(content)) {
        if (!allDeps.has(dep.name)) allDeps.set(dep.name, dep);
      }
    }
  }

  // Determine Ruby runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;

  if (rubyVersion) {
    // Extract version number (e.g. "3.2.2" → { major: 3, minor: 2 }, ">= 3.1" → { major: 3, minor: 1 })
    const verMatch = rubyVersion.match(/(\d+)\.(\d+)/);
    if (verMatch) {
      const reqMajor = parseInt(verMatch[1]!, 10);
      const reqMinor = parseInt(verMatch[2]!, 10);
      const LATEST_RUBY_MINOR = latestStable(catalog, 'ruby');
      if (LATEST_RUBY_MINOR) {
        if (reqMajor === LATEST_RUBY_MINOR.major) {
          runtimeMajorsBehind = Math.max(0, LATEST_RUBY_MINOR.minor - reqMinor);
        } else if (reqMajor < LATEST_RUBY_MINOR.major) {
          runtimeMajorsBehind = LATEST_RUBY_MINOR.minor + (LATEST_RUBY_MINOR.major - reqMajor) * 10;
        }
        runtimeLatest = `${LATEST_RUBY_MINOR.major}.${LATEST_RUBY_MINOR.minor}`;
      }
    }
    runtimeEol = runtimeEolStatus(catalog, 'ruby', rubyVersion);
    const cycle = extractCycle('ruby', rubyVersion);
    if (cycle) runtimeEolDate = eolDate(catalog, 'ruby', cycle);
  }

  // Gemfile.lock pins the exact resolved version of every gem — more accurate than the declared
  // constraint and the only resolved version available offline. It sits beside the Gemfile.
  const lockIo: LockfileIo = {
    exists: (p) => (cache ? cache.pathExists(p) : pathExists(p)),
    readText: (p) => (cache ? cache.readTextFile(p) : readTextFile(p)),
    readJson: <T>(p: string) => (cache ? cache.readJsonFile<T>(p) : readJsonFile<T>(p)),
  };
  const lockIndex: GemfileLockIndex | null = await loadGemfileLockIndex(dir, lockIo).catch((err: unknown) => {
    rethrowLockfileParseError(err);
    return null;
  });

  // Resolve dependencies against RubyGems
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const depEntries = [...allDeps.values()];
  const metaPromises = depEntries.map(async (dep) => {
    const meta = await rubygemsCache.get(dep.name);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    // Prefer the lockfile's exact version; otherwise extract from the declared constraint.
    const locked = lockIndex?.resolve(dep.name) ?? null;
    const rawVersion = locked ?? extractGemVersion(dep.spec);
    const resolvedVersion = rawVersion ? rubyVersionToSemver(rawVersion) : null;
    const latestStable = meta.latestStableOverall;

    let majorsBehind: number | null = null;
    let drift: DependencyRow['drift'] = 'unknown';

    if (resolvedVersion && latestStable) {
      const currentMajor = semver.major(resolvedVersion);
      const latestMajor = semver.major(latestStable);
      majorsBehind = latestMajor - currentMajor;

      if (majorsBehind === 0) {
        drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
      } else if (majorsBehind > 0) {
        drift = 'major-behind';
      } else {
        drift = 'current'; // somehow ahead
      }

      if (majorsBehind <= 0) buckets.current++;
      else if (majorsBehind === 1) buckets.oneBehind++;
      else buckets.twoPlusBehind++;
    } else {
      buckets.unknown++;
    }

    const section = dep.group === 'development' || dep.group === 'test'
      ? 'devDependencies' as const
      : 'dependencies' as const;

    dependencies.push({
      package: dep.name,
      section,
      currentSpec: dep.spec,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    if (dep.name in KNOWN_RUBY_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_RUBY_FRAMEWORKS[dep.name]!,
        currentVersion: resolvedVersion,
        latestVersion: latestStable,
        majorsBehind,
      });
    }
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return compareCodeUnits(a.package, b.package);
  });

  // Count files (use cached walk to avoid redundant I/O)
  let fileCount: number | undefined;
  try {
    fileCount = cache
      ? await cache.countFilesUnder(rootDir, dir)
      : undefined;
  } catch { /* ignore */ }

  return {
    type: 'ruby',
    path: relDir,
    name: projectName,
    runtime: rubyVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
