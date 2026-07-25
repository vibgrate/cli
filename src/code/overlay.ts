/**
 * Session file overlay (Fusion Runtime Phase 5).
 *
 * Mutations land in an in-memory layer first so the agent can read its own
 * uncommitted edits, run a verification ladder against the session view, and
 * only then {@link SessionOverlay.flush} to the real filesystem. The base
 * {@link CodeFs} is never written until flush.
 *
 * Audit lines always go through to the base (governance must not be buffered).
 */

import type { CodeFs } from './session.js';

export type OverlayEntry =
  | { kind: 'write'; content: string }
  | { kind: 'delete' };

export class SessionOverlay implements CodeFs {
  private readonly dirty = new Map<string, OverlayEntry>();

  constructor(private readonly base: CodeFs) {}

  /** Paths with uncommitted writes or deletes (sorted). */
  dirtyFiles(): string[] {
    return [...this.dirty.keys()].sort();
  }

  /** True if the overlay has any uncommitted mutation. */
  isDirty(): boolean {
    return this.dirty.size > 0;
  }

  read(file: string): string | null {
    const key = normalize(file);
    const entry = this.dirty.get(key);
    if (entry) {
      if (entry.kind === 'delete') return null;
      return entry.content;
    }
    return this.base.read(file);
  }

  write(file: string, content: string): void {
    this.dirty.set(normalize(file), { kind: 'write', content });
  }

  remove(file: string): void {
    this.dirty.set(normalize(file), { kind: 'delete' });
  }

  appendAudit(line: string): void {
    this.base.appendAudit(line);
  }

  /**
   * Commit every dirty entry to the base filesystem, then clear the overlay.
   * Returns the paths flushed (sorted).
   */
  flush(): string[] {
    const files = this.dirtyFiles();
    for (const file of files) {
      const entry = this.dirty.get(file)!;
      if (entry.kind === 'delete') this.base.remove(file);
      else this.base.write(file, entry.content);
    }
    this.dirty.clear();
    return files;
  }

  /** Drop uncommitted mutations without writing the base. */
  discard(): void {
    this.dirty.clear();
  }

  /**
   * Snapshot of dirty entries for tests / diagnostics (path → entry).
   * Does not include base-only files.
   */
  snapshot(): Map<string, OverlayEntry> {
    return new Map(this.dirty);
  }
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
