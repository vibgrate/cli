/**
 * Gradle version catalog (`libs`) reader.
 *
 * The conventional file is `gradle/libs.versions.toml`, which Gradle imports
 * automatically as the `libs` catalog. A `settings.gradle` / `settings.gradle.kts`
 * `libs` block can point at other files with `from(files("…"))`. `[versions]`,
 * `[libraries]`, and `[bundles]` are read. `[plugins]` is not a dependency.
 *
 * Clean-room: parsed from Gradle's documented TOML catalog with `smol-toml`
 * (BSD-3-Clause). No third-party Gradle parser is used.
 */
import * as path from 'node:path';
import { parseToml } from '../utils/toml.js';

export interface CatalogLibrary {
  groupId: string;
  artifactId: string;
  version: string;
}

export interface GradleVersionCatalog {
  /** Normalized alias (`jackson.databind`) → coordinate. */
  libraries: Map<string, CatalogLibrary>;
  /** Normalized bundle alias → normalized library aliases, catalog order. */
  bundles: Map<string, string[]>;
}

export interface CatalogIo {
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
}

const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'] as const;

/** `-`, `_`, and `.` are the same accessor separator. Matching is case-insensitive. */
export function normalizeCatalogAlias(alias: string): string {
  return alias
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())
    .join('.');
}

export function parseGradleVersionCatalog(text: string): GradleVersionCatalog {
  const libraries = new Map<string, CatalogLibrary>();
  const bundles = new Map<string, string[]>();
  const doc = parseToml(text);
  if (!doc) return { libraries, bundles };

  const versions = readVersions(doc.versions);
  readLibraries(doc.libraries, versions, libraries);
  readBundles(doc.bundles, libraries, bundles);
  return { libraries, bundles };
}

/**
 * Libraries selected by a `libs…` accessor.
 * `libs.bundles.<name>` expands to member libraries that have a version.
 * `libs.versions…` and `libs.plugins…` are not dependencies.
 */
export function librariesForAccessor(catalog: GradleVersionCatalog, accessor: string): CatalogLibrary[] {
  const raw = accessor.trim().replace(/\s*\.\s*get\s*\(\s*\)\s*$/, '');
  const parts = raw.split('.').filter((part) => part.length > 0);
  if (parts.length < 2 || parts[0] !== 'libs') return [];
  if (parts[1] === 'versions' || parts[1] === 'plugins') return [];
  if (parts[1] === 'bundles') {
    if (parts.length < 3) return [];
    const members = catalog.bundles.get(normalizeCatalogAlias(parts.slice(2).join('.')));
    if (!members) return [];
    const out: CatalogLibrary[] = [];
    for (const member of members) {
      const lib = catalog.libraries.get(member);
      if (lib) out.push(lib);
    }
    return out;
  }
  const lib = catalog.libraries.get(normalizeCatalogAlias(parts.slice(1).join('.')));
  return lib ? [lib] : [];
}

/**
 * Relative file paths declared for the `libs` catalog via `from(files("…"))`.
 * `null` when settings does not declare a `libs` catalog block.
 * An empty list means the block exists but names no string paths.
 */
export function libsCatalogPathsFromSettings(text: string): string[] | null {
  const src = stripGradleComments(text);
  const decl = /(?:create\s*\(\s*(['"])libs\1\s*\)|(?<![\w.])libs)\s*\{/g;
  const paths: string[] = [];
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = decl.exec(src)) !== null) {
    found = true;
    const open = match.index + match[0].length - 1;
    const body = readBraceBlock(src, open);
    if (body == null) continue;
    paths.push(...fileArgs(body));
  }
  return found ? paths : null;
}

/**
 * Load the `libs` catalog visible to a build file in `projectDir`.
 * Returns null when no catalog file is present or none of its libraries resolve.
 */
export async function loadGradleVersionCatalog(
  projectDir: string,
  rootDir: string,
  io: CatalogIo,
): Promise<GradleVersionCatalog | null> {
  try {
    const files = await catalogFiles(projectDir, rootDir, io);
    const parts: GradleVersionCatalog[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const key = path.resolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(await io.exists(file).catch(() => false))) continue;
      const text = await io.readText(file);
      if (!text.trim()) continue;
      parts.push(parseGradleVersionCatalog(text));
    }
    if (parts.length === 0) return null;
    const merged = mergeCatalogs(parts);
    if (merged.libraries.size === 0) return null;
    return merged;
  } catch {
    return null;
  }
}

async function catalogFiles(projectDir: string, rootDir: string, io: CatalogIo): Promise<string[]> {
  const dirs = ancestorsInclusive(projectDir, rootDir);
  for (const dir of dirs) {
    for (const name of SETTINGS_FILES) {
      const settingsPath = path.join(dir, name);
      if (!(await io.exists(settingsPath).catch(() => false))) continue;
      const declared = libsCatalogPathsFromSettings(await io.readText(settingsPath));
      if (declared && declared.length > 0) {
        return declared.map((rel) => (path.isAbsolute(rel) ? rel : path.resolve(dir, rel)));
      }
      return [path.join(dir, 'gradle', 'libs.versions.toml')];
    }
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, 'gradle', 'libs.versions.toml');
    if (await io.exists(candidate).catch(() => false)) return [candidate];
  }
  return [];
}

function ancestorsInclusive(start: string, root: string): string[] {
  const out: string[] = [];
  const stop = path.resolve(root);
  let current = path.resolve(start);
  for (;;) {
    out.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function mergeCatalogs(parts: GradleVersionCatalog[]): GradleVersionCatalog {
  const libraries = new Map<string, CatalogLibrary>();
  const bundles = new Map<string, string[]>();
  for (const part of parts) {
    for (const [key, lib] of part.libraries) {
      if (!libraries.has(key)) libraries.set(key, lib);
    }
    for (const [key, members] of part.bundles) {
      if (!bundles.has(key)) bundles.set(key, members);
    }
  }
  return { libraries, bundles };
}

function readVersions(node: unknown): Map<string, string> {
  const out = new Map<string, string>();
  walkRecords(node, [], (alias, value) => {
    const text = literalVersion(value);
    if (!text) return;
    if (!out.has(alias)) out.set(alias, text);
    const normalized = normalizeCatalogAlias(alias);
    if (!out.has(normalized)) out.set(normalized, text);
  }, isVersionSpec);
  return out;
}

function readLibraries(node: unknown, versions: Map<string, string>, into: Map<string, CatalogLibrary>): void {
  walkRecords(node, [], (alias, value) => {
    const lib = libraryFrom(value, versions);
    if (!lib) return;
    const key = normalizeCatalogAlias(alias);
    if (!into.has(key)) into.set(key, lib);
  }, isLibraryLeaf);
}

function readBundles(node: unknown, libraries: Map<string, CatalogLibrary>, into: Map<string, string[]>): void {
  walkRecords(node, [], (alias, value) => {
    if (!Array.isArray(value)) return;
    const members: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const key = normalizeCatalogAlias(item);
      if (libraries.has(key)) members.push(key);
    }
    if (members.length === 0) return;
    const key = normalizeCatalogAlias(alias);
    if (!into.has(key)) into.set(key, members);
  }, Array.isArray);
}

function libraryFrom(value: unknown, versions: Map<string, string>): CatalogLibrary | null {
  if (typeof value === 'string') {
    const parts = value.split(':');
    if (parts.length < 3) return null;
    const groupId = parts[0]?.trim() ?? '';
    const artifactId = parts[1]?.trim() ?? '';
    const version = parts[2]?.trim() ?? '';
    if (!groupId || !artifactId || !version) return null;
    return { groupId, artifactId, version };
  }
  if (!isRecord(value)) return null;
  let groupId = '';
  let artifactId = '';
  let moduleFallback = '';
  if (typeof value.module === 'string') {
    const parts = value.module.split(':');
    groupId = parts[0]?.trim() ?? '';
    artifactId = parts[1]?.trim() ?? '';
    moduleFallback = parts[2]?.trim() ?? '';
  } else {
    groupId = typeof value.group === 'string' ? value.group.trim() : '';
    artifactId = typeof value.name === 'string' ? value.name.trim() : '';
  }
  if (!groupId || !artifactId) return null;
  const version = entryVersion(value, versions, moduleFallback);
  if (!version) return null;
  return { groupId, artifactId, version };
}

function entryVersion(rec: Record<string, unknown>, versions: Map<string, string>, moduleFallback: string): string {
  if (!('version' in rec)) return moduleFallback;
  const value = rec.version;
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  if (typeof value.ref === 'string') {
    const ref = value.ref.trim();
    return versions.get(ref) ?? versions.get(normalizeCatalogAlias(ref)) ?? '';
  }
  return literalVersion(value);
}

function literalVersion(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  for (const key of ['require', 'strictly', 'prefer'] as const) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function isVersionSpec(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!isRecord(value)) return false;
  return 'require' in value || 'strictly' in value || 'prefer' in value || 'reject' in value;
}

function isLibraryLeaf(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!isRecord(value)) return false;
  return 'module' in value || 'group' in value || 'name' in value || 'version' in value;
}

function walkRecords(
  node: unknown,
  prefix: string[],
  visit: (alias: string, value: unknown) => void,
  isLeaf: (value: unknown) => boolean,
): void {
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const next = [...prefix, key];
    if (isLeaf(value)) visit(next.join('.'), value);
    else if (isRecord(value)) walkRecords(value, next, visit, isLeaf);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripGradleComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readBraceBlock(text: string, openIndex: number): string | null {
  if (text[openIndex] !== '{') return null;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

function fileArgs(block: string): string[] {
  const out: string[] = [];
  const calls = /from\s*\(\s*files\s*\(([^)]*)\)/g;
  let call: RegExpExecArray | null;
  while ((call = calls.exec(block)) !== null) {
    const args = call[1] ?? '';
    const strings = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let lit: RegExpExecArray | null;
    while ((lit = strings.exec(args)) !== null) {
      const value = (lit[2] ?? '').replace(/\\(['"\\])/g, '$1').trim();
      if (value) out.push(value);
    }
  }
  return out;
}
