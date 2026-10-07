/**
 * Unknown optional lockfile fields.
 *
 * A key this tool does not model, on a lockfile that already resolves a
 * dependency set, must not discard that set. The warning names the key and
 * the lockfile's root-relative path. It never includes a value, so a registry
 * token, an environment variable, or an authorization header stored in the
 * file cannot leak. At most one warning is emitted per file per key name,
 * in sorted order.
 *
 * Line-oriented lockfiles with no optional-key slot (`go.sum`,
 * `gradle.lockfile`) are not warned here. A line that is not valid for that
 * dialect fails closed in the syntax check before this runs.
 */
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/** Field names we will print. Anything else is omitted rather than echoed. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,64}$/;

const seenContent = new Set<string>();
const emittedKeys = new Set<string>();

function setOf(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function ownKeys(value: unknown): string[] {
  const rec = asRecord(value);
  return rec ? Object.keys(rec) : [];
}

function addUnknown(keys: readonly string[], known: ReadonlySet<string>, into: Set<string>): void {
  for (const key of keys) {
    if (!known.has(key) && SAFE_KEY.test(key)) into.add(key);
  }
}

function sorted(keys: Set<string>): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseYamlDoc(text: string): unknown {
  try {
    return parseYaml(text, { uniqueKeys: false, logLevel: 'silent' });
  } catch {
    return undefined;
  }
}

function parseTomlDoc(text: string): Record<string, unknown> | undefined {
  try {
    const doc = parseToml(text);
    return asRecord(doc);
  } catch {
    return undefined;
  }
}

// ── npm package-lock / npm-shrinkwrap ────────────────────────────────────────

const NPM_ROOT = setOf(['name', 'version', 'lockfileVersion', 'requires', 'packages', 'dependencies']);
const NPM_ENTRY = setOf([
  'name',
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bin',
  'license',
  'engines',
  'funding',
  'os',
  'cpu',
  'libc',
  'resolved',
  'integrity',
  'link',
  'dev',
  'optional',
  'devOptional',
  'inBundle',
  'hasInstallScript',
  'hasShrinkwrap',
  'extraneous',
  'deprecated',
  'workspaces',
  'requires',
  'bundled',
  'from',
  'peer',
  'overrides',
]);

function npmEntryHasVersion(entry: unknown): boolean {
  const rec = asRecord(entry);
  return typeof rec?.version === 'string' && rec.version.length > 0;
}

function npmTreeHas(deps: unknown): boolean {
  const rec = asRecord(deps);
  if (!rec) return false;
  for (const entry of Object.values(rec)) {
    if (npmEntryHasVersion(entry)) return true;
    if (npmTreeHas(asRecord(entry)?.dependencies)) return true;
  }
  return false;
}

function walkNpmEntry(entry: unknown, into: Set<string>): void {
  addUnknown(ownKeys(entry), NPM_ENTRY, into);
  const nested = asRecord(entry)?.dependencies;
  const rec = asRecord(nested);
  if (!rec) return;
  for (const child of Object.values(rec)) {
    if (asRecord(child)) walkNpmEntry(child, into);
  }
}

function npmKeys(text: string): string[] {
  const root = asRecord(parseJson(text));
  if (!root) return [];
  const packages = asRecord(root.packages);
  let usable = false;
  if (packages) {
    for (const [key, entry] of Object.entries(packages)) {
      if (key && npmEntryHasVersion(entry)) usable = true;
    }
  }
  if (!usable && npmTreeHas(root.dependencies)) usable = true;
  if (!usable) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(root), NPM_ROOT, into);
  if (packages) {
    for (const entry of Object.values(packages)) walkNpmEntry(entry, into);
  }
  if (asRecord(root.dependencies)) walkNpmEntry({ dependencies: root.dependencies }, into);
  return sorted(into);
}

// ── pnpm-lock.yaml ───────────────────────────────────────────────────────────

const PNPM_ROOT = setOf([
  'lockfileVersion',
  'settings',
  'importers',
  'packages',
  'snapshots',
  'time',
  'neverBuiltDependencies',
  'onlyBuiltDependencies',
  'overrides',
  'packageExtensionsChecksum',
  'patchedDependencies',
  'pnpmfileChecksum',
  'ignoredOptionalDependencies',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'specifiers',
]);
const PNPM_SETTINGS = setOf([
  'autoInstallPeers',
  'excludeLinksFromLockfile',
  'peersSuffixMaxLength',
  'injectWorkspacePackages',
]);
const PNPM_PACKAGE = setOf([
  'resolution',
  'engines',
  'cpu',
  'os',
  'libc',
  'deprecated',
  'hasBin',
  'optional',
  'dev',
  'requiresBuild',
  'prepare',
  'patched',
  'id',
  'name',
  'version',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'transitivePeerDependencies',
  'bundledDependencies',
]);
const PNPM_SNAPSHOT = setOf([
  'dependencies',
  'optionalDependencies',
  'transitivePeerDependencies',
  'optional',
  'dev',
  'id',
  'patched',
]);
const PNPM_IMPORTER = setOf([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'dependenciesMeta',
  'optionalDependenciesMeta',
  'specifiers',
]);
const PNPM_DEP = setOf(['specifier', 'version']);
const PNPM_DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function pnpmDepSectionHas(section: unknown): boolean {
  const deps = asRecord(section);
  if (!deps) return false;
  for (const dep of Object.values(deps)) {
    if (typeof dep === 'string' && dep.length > 0) return true;
    const rec = asRecord(dep);
    if (typeof rec?.version === 'string' && rec.version.length > 0) return true;
  }
  return false;
}

function notePnpmDepSection(section: unknown, into: Set<string>): void {
  const deps = asRecord(section);
  if (!deps) return;
  for (const dep of Object.values(deps)) addUnknown(ownKeys(dep), PNPM_DEP, into);
}

function pnpmKeys(text: string): string[] {
  const root = asRecord(parseYamlDoc(text));
  if (!root) return [];
  const packages = asRecord(root.packages);
  const snapshots = asRecord(root.snapshots);
  const importers = asRecord(root.importers);
  let usable = Boolean(packages && Object.keys(packages).length > 0);
  if (!usable && snapshots && Object.keys(snapshots).length > 0) usable = true;
  if (!usable && importers) {
    for (const imp of Object.values(importers)) {
      const rec = asRecord(imp);
      if (!rec) continue;
      if (PNPM_DEP_SECTIONS.some((section) => pnpmDepSectionHas(rec[section]))) usable = true;
    }
  }
  if (!usable && PNPM_DEP_SECTIONS.some((section) => pnpmDepSectionHas(root[section]))) usable = true;
  if (!usable) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(root), PNPM_ROOT, into);
  addUnknown(ownKeys(root.settings), PNPM_SETTINGS, into);
  if (packages) {
    for (const entry of Object.values(packages)) addUnknown(ownKeys(entry), PNPM_PACKAGE, into);
  }
  if (snapshots) {
    for (const entry of Object.values(snapshots)) addUnknown(ownKeys(entry), PNPM_SNAPSHOT, into);
  }
  if (importers) {
    for (const imp of Object.values(importers)) {
      addUnknown(ownKeys(imp), PNPM_IMPORTER, into);
      const rec = asRecord(imp);
      if (!rec) continue;
      for (const section of PNPM_DEP_SECTIONS) notePnpmDepSection(rec[section], into);
    }
  }
  for (const section of PNPM_DEP_SECTIONS) notePnpmDepSection(root[section], into);
  return sorted(into);
}

// ── yarn.lock ────────────────────────────────────────────────────────────────

const YARN_FIELDS = setOf([
  'version',
  'resolved',
  'integrity',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'dependenciesMeta',
  'peerDependenciesMeta',
  'checksum',
  'languageName',
  'linkType',
  'bin',
  'conditions',
  'resolution',
  'cacheKey',
]);

function yarnKeys(text: string): string[] {
  let descriptor = false;
  let version = false;
  const into = new Set<string>();
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      if (raw.includes('@')) descriptor = true;
      continue;
    }
    const field = /^ {2}([A-Za-z_][A-Za-z0-9_-]*)\b/.exec(raw);
    if (!field) continue;
    if (field[1] === 'version' && /^ {2}version:?\s+\S/.test(raw)) version = true;
    addUnknown([field[1]!], YARN_FIELDS, into);
  }
  return descriptor && version ? sorted(into) : [];
}

// ── TOML locks: Cargo, poetry, uv, pdm ───────────────────────────────────────

const TOML_ROOT = setOf([
  'version',
  'package',
  'metadata',
  'patch',
  'replace',
  'requires-python',
  'revision',
  'resolution-markers',
  'manifest',
  'conflicts',
  'supported-markers',
  'options',
  'dependency-groups',
  'extras',
]);
const TOML_PACKAGE = setOf([
  'name',
  'version',
  'source',
  'checksum',
  'dependencies',
  'replace',
  'optional',
  'description',
  'python-versions',
  'files',
  'extras',
  'category',
  'groups',
  'markers',
  'develop',
  'dev-dependencies',
  'optional-dependencies',
  'metadata',
  'wheels',
  'sdist',
  'dev',
  'resolution-markers',
  'environments',
  'summary',
  'marker',
  'index',
]);

function tomlPackages(doc: Record<string, unknown>): unknown[] {
  const list = doc.package;
  if (Array.isArray(list)) return list;
  return list ? [list] : [];
}

function tomlKeys(text: string): string[] {
  const doc = parseTomlDoc(text);
  if (!doc) return [];
  const packages = tomlPackages(doc);
  const usable = packages.some((entry) => {
    const rec = asRecord(entry);
    return typeof rec?.name === 'string' && typeof rec.version === 'string' && rec.version.length > 0;
  });
  if (!usable) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(doc), TOML_ROOT, into);
  for (const entry of packages) addUnknown(ownKeys(entry), TOML_PACKAGE, into);
  return sorted(into);
}

// ── Gemfile.lock ─────────────────────────────────────────────────────────────

const GEM_SECTIONS = setOf([
  'GEM',
  'GIT',
  'PATH',
  'PLATFORMS',
  'DEPENDENCIES',
  'BUNDLED WITH',
  'CHECKSUMS',
  'PLUGIN SOURCE',
]);

function gemfileKeys(text: string): string[] {
  if (!/^ {4}\S+ \(\d/m.test(text)) return [];
  const into = new Set<string>();
  for (const raw of text.split('\n')) {
    if (!raw || /^[ \t]/.test(raw)) continue;
    const header = raw.trim();
    if (!/^[A-Z][A-Z ]+$/.test(header)) continue;
    addUnknown([header], GEM_SECTIONS, into);
  }
  return sorted(into);
}

// ── composer.lock ────────────────────────────────────────────────────────────

const COMPOSER_ROOT = setOf([
  '_readme',
  'content-hash',
  'packages',
  'packages-dev',
  'aliases',
  'minimum-stability',
  'stability-flags',
  'prefer-stable',
  'prefer-lowest',
  'platform',
  'platform-dev',
  'plugin-api-version',
]);
const COMPOSER_PKG = setOf([
  'name',
  'version',
  'version_normalized',
  'source',
  'dist',
  'require',
  'require-dev',
  'conflict',
  'replace',
  'provide',
  'suggest',
  'bin',
  'type',
  'extra',
  'autoload',
  'autoload-dev',
  'notification-url',
  'license',
  'authors',
  'description',
  'homepage',
  'keywords',
  'support',
  'funding',
  'time',
  'abandoned',
  'default-branch',
  'transport-options',
  'scripts',
  'target-dir',
]);

function composerListHas(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    const rec = asRecord(entry);
    return typeof rec?.name === 'string' && typeof rec.version === 'string' && rec.version.length > 0;
  });
}

function composerKeys(text: string): string[] {
  const root = asRecord(parseJson(text));
  if (!root) return [];
  if (!composerListHas(root.packages) && !composerListHas(root['packages-dev'])) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(root), COMPOSER_ROOT, into);
  for (const section of ['packages', 'packages-dev']) {
    const list = root[section];
    if (!Array.isArray(list)) continue;
    for (const entry of list) addUnknown(ownKeys(entry), COMPOSER_PKG, into);
  }
  return sorted(into);
}

// ── Pipfile.lock ─────────────────────────────────────────────────────────────

const PIPFILE_ROOT = setOf(['_meta', 'default', 'develop']);
const PIPFILE_ENTRY = setOf(['version', 'markers', 'hashes', 'index', 'extras']);

function pipfileSectionHas(section: unknown): boolean {
  const deps = asRecord(section);
  if (!deps) return false;
  return Object.values(deps).some((entry) => typeof asRecord(entry)?.version === 'string');
}

function pipfileKeys(text: string): string[] {
  const root = asRecord(parseJson(text));
  if (!root) return [];
  if (!pipfileSectionHas(root.default) && !pipfileSectionHas(root.develop)) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(root), PIPFILE_ROOT, into);
  for (const section of ['default', 'develop']) {
    const deps = asRecord(root[section]);
    if (!deps) continue;
    for (const entry of Object.values(deps)) addUnknown(ownKeys(entry), PIPFILE_ENTRY, into);
  }
  return sorted(into);
}

// ── packages.lock.json ───────────────────────────────────────────────────────

const NUGET_ROOT = setOf(['version', 'dependencies']);
const NUGET_ENTRY = setOf(['type', 'requested', 'resolved', 'contentHash', 'dependencies', 'framework']);

function nugetKeys(text: string): string[] {
  const root = asRecord(parseJson(text));
  const frameworks = asRecord(root?.dependencies);
  if (!root || !frameworks) return [];
  let usable = false;
  const into = new Set<string>();
  for (const framework of Object.values(frameworks)) {
    const packages = asRecord(framework);
    if (!packages) continue;
    for (const entry of Object.values(packages)) {
      const rec = asRecord(entry);
      if (typeof rec?.resolved === 'string' && rec.resolved.length > 0) usable = true;
      addUnknown(ownKeys(entry), NUGET_ENTRY, into);
    }
  }
  if (!usable) return [];
  addUnknown(ownKeys(root), NUGET_ROOT, into);
  return sorted(into);
}

// ── Package.resolved ─────────────────────────────────────────────────────────

const SWIFT_ROOT = setOf(['version', 'originHash', 'pins', 'object']);
const SWIFT_OBJECT = setOf(['pins']);
const SWIFT_PIN = setOf(['identity', 'kind', 'location', 'state', 'package', 'repositoryURL']);
const SWIFT_STATE = setOf(['version', 'revision', 'branch']);

function swiftPins(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.pins)) return root.pins;
  const object = asRecord(root.object);
  return Array.isArray(object?.pins) ? object.pins : [];
}

function swiftKeys(text: string): string[] {
  const root = asRecord(parseJson(text));
  if (!root) return [];
  const pins = swiftPins(root);
  const usable = pins.some((pin) => typeof asRecord(asRecord(pin)?.state)?.version === 'string');
  if (!usable) return [];
  const into = new Set<string>();
  addUnknown(ownKeys(root), SWIFT_ROOT, into);
  addUnknown(ownKeys(root.object), SWIFT_OBJECT, into);
  for (const pin of pins) {
    addUnknown(ownKeys(pin), SWIFT_PIN, into);
    addUnknown(ownKeys(asRecord(pin)?.state), SWIFT_STATE, into);
  }
  return sorted(into);
}

// ── pubspec.lock ─────────────────────────────────────────────────────────────

const PUB_ROOT = setOf(['packages', 'sdks']);
const PUB_ENTRY = setOf(['dependency', 'description', 'source', 'version']);

function pubspecKeys(text: string): string[] {
  const root = asRecord(parseYamlDoc(text));
  const packages = asRecord(root?.packages);
  if (!root || !packages) return [];
  let usable = false;
  const into = new Set<string>();
  for (const entry of Object.values(packages)) {
    const rec = asRecord(entry);
    if (typeof rec?.version === 'string' && rec.version.length > 0) usable = true;
    addUnknown(ownKeys(entry), PUB_ENTRY, into);
  }
  if (!usable) return [];
  addUnknown(ownKeys(root), PUB_ROOT, into);
  return sorted(into);
}

/**
 * Sorted unique unknown optional keys on a lockfile that already resolves at
 * least one package. Empty when the file has no resolved package, is not a
 * known lockfile, or does not parse. Never throws.
 */
export function unknownOptionalLockfileKeys(basename: string, text: string): string[] {
  switch (basename.toLowerCase()) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return npmKeys(text);
    case 'pnpm-lock.yaml':
      return pnpmKeys(text);
    case 'yarn.lock':
      return yarnKeys(text);
    case 'cargo.lock':
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
      return tomlKeys(text);
    case 'gemfile.lock':
      return gemfileKeys(text);
    case 'composer.lock':
      return composerKeys(text);
    case 'pipfile.lock':
      return pipfileKeys(text);
    case 'packages.lock.json':
      return nugetKeys(text);
    case 'package.resolved':
      return swiftKeys(text);
    case 'pubspec.lock':
      return pubspecKeys(text);
    default:
      return [];
  }
}

/** Stable warning line. `relPath` is the lockfile path relative to the project root. */
export function unknownOptionalFieldWarning(relPath: string, key: string): string {
  return `warning: ${relPath}: unknown optional lockfile field "${key}"; kept the dependencies this file already resolved`;
}

/** One line per key, sorted by key name. Unsafe key names are dropped. */
export function formatUnknownOptionalFieldWarnings(relPath: string, keys: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const key of keys) {
    if (SAFE_KEY.test(key)) unique.add(key);
  }
  return [...unique]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => unknownOptionalFieldWarning(relPath, key));
}

function relativeLockfilePath(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(absPath);
  return rel.split(path.sep).join('/');
}

function contentKey(absPath: string, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${absPath}\0${(hash >>> 0).toString(16)}:${text.length}`;
}

/**
 * Write the unknown-optional-field warnings for one lockfile. A repeated read
 * of the same bytes, or the same key on a later read, does not write again.
 */
export function warnUnknownOptionalLockfile(root: string, absPath: string, text: string): void {
  const id = contentKey(absPath, text);
  if (seenContent.has(id)) return;
  seenContent.add(id);
  const rel = relativeLockfilePath(root, absPath);
  const fresh: string[] = [];
  for (const key of unknownOptionalLockfileKeys(path.basename(absPath), text)) {
    const mark = `${absPath}\0${key}`;
    if (emittedKeys.has(mark)) continue;
    emittedKeys.add(mark);
    fresh.push(key);
  }
  for (const line of formatUnknownOptionalFieldWarnings(rel, fresh)) {
    process.stderr.write(`${line}\n`);
  }
}
