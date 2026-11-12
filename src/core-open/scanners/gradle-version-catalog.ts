// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Gradle version catalog (`gradle/libs.versions.toml`).
 *
 * A build file may declare `implementation(libs.guava)` or
 * `testImplementation libs.bundles.testing` instead of `group:artifact:version`.
 * The default catalog name is `libs`. Alias separators `-`, `_`, and `.` become
 * dots in that accessor (`junit-jupiter` is `libs.junit.jupiter`). This module
 * reads `[versions]`, `[libraries]`, and `[bundles]` and resolves those aliases
 * to a coordinate plus a version, including `version.ref`.
 *
 * The catalog is a declared pin. `gradle.lockfile` remains the resolved pin when
 * both exist; this module does not read the lockfile.
 *
 * Clean-room: parsed from Gradle's public catalog format with `smol-toml`
 * (BSD-3-Clause). No third-party Gradle parser is used.
 */
import * as path from 'node:path';
import { parseToml } from '../utils/toml.js';

export interface GradleCatalogLibrary {
  groupId: string;
  artifactId: string;
  version: string;
}

export interface GradleVersionCatalog {
  /** Accessor without the `libs.` prefix (`guava`, `junit.jupiter`). */
  libraries: ReadonlyMap<string, GradleCatalogLibrary>;
  /** Accessor without the `libs.bundles.` prefix. Values are library accessors. */
  bundles: ReadonlyMap<string, readonly string[]>;
}

export interface GradleCatalogUse {
  /** Index of the configuration call in the build file. */
  index: number;
  groupId: string;
  artifactId: string;
  version: string;
  configuration: string;
}

interface CatalogIo {
  exists(p: string): Promise<boolean>;
  readText(p: string): Promise<string>;
}

const VERSION_PINS = ['require', 'strictly', 'prefer'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `junit-jupiter` / `junit_jupiter` / `junit.jupiter` → `junit.jupiter`. */
export function gradleAliasAccessor(alias: string): string | null {
  const parts = alias.split(/[-_.]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((part) => /^[A-Za-z0-9_]+$/.test(part))) return null;
  if (!/^[A-Za-z_]/.test(parts[0]!)) return null;
  return parts.join('.');
}

function plainVersion(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  for (const key of VERSION_PINS) {
    const pin = value[key];
    if (typeof pin === 'string' && pin.trim()) return pin.trim();
  }
  return '';
}

function parseVersions(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(raw)) return out;
  const pending = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (isRecord(value) && typeof value.ref === 'string' && !plainVersion(value)) {
      pending.set(key, value.ref.trim());
      continue;
    }
    const version = plainVersion(value);
    if (version) out.set(key, version);
  }
  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [key, ref] of pending) {
      const resolved = out.get(ref);
      if (!resolved) continue;
      out.set(key, resolved);
      pending.delete(key);
      progressed = true;
    }
  }
  return out;
}

function resolveVersion(value: unknown, versions: Map<string, string>): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  if (typeof value.ref === 'string') {
    const resolved = versions.get(value.ref.trim());
    if (resolved) return resolved;
  }
  return plainVersion(value);
}

function splitModule(moduleName: string): { groupId: string; artifactId: string; version: string } | null {
  const parts = moduleName.split(':').map((part) => part.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    groupId: parts[0],
    artifactId: parts[1],
    version: parts.slice(2).join(':'),
  };
}

function parseLibrary(value: unknown, versions: Map<string, string>): GradleCatalogLibrary | null {
  if (typeof value === 'string') {
    const split = splitModule(value);
    if (!split?.version) return null;
    return split;
  }
  if (!isRecord(value)) return null;

  let groupId = typeof value.group === 'string' ? value.group.trim() : '';
  let artifactId = typeof value.name === 'string' ? value.name.trim() : '';
  let embedded = '';
  if (typeof value.module === 'string') {
    const split = splitModule(value.module);
    if (split) {
      groupId = groupId || split.groupId;
      artifactId = artifactId || split.artifactId;
      embedded = split.version;
    }
  }
  const version = libraryVersion(value, versions) || embedded;
  if (!groupId || !artifactId || !version) return null;
  return { groupId, artifactId, version };
}

/** `version.ref` is a nested table in TOML. Also accept a literal dotted key. */
function libraryVersion(value: Record<string, unknown>, versions: Map<string, string>): string {
  if ('version' in value) {
    const resolved = resolveVersion(value.version, versions);
    if (resolved) return resolved;
  }
  if (typeof value['version.ref'] === 'string') {
    return versions.get(value['version.ref'].trim()) ?? '';
  }
  for (const key of VERSION_PINS) {
    const dotted = value[`version.${key}`];
    if (typeof dotted === 'string' && dotted.trim()) return dotted.trim();
  }
  return '';
}

/**
 * Parse a `libs.versions.toml` document. Malformed TOML yields null. A document
 * that parses with no resolvable libraries yields an empty catalog.
 */
export function parseGradleVersionCatalog(text: string): GradleVersionCatalog | null {
  const doc = parseToml(text);
  if (!doc) return null;

  const versions = parseVersions(doc.versions);
  const libraries = new Map<string, GradleCatalogLibrary>();
  if (isRecord(doc.libraries)) {
    for (const [alias, value] of Object.entries(doc.libraries)) {
      const accessor = gradleAliasAccessor(alias);
      if (!accessor || libraries.has(accessor)) continue;
      const library = parseLibrary(value, versions);
      if (!library) continue;
      libraries.set(accessor, library);
    }
  }

  const bundles = new Map<string, readonly string[]>();
  if (isRecord(doc.bundles)) {
    for (const [alias, value] of Object.entries(doc.bundles)) {
      const accessor = gradleAliasAccessor(alias);
      if (!accessor || bundles.has(accessor) || !Array.isArray(value)) continue;
      const members: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const member = gradleAliasAccessor(item);
        if (!member || !libraries.has(member)) continue;
        members.push(member);
      }
      if (members.length > 0) bundles.set(accessor, members);
    }
  }

  return { libraries, bundles };
}

function withinRoot(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Load `gradle/libs.versions.toml` for a project directory.
 *
 * The file beside the build file wins. When that file is absent, parent
 * directories are searched up to `rootDir`. A file that is present but not
 * valid TOML stops the search.
 */
export async function loadGradleVersionCatalog(
  dir: string,
  rootDir: string,
  io: CatalogIo,
): Promise<GradleVersionCatalog | null> {
  const root = path.resolve(rootDir);
  let current = path.resolve(dir);
  if (!withinRoot(root, current)) current = root;

  for (;;) {
    const catalogPath = path.join(current, 'gradle', 'libs.versions.toml');
    let present = false;
    try {
      present = await io.exists(catalogPath);
    } catch {
      present = false;
    }
    if (present) {
      try {
        return parseGradleVersionCatalog(await io.readText(catalogPath));
      } catch {
        return null;
      }
    }
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current || !withinRoot(root, parent)) return null;
    current = parent;
  }
}

function knownAccessor(dotted: string, keys: ReadonlySet<string>): string | null {
  const parts = dotted.split('.');
  for (let length = parts.length; length >= 1; length--) {
    const key = parts.slice(0, length).join('.');
    if (!keys.has(key)) continue;
    const rest = parts.slice(length);
    if (rest.length === 0 || (rest.length === 1 && rest[0] === 'get')) return key;
    return null;
  }
  return null;
}

/**
 * `libs…` uses in a Gradle build file, in source order.
 *
 * `configNames` is the configuration alternation the Java scanner already
 * recognizes. A leading word boundary keeps a name from matching inside a
 * longer identifier. `platform(libs…)` is recorded as configuration
 * `platform`, matching a quoted platform declaration.
 */
export function gradleCatalogUses(
  content: string,
  catalog: GradleVersionCatalog,
  configNames: string,
): GradleCatalogUse[] {
  const libraryKeys = new Set(catalog.libraries.keys());
  const bundleKeys = new Set(catalog.bundles.keys());
  const uses: GradleCatalogUse[] = [];

  const pushLibrary = (index: number, accessor: string, configuration: string): void => {
    const library = catalog.libraries.get(accessor);
    if (!library) return;
    uses.push({ index, configuration, ...library });
  };

  const aliasRe = new RegExp(
    `\\b(?:${configNames})\\s*(?:\\(\\s*)?libs\\.(bundles\\.)?([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*)`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(content)) !== null) {
    const dotted = match[2]!;
    if (match[1]) {
      const bundle = knownAccessor(dotted, bundleKeys);
      if (bundle) {
        for (const member of catalog.bundles.get(bundle) ?? []) {
          pushLibrary(match.index, member, match[0]!.match(/^[A-Za-z]+/)?.[0] ?? 'implementation');
        }
        continue;
      }
      const asLibrary = knownAccessor(`bundles.${dotted}`, libraryKeys);
      if (asLibrary) {
        pushLibrary(match.index, asLibrary, match[0]!.match(/^[A-Za-z]+/)?.[0] ?? 'implementation');
      }
      continue;
    }
    const accessor = knownAccessor(dotted, libraryKeys);
    if (!accessor) continue;
    pushLibrary(match.index, accessor, match[0]!.match(/^[A-Za-z]+/)?.[0] ?? 'implementation');
  }

  const platformRe = new RegExp(
    `\\b(?:implementation|api)\\s*(?:\\(\\s*)?platform\\s*\\(\\s*libs\\.([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*)`,
    'g',
  );
  while ((match = platformRe.exec(content)) !== null) {
    const accessor = knownAccessor(match[1]!, libraryKeys);
    if (!accessor) continue;
    pushLibrary(match.index, accessor, 'platform');
  }

  return uses;
}
