// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Unknown optional lockfile fields.
 *
 * A key this version does not model is not a reason to drop a dependency
 * set that is otherwise readable. Callers record the key, keep parsing, and
 * emit one warning per file per key name. The warning names the key and the
 * lockfile path. It never includes the key's value, an environment value, or
 * an absolute path (those can carry home directories or registry tokens).
 *
 * Corrupt or missing required structure stays fail-closed in the syntax
 * checker. This module does not accept a broken document.
 */
import * as path from 'node:path';

/** Identifier-like key. Anything else can be a header or a pasted secret. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SAFE_REL = /^[A-Za-z0-9_@.+-][A-Za-z0-9_@.+/-]{0,180}$/;

const emitted = new Set<string>();

export function resetUnknownOptionalLockfileWarnings(): void {
  emitted.clear();
}

/**
 * Path safe to print: root-relative when the file sits under the process
 * working directory, otherwise the file name alone.
 */
export function lockfileWarningPath(filePath: string, root?: string): string {
  const abs = path.resolve(root ?? process.cwd(), filePath);
  const fromCwd = safeRelative(path.relative(process.cwd(), abs));
  if (fromCwd) return fromCwd;
  if (root) {
    const fromRoot = safeRelative(path.relative(root, abs));
    if (fromRoot) return fromRoot;
  }
  const base = path.basename(abs);
  return safeRelative(base) ?? 'lockfile';
}

function safeRelative(rel: string): string | undefined {
  const posix = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix || posix.startsWith('..') || posix.split('/').includes('..')) return undefined;
  if (!SAFE_REL.test(posix)) return undefined;
  return posix;
}

export function formatUnknownOptionalLockfileField(relPath: string, key: string): string {
  return `${relPath}: unknown optional lockfile field "${key}"; continuing with the fields this version understands.`;
}

export function formatOmittedUnknownOptionalLockfileField(relPath: string): string {
  return `${relPath}: unknown optional lockfile field (name omitted); continuing with the fields this version understands.`;
}

export class LockfileUnknownFields {
  private readonly byFile = new Map<string, Set<string>>();
  private readonly omitted = new Set<string>();

  note(relPath: string, key: string): void {
    const file = lockfileWarningPath(relPath);
    if (!SAFE_KEY.test(key)) {
      this.omitted.add(file);
      return;
    }
    let set = this.byFile.get(file);
    if (!set) {
      set = new Set();
      this.byFile.set(file, set);
    }
    set.add(key);
  }

  noteObject(relPath: string, value: unknown, known: ReadonlySet<string>): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value as object)) {
      if (known.has(key)) continue;
      this.note(relPath, key);
    }
  }

  /** Sorted by path, then by key name. One line per pair. */
  messages(): string[] {
    const files = new Set<string>([...this.byFile.keys(), ...this.omitted]);
    const out: string[] = [];
    for (const file of [...files].sort()) {
      const keys = [...(this.byFile.get(file) ?? [])].sort();
      for (const key of keys) out.push(formatUnknownOptionalLockfileField(file, key));
      if (this.omitted.has(file)) out.push(formatOmittedUnknownOptionalLockfileField(file));
    }
    return out;
  }
}

export function emitUnknownOptionalLockfileWarnings(
  notes: LockfileUnknownFields,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): string[] {
  const fresh: string[] = [];
  for (const message of notes.messages()) {
    if (emitted.has(message)) continue;
    emitted.add(message);
    fresh.push(message);
    write(message);
  }
  return fresh;
}

/** Fill `notes` when the caller owns them; otherwise warn on stderr. */
export function withLockfileNotes<T>(
  notes: LockfileUnknownFields | undefined,
  fill: (bucket: LockfileUnknownFields) => T,
): T {
  const bucket = notes ?? new LockfileUnknownFields();
  const result = fill(bucket);
  if (!notes) emitUnknownOptionalLockfileWarnings(bucket);
  return result;
}

// ── Known keys ──────────────────────────────────────────────────────────────
// A key in these sets is part of the documented lockfile shape. It is not an
// "unknown" field, even when this reader does not copy the value (integrity,
// checksum, and similar). Missing a real key here would warn on every project.

export const NPM_LOCK_TOP: ReadonlySet<string> = new Set([
  'name', 'version', 'lockfileVersion', 'requires', 'packages', 'dependencies',
]);

export const NPM_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'resolved', 'integrity', 'link', 'dev', 'optional', 'devOptional',
  'inBundle', 'hasInstallScript', 'hasShrinkwrap', 'bin', 'license', 'engines',
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'os', 'cpu',
  'libc', 'funding', 'deprecated', 'extraneous', 'workspaces', 'requires', 'from',
  'bundled', 'peer', 'licenseFile', 'scripts',
]);

export const PNPM_LOCK_TOP: ReadonlySet<string> = new Set([
  'lockfileVersion', 'settings', 'importers', 'packages', 'snapshots', 'time',
  'neverBuiltDependencies', 'onlyBuiltDependencies', 'overrides', 'packageExtensions',
  'packageExtensionsChecksum', 'patchedDependencies', 'catalogs', 'catalog',
  'ignoredOptionalDependencies', 'configDependencies', 'pnpmfileChecksum',
  // pnpm v5/v6 put these maps at the top of the file. v9 moved them under importers.
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'specifiers', 'dependenciesMeta',
]);

export const PNPM_LOCK_IMPORTER: ReadonlySet<string> = new Set([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'specifiers', 'dependenciesMeta', 'publishDirectory',
]);

export const PNPM_LOCK_DEP: ReadonlySet<string> = new Set(['specifier', 'version', 'optional']);

export const PNPM_LOCK_BLOCK: ReadonlySet<string> = new Set([
  'bundledDependencies', 'cpu', 'dependencies', 'deprecated', 'dev', 'devDependencies',
  'engines', 'hasBin', 'hash', 'libc', 'name', 'optional', 'optionalDependencies', 'os',
  'path', 'peerDependencies', 'peerDependenciesMeta', 'requiresBuild', 'resolution',
  'transitivePeerDependencies', 'version',
]);

export const YARN_LOCK_FIELDS: ReadonlySet<string> = new Set([
  'version', 'resolved', 'integrity', 'dependencies', 'optionalDependencies',
  'dependenciesMeta', 'peerDependencies', 'peerDependenciesMeta', 'checksum',
  'languageName', 'linkType', 'resolution', 'bin', 'conditions', 'cacheKey',
]);

export const CARGO_LOCK_TOP: ReadonlySet<string> = new Set(['version', 'package', 'metadata', 'patch']);
export const CARGO_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'source', 'checksum', 'dependencies', 'replace', 'explicit',
]);

export const POETRY_LOCK_TOP: ReadonlySet<string> = new Set(['package', 'metadata']);
export const POETRY_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'description', 'optional', 'python-versions', 'files',
  'dependencies', 'extras', 'category', 'groups', 'markers', 'source', 'develop',
  'dev-dependencies',
]);
export const POETRY_LOCK_METADATA: ReadonlySet<string> = new Set([
  'lock-version', 'python-versions', 'content-hash',
]);

export const UV_LOCK_TOP: ReadonlySet<string> = new Set([
  'version', 'requires-python', 'package', 'manifest', 'resolution-markers',
]);
export const UV_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'source', 'dependencies', 'optional-dependencies',
  'dev-dependencies', 'wheels', 'sdist', 'metadata', 'provides-extras',
  'resolution-markers',
]);

export const PDM_LOCK_TOP: ReadonlySet<string> = new Set(['metadata', 'package']);
export const PDM_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'requires_python', 'summary', 'dependencies', 'files',
  'marker', 'extras', 'groups',
]);
export const PDM_LOCK_METADATA: ReadonlySet<string> = new Set([
  'groups', 'strategy', 'lock_version', 'content_hash',
]);

export type TomlLockKind = 'cargo' | 'poetry' | 'uv' | 'pdm';

export const PIPFILE_TOP: ReadonlySet<string> = new Set(['_meta', 'default', 'develop']);
export const PIPFILE_META: ReadonlySet<string> = new Set(['hash', 'pipfile-spec', 'requires', 'sources']);
export const PIPFILE_ENTRY: ReadonlySet<string> = new Set([
  'hashes', 'markers', 'version', 'index', 'extras', 'subdirectory',
  'editable', 'git', 'ref', 'path', 'file', 'branch', 'tag', 'revision',
]);

export const COMPOSER_LOCK_TOP: ReadonlySet<string> = new Set([
  'content-hash', 'packages', 'packages-dev', 'aliases', 'minimum-stability',
  'stability-flags', 'prefer-stable', 'prefer-lowest', 'platform', 'platform-dev',
  'platform-overrides', 'plugin-api-version',
]);
export const COMPOSER_LOCK_PACKAGE: ReadonlySet<string> = new Set([
  'name', 'version', 'version_normalized', 'source', 'dist', 'require', 'require-dev',
  'conflict', 'replace', 'provide', 'suggest', 'type', 'extra', 'autoload', 'autoload-dev',
  'notification-url', 'license', 'authors', 'description', 'homepage', 'keywords', 'support',
  'funding', 'time', 'bin', 'archive', 'abandoned', 'transport-options', 'installation-source',
  'target-dir', 'include-path', 'scripts', 'repositories', 'config', 'minimum-stability',
  'prefer-stable', 'default-branch', 'aliases',
]);

export const NUGET_LOCK_TOP: ReadonlySet<string> = new Set(['version', 'dependencies']);
export const NUGET_LOCK_ENTRY: ReadonlySet<string> = new Set([
  'type', 'requested', 'resolved', 'contentHash', 'dependencies',
]);

export const SWIFT_RESOLVED_TOP: ReadonlySet<string> = new Set(['version', 'originHash', 'pins', 'object']);
export const SWIFT_PIN: ReadonlySet<string> = new Set(['identity', 'kind', 'location', 'state', 'package']);
export const SWIFT_PIN_STATE: ReadonlySet<string> = new Set(['version', 'revision', 'branch']);

export const PUBSPEC_LOCK_TOP: ReadonlySet<string> = new Set(['packages', 'sdks']);
export const PUBSPEC_LOCK_FIELDS: ReadonlySet<string> = new Set([
  'dependency', 'description', 'source', 'version',
]);

function tomlSets(kind: TomlLockKind): {
  top: ReadonlySet<string>;
  pkg: ReadonlySet<string>;
  meta?: ReadonlySet<string>;
} {
  switch (kind) {
    case 'cargo':
      return { top: CARGO_LOCK_TOP, pkg: CARGO_LOCK_PACKAGE };
    case 'poetry':
      return { top: POETRY_LOCK_TOP, pkg: POETRY_LOCK_PACKAGE, meta: POETRY_LOCK_METADATA };
    case 'uv':
      return { top: UV_LOCK_TOP, pkg: UV_LOCK_PACKAGE };
    case 'pdm':
      return { top: PDM_LOCK_TOP, pkg: PDM_LOCK_PACKAGE, meta: PDM_LOCK_METADATA };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function notePackageLock(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, NPM_LOCK_TOP);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as { packages?: unknown; dependencies?: unknown };
  if (data.packages && typeof data.packages === 'object' && !Array.isArray(data.packages)) {
    for (const entry of Object.values(data.packages as object)) {
      notes.noteObject(relPath, entry, NPM_LOCK_PACKAGE);
    }
  }
  noteNpmDependencyTree(data.dependencies, relPath, notes);
}

function noteNpmDependencyTree(deps: unknown, relPath: string, notes: LockfileUnknownFields): void {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return;
  for (const entry of Object.values(deps as object)) {
    notes.noteObject(relPath, entry, NPM_LOCK_PACKAGE);
    if (entry && typeof entry === 'object') {
      noteNpmDependencyTree((entry as { dependencies?: unknown }).dependencies, relPath, notes);
    }
  }
}

export function notePnpmLockDoc(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, PNPM_LOCK_TOP);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as Record<string, unknown>;
  notePnpmDependencyBlocks(data, relPath, notes);
  const importers = data.importers;
  if (!importers || typeof importers !== 'object' || Array.isArray(importers)) return;
  for (const imp of Object.values(importers as object)) {
    notes.noteObject(relPath, imp, PNPM_LOCK_IMPORTER);
    if (imp && typeof imp === 'object') notePnpmDependencyBlocks(imp as Record<string, unknown>, relPath, notes);
  }
}

function notePnpmDependencyBlocks(data: Record<string, unknown>, relPath: string, notes: LockfileUnknownFields): void {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = data[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const entry of Object.values(deps as object)) {
      notes.noteObject(relPath, entry, PNPM_LOCK_DEP);
    }
  }
}

const PNPM_TOP_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):/;
const PNPM_BLOCK_LINE = /^ {4}([A-Za-z_][A-Za-z0-9_-]*):/;
const PNPM_DEP_LINE = /^ {8}([A-Za-z_][A-Za-z0-9_-]*):/;

/** Text form of pnpm-lock.yaml. Package names sit at other indents and are not keys. */
export function notePnpmLockText(text: string, relPath: string, notes: LockfileUnknownFields): void {
  for (const line of text.split('\n')) {
    const top = PNPM_TOP_LINE.exec(line);
    if (top) {
      if (!PNPM_LOCK_TOP.has(top[1]!)) notes.note(relPath, top[1]!);
      continue;
    }
    const block = PNPM_BLOCK_LINE.exec(line);
    if (block) {
      if (!PNPM_LOCK_BLOCK.has(block[1]!)) notes.note(relPath, block[1]!);
      continue;
    }
    const dep = PNPM_DEP_LINE.exec(line);
    if (dep && !PNPM_LOCK_DEP.has(dep[1]!)) notes.note(relPath, dep[1]!);
  }
}

const YARN_FIELD_LINE = /^ {2}([A-Za-z_][A-Za-z0-9_-]*)\b/;

export function noteYarnLockText(text: string, relPath: string, notes: LockfileUnknownFields): void {
  for (const line of text.split('\n')) {
    const field = YARN_FIELD_LINE.exec(line);
    if (field && !YARN_LOCK_FIELDS.has(field[1]!)) notes.note(relPath, field[1]!);
  }
}

const TOML_ASSIGN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=/;

function tomlAssignmentKeys(block: string): string[] {
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const match = TOML_ASSIGN.exec(line);
    if (match) keys.push(match[1]!);
  }
  return keys;
}

export function noteTomlLockDoc(doc: unknown, relPath: string, notes: LockfileUnknownFields, kind: TomlLockKind): void {
  const sets = tomlSets(kind);
  notes.noteObject(relPath, doc, sets.top);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as { package?: unknown; metadata?: unknown };
  if (Array.isArray(data.package)) {
    for (const entry of data.package) notes.noteObject(relPath, entry, sets.pkg);
  }
  if (sets.meta) notes.noteObject(relPath, data.metadata, sets.meta);
}

export function noteTomlLockText(text: string, relPath: string, notes: LockfileUnknownFields, kind: TomlLockKind): void {
  const sets = tomlSets(kind);
  // Preamble assignments only. A file that opens with `[[package]]` has no
  // top-level keys; package names inside later tables are not fields.
  const tableAt = text.search(/^\s*\[/m);
  const head = tableAt === -1 ? text : text.slice(0, tableAt);
  for (const key of tomlAssignmentKeys(head)) {
    if (!sets.top.has(key)) notes.note(relPath, key);
  }
  for (const block of text.split(/\[\[package\]\]/).slice(1)) {
    const body = block.split(/\n\[/)[0] ?? block;
    for (const key of tomlAssignmentKeys(body)) {
      if (!sets.pkg.has(key)) notes.note(relPath, key);
    }
  }
  if (!sets.meta) return;
  const meta = /\[metadata\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(text);
  if (!meta) return;
  for (const key of tomlAssignmentKeys(meta[1]!)) {
    if (!sets.meta.has(key)) notes.note(relPath, key);
  }
}

export function notePipfileLock(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, PIPFILE_TOP);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as Record<string, unknown>;
  notes.noteObject(relPath, data._meta, PIPFILE_META);
  for (const section of ['default', 'develop']) {
    const deps = data[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const entry of Object.values(deps as object)) notes.noteObject(relPath, entry, PIPFILE_ENTRY);
  }
}

export function noteComposerLock(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, COMPOSER_LOCK_TOP);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as Record<string, unknown>;
  for (const section of ['packages', 'packages-dev']) {
    const arr = data[section];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) notes.noteObject(relPath, entry, COMPOSER_LOCK_PACKAGE);
  }
}

export function noteNugetLock(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, NUGET_LOCK_TOP);
  if (!doc || typeof doc !== 'object') return;
  const deps = (doc as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return;
  for (const framework of Object.values(deps as object)) {
    if (!framework || typeof framework !== 'object' || Array.isArray(framework)) continue;
    for (const entry of Object.values(framework as object)) {
      notes.noteObject(relPath, entry, NUGET_LOCK_ENTRY);
    }
  }
}

export function notePackageResolved(doc: unknown, relPath: string, notes: LockfileUnknownFields): void {
  notes.noteObject(relPath, doc, SWIFT_RESOLVED_TOP);
  if (!doc || typeof doc !== 'object') return;
  const data = doc as { pins?: unknown; object?: { pins?: unknown } };
  const pins = Array.isArray(data.pins) ? data.pins : data.object?.pins;
  if (!Array.isArray(pins)) return;
  for (const pin of pins) {
    notes.noteObject(relPath, pin, SWIFT_PIN);
    if (pin && typeof pin === 'object') {
      notes.noteObject(relPath, (pin as { state?: unknown }).state, SWIFT_PIN_STATE);
    }
  }
}

const PUBSPEC_TOP_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):/;
const PUBSPEC_FIELD_LINE = /^ {4}([A-Za-z_][A-Za-z0-9_-]*):/;

export function notePubspecLockText(text: string, relPath: string, notes: LockfileUnknownFields): void {
  for (const line of text.split('\n')) {
    const top = PUBSPEC_TOP_LINE.exec(line);
    if (top) {
      if (!PUBSPEC_LOCK_TOP.has(top[1]!)) notes.note(relPath, top[1]!);
      continue;
    }
    const field = PUBSPEC_FIELD_LINE.exec(line);
    if (field && !PUBSPEC_LOCK_FIELDS.has(field[1]!)) notes.note(relPath, field[1]!);
  }
}
