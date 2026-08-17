/**
 * Locale file discovery and writing.
 *
 * The path template (`src/locales/{language}/{namespace}.json`) is the contract
 * between a project's on-disk layout and Vibgrate Cloud. It is deliberately a
 * template rather than a glob: pull has to know exactly where to WRITE a file
 * that does not exist yet, which a glob cannot tell it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codecFor, sortKeys, type FlatCatalog } from './formats.js';

export const PATH_TOKENS = ['{language}', '{namespace}'] as const;

export interface ResolvedLocaleFile {
  language: string;
  namespace: string;
  /** Absolute path. */
  file: string;
  /** Path relative to the working directory, for display. */
  relative: string;
  exists: boolean;
}

/** Validate a template early, with a message naming the missing token. */
export function validatePathTemplate(template: string): string | null {
  if (!template.trim()) return 'path template is required.';
  if (!template.includes('{language}')) {
    return 'path template must contain {language} (e.g. "src/locales/{language}/{namespace}.json").';
  }
  if (path.isAbsolute(template)) {
    return 'path template must be relative to the project directory.';
  }
  // A template that escapes the project root would let a pull write anywhere on
  // the machine — reject it here rather than after the download.
  if (template.split(/[\\/]/).includes('..')) {
    return 'path template must not contain "..".';
  }
  return null;
}

export function renderPath(template: string, language: string, namespace: string): string {
  return template.replaceAll('{language}', language).replaceAll('{namespace}', namespace);
}

export function resolveLocaleFiles(
  cwd: string,
  template: string,
  languages: string[],
  namespaces: string[],
): ResolvedLocaleFile[] {
  const out: ResolvedLocaleFile[] = [];
  for (const language of languages) {
    for (const namespace of namespaces) {
      const relative = renderPath(template, language, namespace);
      const file = path.resolve(cwd, relative);
      out.push({ language, namespace, file, relative, exists: fs.existsSync(file) });
    }
  }
  return out;
}

export function readCatalog(file: string, format: string): FlatCatalog {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    return codecFor(format).decode(text);
  } catch (error) {
    throw new Error(
      `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface WriteResult {
  file: string;
  changed: boolean;
  bytes: number;
}

/**
 * Write a catalog, reporting whether the bytes actually changed.
 *
 * Comparing before writing is what lets `pull` say "3 files updated, 9
 * unchanged" instead of touching every mtime and making the change invisible in
 * a diff-driven review.
 */
export function writeCatalog(
  file: string,
  format: string,
  catalog: FlatCatalog,
  opts: { dryRun?: boolean } = {},
): WriteResult {
  const encoded = codecFor(format).encode(sortKeys(catalog));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const changed = existing !== encoded;

  if (changed && !opts.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encoded, 'utf8');
  }

  return { file, changed, bytes: Buffer.byteLength(encoded, 'utf8') };
}

export interface CatalogDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Compare two catalogs. Used to show what a push or pull will do BEFORE it does
 * it, which is the whole point of `--dry-run`.
 */
export function diffCatalogs(before: FlatCatalog, after: FlatCatalog): CatalogDiff {
  const diff: CatalogDiff = { added: [], changed: [], removed: [], unchanged: [] };
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) diff.added.push(key);
    else if (before[key] !== value) diff.changed.push(key);
    else diff.unchanged.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) diff.removed.push(key);
  }
  return diff;
}
