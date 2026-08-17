// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * A small, correct HCL block walker.
 *
 * ## Why this exists
 *
 * The Terraform scanner used to read blocks with patterns of the form
 * `/required_providers\s*\{([^}]+)\}/s`. A negated character class stops at the
 * *first* closing brace, so the extremely common nested form
 *
 *     required_providers {
 *       aws     = { source = "hashicorp/aws" }      ← this `}` ended the match
 *       azurerm = { source = "hashicorp/azurerm" }  ← never seen
 *     }
 *
 * silently dropped every provider after the first — under-reporting drift on
 * exactly the multi-cloud repositories that need it most. No amount of regex
 * tuning fixes that: brace nesting is not a regular language.
 *
 * This module walks the text with a depth counter that is aware of the three
 * things that can contain a brace without opening a block — quoted strings,
 * comments, and heredocs — which is enough to slice HCL into blocks correctly
 * without pulling a parser into this package.
 *
 * ## Why not a real parser
 *
 * `@vibgrate/core-open` is published standalone under Apache-2.0 and is
 * deliberately dependency-light; it cannot reach the tree-sitter HCL grammar
 * that the graph engine uses (that lives in the CLI package, behind a
 * devDependency whose `.wasm` ships prebuilt). Adding a parser here to serve
 * one scanner would be a poor trade. This walker is ~150 lines, deterministic,
 * and covered by tests including the nesting case the regexes failed.
 */

export interface HclBlock {
  /** The block's leading identifier, e.g. `terraform`, `resource`, `module`. */
  type: string;
  /** Quoted labels between the type and the opening brace. */
  labels: string[];
  /** Raw text between the outermost braces, excluding the braces themselves. */
  body: string;
  /** Offset of the block's first character in the source. */
  start: number;
  /** Offset just past the block's closing brace. */
  end: number;
}

/** Scanner state for characters that may contain an unbalanced brace. */
type Mode = 'code' | 'string' | 'line-comment' | 'block-comment' | 'heredoc';

/**
 * Split HCL source into its top-level blocks.
 *
 * `depth` selects nesting level: 0 walks top-level blocks, and the body of any
 * returned block can be walked again to reach the next level down.
 */
export function parseHclBlocks(source: string): HclBlock[] {
  const blocks: HclBlock[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    // Skip whitespace, comments and anything that is not a block header.
    const headerStart = skipTrivia(source, i);
    if (headerStart >= n) break;

    const header = readBlockHeader(source, headerStart);
    if (!header) {
      // Not a block header — advance past this line and keep looking.
      const nextLine = source.indexOf('\n', headerStart);
      if (nextLine === -1) break;
      i = nextLine + 1;
      continue;
    }

    const bodyEnd = matchBrace(source, header.braceIndex);
    if (bodyEnd === -1) break; // unbalanced — stop rather than mis-slice

    blocks.push({
      type: header.type,
      labels: header.labels,
      body: source.slice(header.braceIndex + 1, bodyEnd),
      start: headerStart,
      end: bodyEnd + 1,
    });
    i = bodyEnd + 1;
  }

  return blocks;
}

/**
 * Attribute assignments (`name = value`) directly inside a block body, skipping
 * anything nested. Values are returned raw, exactly as written.
 */
export function parseHclAttributes(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let i = 0;
  const n = body.length;

  while (i < n) {
    i = skipTrivia(body, i);
    if (i >= n) break;

    const nameMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=(?!=)/.exec(body.slice(i));
    if (!nameMatch) {
      // Not an attribute. If it opens a nested block, skip the whole block.
      const header = readBlockHeader(body, i);
      if (header) {
        const end = matchBrace(body, header.braceIndex);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      const nextLine = body.indexOf('\n', i);
      if (nextLine === -1) break;
      i = nextLine + 1;
      continue;
    }

    const valueStart = i + nameMatch[0].length;
    const valueEnd = readValueEnd(body, valueStart);
    out.push({
      name: nameMatch[1],
      value: body.slice(valueStart, valueEnd).trim(),
    });
    // Step over the separator so the next pair on the same line is read too
    // (`{ source = "…", version = "…" }`).
    i = valueEnd;
    const afterValue = skipInlineTrivia(body, i);
    i = body[afterValue] === ',' ? afterValue + 1 : i;
  }

  return out;
}

/** A quoted-string attribute's value, unquoted — or undefined when absent. */
export function hclStringAttribute(body: string, name: string): string | undefined {
  for (const attribute of parseHclAttributes(body)) {
    if (attribute.name !== name) continue;
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(attribute.value);
    if (quoted) return quoted[1];
  }
  return undefined;
}

/** Read a `type "label" "label" {` header at `i`, or null when there is none. */
function readBlockHeader(
  source: string,
  i: number,
): { type: string; labels: string[]; braceIndex: number } | null {
  const typeMatch = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(source.slice(i));
  if (!typeMatch) return null;

  let cursor = i + typeMatch[0].length;
  const labels: string[] = [];

  for (;;) {
    cursor = skipInlineTrivia(source, cursor);
    if (cursor >= source.length) return null;
    const ch = source[cursor];

    if (ch === '{') return { type: typeMatch[1], labels, braceIndex: cursor };

    if (ch === '"') {
      const end = readStringEnd(source, cursor);
      if (end === -1) return null;
      labels.push(source.slice(cursor + 1, end));
      cursor = end + 1;
      continue;
    }

    // An identifier label (`provider aws {`) is legal HCL in some dialects.
    const identifier = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(source.slice(cursor));
    if (identifier) {
      labels.push(identifier[1]);
      cursor += identifier[0].length;
      continue;
    }

    return null; // `=` or anything else — this is an attribute, not a block
  }
}

/**
 * Index of the `}` matching the `{` at `open`, or -1 when unbalanced.
 * Braces inside strings, comments and heredocs do not count.
 */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  let mode: Mode = 'code';
  let heredocTag = '';

  while (i < source.length) {
    const ch = source[i];

    if (mode === 'string') {
      if (ch === '\\') i += 2;
      else if (ch === '"') { mode = 'code'; i++; }
      else i++;
      continue;
    }
    if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
      i++;
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && source[i + 1] === '/') { mode = 'code'; i += 2; }
      else i++;
      continue;
    }
    if (mode === 'heredoc') {
      // The terminator is the tag alone on a line (optionally indented).
      if (ch === '\n') {
        const lineEnd = source.indexOf('\n', i + 1);
        const line = source.slice(i + 1, lineEnd === -1 ? source.length : lineEnd);
        if (line.trim() === heredocTag) {
          mode = 'code';
          heredocTag = '';
          i = lineEnd === -1 ? source.length : lineEnd;
          continue;
        }
      }
      i++;
      continue;
    }

    // mode === 'code'
    if (ch === '"') { mode = 'string'; i++; continue; }
    if (ch === '#') { mode = 'line-comment'; i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { mode = 'line-comment'; i += 2; continue; }
    if (ch === '/' && source[i + 1] === '*') { mode = 'block-comment'; i += 2; continue; }
    if (ch === '<' && source[i + 1] === '<') {
      const heredoc = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (heredoc) {
        mode = 'heredoc';
        heredocTag = heredoc[1];
        i += heredoc[0].length;
        continue;
      }
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }

  return -1;
}

/** Index of the closing quote of the string starting at `open`, or -1. */
function readStringEnd(source: string, open: number): number {
  let i = open + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '"') return i;
    i++;
  }
  return -1;
}

/**
 * End offset of the attribute value beginning at `start`.
 *
 * Reads exactly **one** value, which matters for the single-line object form
 * HCL uses constantly:
 *
 *     aws = { source = "hashicorp/aws" version = "~> 5.0" }
 *
 * A naive "value runs to end of line" rule swallows `version = "~> 5.0"` into
 * `source`'s value and loses both. So the value is a single balanced token:
 * a bracketed composite, a quoted string, a heredoc, or a run terminated by a
 * comma, a newline, or the start of the next `identifier =` pair.
 */
function readValueEnd(source: string, start: number): number {
  const i = skipInlineTrivia(source, start);

  // A composite value (object/tuple) runs to its matching bracket.
  if (source[i] === '{') {
    const close = matchBrace(source, i);
    if (close !== -1) return close + 1;
  }
  if (source[i] === '[') {
    const close = matchBracket(source, i);
    if (close !== -1) return close + 1;
  }

  // A heredoc runs to its terminator line.
  const heredoc = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
  if (heredoc) {
    const tag = heredoc[1];
    let cursor = i;
    while (cursor < source.length) {
      const lineEnd = source.indexOf('\n', cursor + 1);
      const line = source.slice(cursor + 1, lineEnd === -1 ? source.length : lineEnd);
      if (line.trim() === tag) return lineEnd === -1 ? source.length : lineEnd;
      if (lineEnd === -1) break;
      cursor = lineEnd;
    }
    return source.length;
  }

  // A scalar or expression: scan forward, balancing brackets and skipping
  // strings, and stop at the first depth-0 terminator.
  let cursor = i;
  let depth = 0;
  let inString = false;

  while (cursor < source.length) {
    const ch = source[cursor];

    if (inString) {
      if (ch === '\\') cursor += 2;
      else {
        if (ch === '"') inString = false;
        cursor++;
      }
      continue;
    }

    if (ch === '"') { inString = true; cursor++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cursor++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return cursor; // closes the *enclosing* body
      depth--;
      cursor++;
      continue;
    }

    if (depth === 0) {
      if (ch === '\n' || ch === ',') return cursor;
      // The next `identifier =` on the same line starts a new attribute.
      if (ch === ' ' || ch === '\t') {
        if (/^\s+[A-Za-z_][A-Za-z0-9_-]*\s*=(?!=)/.test(source.slice(cursor))) return cursor;
      }
      if (ch === '#') return cursor;
      if (ch === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) return cursor;
    }

    cursor++;
  }

  return source.length;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function matchBracket(source: string, open: number): number {
  let depth = 0;
  let i = open;
  let inString = false;
  while (i < source.length) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 2;
      else { if (ch === '"') inString = false; i++; }
      continue;
    }
    if (ch === '"') { inString = true; i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Skip whitespace and comments, including newlines. */
function skipTrivia(source: string, i: number): number {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '#' || (source[i] === '/' && source[i + 1] === '/')) {
      const nextLine = source.indexOf('\n', i);
      if (nextLine === -1) return source.length;
      i = nextLine + 1;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) return source.length;
      i = close + 2;
      continue;
    }
    return i;
  }
}

/** Skip spaces and tabs only — never a newline. */
function skipInlineTrivia(source: string, i: number): number {
  while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++;
  return i;
}
