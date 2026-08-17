import { redactSecrets } from '../../core-open/utils/redact.js';
import type { ToolchainSpan } from './types.js';

/**
 * Shared helpers for the toolchain extractors. Everything here is pure and
 * deterministic — no clock, no randomness, no filesystem.
 */

/** Hard cap on bytes an extractor will parse. Beyond this the file is skipped. */
export const TOOLCHAIN_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Cap on nodes emitted from a single file — a generated 40k-line manifest is not worth unbounded graph. */
export const TOOLCHAIN_NODES_PER_FILE_MAX = 2_000;

/** Cap on the length of a `doc` summary. */
const DOC_MAX_CHARS = 240;

/**
 * Line-offset index for a source file: converts a byte offset to a 1-based
 * line number. Built once per file, then binary-searched — extracting a
 * thousand spans must not be quadratic in file size.
 */
export class LineIndex {
  /** Byte offset at which each line starts. */
  private readonly starts: number[];

  constructor(source: string) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    this.starts = starts;
  }

  /** 1-based line number containing `offset`. */
  lineAt(offset: number): number {
    if (offset <= 0) return 1;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Span covering the byte range `[start, end)`. */
  span(start: number, end: number): ToolchainSpan {
    const s = this.lineAt(start);
    // `end` is exclusive; step back one byte so a range ending exactly at a
    // newline reports the line it ends on rather than the next, empty one.
    const e = this.lineAt(Math.max(start, end - 1));
    return { start: s, end: Math.max(s, e) };
  }

  get lineCount(): number {
    return this.starts.length;
  }
}

/**
 * Prepare a human-readable summary for storage.
 *
 * GUARDRAILS §1.1 is redact-at-ingest, not at display: IaC and CI files are
 * exactly where live credentials turn up, so every summary that reaches a node
 * passes through here before it is ever written to `graph.json`.
 */
export function safeDoc(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  const redacted = redactSecrets(collapsed);
  return redacted.length > DOC_MAX_CHARS ? `${redacted.slice(0, DOC_MAX_CHARS - 1)}…` : redacted;
}

/**
 * Is this value a reference to a secret rather than a secret itself?
 *
 * Extractors record *references* (`secrets.NPM_TOKEN`, `${var.db_password}`,
 * a `secretKeyRef` name) because those are the useful graph edges. A literal
 * that merely looks secret-shaped is dropped rather than recorded.
 */
export function isSecretReference(value: string): boolean {
  return (
    /^\$\{\{?\s*secrets\./i.test(value) ||
    /^\$\{?\s*(var|local)\./i.test(value) ||
    /^\$\{?[A-Z0-9_]+\}?$/.test(value)
  );
}

/**
 * Normalise a container image reference into `{registry, repository, tag, digest}`.
 *
 * Deliberately does not apply Docker Hub's implicit `docker.io/library` default:
 * the linker matches what a repository actually wrote, and inventing a registry
 * would make `web:latest` in a Compose file stop matching `web:latest` in a
 * workflow's `docker build -t`.
 */
export interface ImageRef {
  /** The full reference as written. */
  raw: string;
  /** Everything before the tag/digest. */
  repository: string;
  tag?: string;
  digest?: string;
}

export function parseImageRef(raw: string): ImageRef | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  // An expansion — `${{ env.IMAGE }}`, `{{ .Values.image }}`, or a bare
  // `$BASE` build arg — is not a resolvable image. Recording it would create a
  // node that matches nothing, so it is dropped rather than guessed at.
  if (value.includes('$') || value.includes('{{')) return null;

  const atIdx = value.lastIndexOf('@');
  let digest: string | undefined;
  let rest = value;
  if (atIdx > 0) {
    digest = value.slice(atIdx + 1);
    rest = value.slice(0, atIdx);
  }

  let tag: string | undefined;
  const colonIdx = rest.lastIndexOf(':');
  // A colon before the last `/` is a registry port (`localhost:5000/img`), not a tag.
  if (colonIdx > 0 && colonIdx > rest.lastIndexOf('/')) {
    tag = rest.slice(colonIdx + 1);
    rest = rest.slice(0, colonIdx);
  }
  if (!rest) return null;
  return { raw: value, repository: rest, tag, digest };
}

/**
 * The identity two image references are matched on by the linker: repository
 * plus digest when pinned, else repository plus tag. `latest` is treated as a
 * real tag — pretending it is absent makes unrelated images collide.
 */
export function imageIdentity(ref: ImageRef): string {
  if (ref.digest) return `${ref.repository}@${ref.digest}`;
  return ref.tag ? `${ref.repository}:${ref.tag}` : ref.repository;
}

/** Deterministic sort for drafts: by qualifiedName, then kind. */
export function byQualifiedName<T extends { qualifiedName: string; kind: string }>(a: T, b: T): number {
  return a.qualifiedName.localeCompare(b.qualifiedName, 'en') || a.kind.localeCompare(b.kind, 'en');
}

/** POSIX-normalise a repo-relative path (Windows hosts write `\`). */
export function toPosix(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/**
 * Resolve a relative path against a file's directory, POSIX-style, without
 * touching the filesystem. Returns null if the result escapes the repo root —
 * a Compose `build.context` of `../../../etc` must never produce a node
 * claiming to be a repository file.
 */
export function resolveRelative(fromFileRel: string, target: string): string | null {
  const base = toPosix(fromFileRel).split('/').slice(0, -1);
  const parts = toPosix(target).split('/');
  const out = [...base];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null; // escaped the root
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return joined || null;
}
