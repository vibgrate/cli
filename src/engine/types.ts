import type { NodeKind } from '../schema.js';

/** A definition extracted from one file (pre-resolution, pre-id). */
export interface RawDef {
  kind: NodeKind;
  name: string; // short name
  qualifiedName: string; // dotted scope path within the file
  startLine: number; // 1-based
  endLine: number; // 1-based
  startByte: number;
  endByte: number;
  signature?: string;
  doc?: string; // short leading doc-comment / docstring summary (deterministic, truncated)
  visibility?: 'public' | 'private' | 'protected' | 'internal';
}

export interface RawCall {
  callee: string; // short name of the called symbol
  byte: number; // start byte of the call site (for enclosing-scope lookup)
  line: number; // 1-based
}

export interface RawImport {
  source: string; // module specifier (quotes stripped)
}

export interface RawHeritage {
  superName: string; // base type / interface short name
  byte: number; // position (for enclosing-class lookup)
  kind: 'extends' | 'implements';
}

export interface RawGuard {
  expr: string; // the guard/assert expression text (bounded)
  line: number; // 1-based line (mapped to the enclosing def for invariant facts)
}

/** The full result of parsing a single file. */
export interface FileParse {
  rel: string; // relative POSIX path
  lang: string; // vg language id
  hash: string; // blake3 of file contents
  bytes: number; // file size
  defs: RawDef[];
  calls: RawCall[];
  imports: RawImport[];
  heritage: RawHeritage[];
  guards: RawGuard[];
  /** Non-fatal issues (e.g. a query that failed to compile for this grammar). */
  warnings?: string[];
}
