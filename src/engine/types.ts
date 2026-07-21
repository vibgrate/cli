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
  /** True when the call site had a receiver/qualifier (`obj.foo()`, `pkg::foo()`); the receiver itself is not captured. */
  qualified?: boolean;
}

export interface RawImport {
  source: string; // module specifier (quotes stripped)
}

export interface RawHeritage {
  superName: string; // base type / interface short name
  byte: number; // position (for enclosing-class lookup)
  kind: 'extends' | 'implements';
}

/** A type used as a constructor parameter or field's declared type — a
 * structural dependency (e.g. Spring constructor/field injection) rather than
 * an invocation. Resolved to a `references` edge, not a `call` edge. */
export interface RawTypeRef {
  name: string; // short type name
  byte: number; // position (for enclosing-def lookup)
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
  typeRefs: RawTypeRef[];
  guards: RawGuard[];
  /**
   * Namespaces this file declares (C#/package-scoped langs). Used to resolve a
   * cross-directory reference when the caller `using`-imports the namespace the
   * target is declared in — the correct scoping rule for C#, where a namespace
   * is decoupled from the directory (unlike Java/Go, where package == dir).
   * Empty/absent for languages with no namespace query.
   */
  namespaces?: string[];
  /** Non-fatal issues (e.g. a query that failed to compile for this grammar). */
  warnings?: string[];
}
