import YAML from 'yaml';
import type { LineIndex } from './util.js';
import type { ToolchainSpan } from './types.js';

/**
 * Shared YAML access for the toolchain extractors.
 *
 * Uses the `yaml` package rather than a tree-sitter grammar. That is a
 * deliberate departure from "tree-sitter everywhere": `yaml` is already an
 * audited dependency of this package, and it gives us three things a grammar
 * would force us to reimplement by hand —
 *
 *   1. **byte ranges on every node** (`node.range`), which is the whole reason
 *      the plan preferred a CST over `serde`-style deserialisation;
 *   2. **multi-document streams** (`---`), which every non-trivial Kubernetes
 *      manifest uses;
 *   3. **anchors, aliases and merge keys**, which Helm and Compose files use
 *      heavily and which a raw CST would leave unresolved.
 *
 * Everything below is read-only and non-throwing: malformed YAML yields an
 * empty document list plus a warning, never an exception.
 */

/** A parsed YAML document with the AST retained for range lookups. */
export interface YamlDoc {
  /** Plain-JS view, with aliases resolved. `null` when the document is empty. */
  value: unknown;
  /** The underlying AST document, for `rangeOf` lookups. */
  ast: YAML.Document.Parsed;
  /** 0-based index within the stream. */
  index: number;
}

export interface YamlParseResult {
  docs: YamlDoc[];
  warnings: string[];
}

/**
 * Parse a YAML stream. Never throws.
 *
 * `maxAliasCount` is clamped: YAML's "billion laughs" alias-expansion bomb is a
 * real denial-of-service vector for a scanner that runs over untrusted
 * repositories, and the default limit is generous. A document that trips the
 * limit is reported as a warning and skipped, not expanded.
 */
export function parseYamlStream(rel: string, source: string): YamlParseResult {
  const warnings: string[] = [];
  let parsed: YAML.Document.Parsed[];
  try {
    parsed = YAML.parseAllDocuments(source, {
      // Parsing itself does not expand aliases — the bomb only detonates on
      // materialisation, so the alias budget is applied at `toJS` below.
      logLevel: 'silent',
      uniqueKeys: false,
    });
  } catch (err) {
    warnings.push(`${rel}: YAML parse failed (${(err as Error).message})`);
    return { docs: [], warnings };
  }

  const docs: YamlDoc[] = [];
  parsed.forEach((ast, index) => {
    if (ast.errors.length) {
      warnings.push(`${rel}: YAML document ${index + 1} has errors — skipped`);
      return;
    }
    let value: unknown;
    try {
      value = ast.toJS({ maxAliasCount: 100 });
    } catch (err) {
      warnings.push(`${rel}: YAML document ${index + 1} could not be materialised (${(err as Error).message})`);
      return;
    }
    if (value === null || value === undefined) return;
    docs.push({ value, ast, index });
  });

  return { docs, warnings };
}

/**
 * Byte range of the value at `path` within a document, as a line span.
 * Falls back to the document's own range when the path has no node — a span is
 * always better than no span, because it still anchors an editor decoration.
 */
export function spanAt(doc: YamlDoc, lines: LineIndex, path: (string | number)[]): ToolchainSpan {
  const node = path.length ? safeGetIn(doc.ast, path) : doc.ast.contents;
  const range = nodeRange(node) ?? nodeRange(doc.ast.contents);
  if (!range) return { start: 1, end: 1 };
  return lines.span(range[0], range[2] ?? range[1]);
}

function safeGetIn(ast: YAML.Document.Parsed, path: (string | number)[]): unknown {
  try {
    return ast.getIn(path, true);
  } catch {
    return undefined;
  }
}

function nodeRange(node: unknown): [number, number, number] | null {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return Array.isArray(range) ? range : null;
}

/** Read a nested value from a plain-JS document view. */
export function getPath(value: unknown, path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Read a string, or undefined when absent/non-string. Numbers are stringified. */
export function getString(value: unknown, path: (string | number)[]): string | undefined {
  const found = getPath(value, path);
  if (typeof found === 'string') return found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return undefined;
}

/** Read an array, or an empty array when absent/non-array. */
export function getArray(value: unknown, path: (string | number)[]): unknown[] {
  const found = getPath(value, path);
  return Array.isArray(found) ? found : [];
}

/** Read a plain object's entries in a deterministic (sorted-key) order. */
export function getRecordEntries(value: unknown, path: (string | number)[]): [string, unknown][] {
  const found = getPath(value, path);
  if (!found || typeof found !== 'object' || Array.isArray(found)) return [];
  return Object.entries(found as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, 'en'));
}

/**
 * Does this source look like a Go-templated Helm manifest?
 *
 * Helm templates are not valid YAML before rendering (`{{- if }}` lines break
 * the document), so the Kubernetes extractor must decline them and the Helm
 * extractor handles chart metadata and values instead.
 */
export function looksTemplated(source: string): boolean {
  return /\{\{-?\s*(if|range|with|end|define|template|include|toYaml|\.Values|\.Release|\.Chart)/.test(
    source,
  );
}
