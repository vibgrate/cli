/**
 * Worktree overlay (Fusion Phase 5).
 *
 * The on-disk code map is keyed by git commit/branch tip. Uncommitted edits in
 * the working tree are not in that map until reparsed. This module lists dirty
 * worktree paths (via `git status --porcelain`) and builds an overlay of those
 * files so {@link applyOverlayToGraph} can produce a worktree-aware ActiveGraph
 * view: base ⊕ worktree (and later ⊕ session).
 *
 * Pure helpers are unit-tested with injectable git status / readFile.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OverlayEntry } from './overlay.js';
import { applyOverlayToGraph, type SessionGraphResult, type SessionParseFn } from './session-graph.js';
import type { VgGraph } from '../schema.js';

export interface WorktreeDirtyOptions {
  /** Injectable `git status --porcelain` body (tests). */
  porcelain?: string;
  /** Max files to reparse (default 80). */
  maxFiles?: number;
  /** File extensions to include (default common source). */
  extensions?: string[];
}

const DEFAULT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.rb',
  '.kt',
  '.swift',
]);

/**
 * List relative paths changed in the worktree (modified/added/untracked).
 * Deterministic sort. Never throws — empty on non-git / errors.
 */
export function listWorktreeDirtyFiles(root: string, options: WorktreeDirtyOptions = {}): string[] {
  const max = options.maxFiles ?? 80;
  const exts = options.extensions ? new Set(options.extensions) : DEFAULT_EXTS;
  const body =
    options.porcelain ??
    (() => {
      try {
        const res = spawnSync('git', ['status', '--porcelain', '-uall'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (res.status !== 0) return '';
        return res.stdout ?? '';
      } catch {
        return '';
      }
    })();

  const files = new Set<string>();
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    // XY PATH or XY ORIG -> PATH for renames
    const ren = /^.. (.+) -> (.+)$/.exec(line);
    const raw = ren ? ren[2]! : line.slice(3).trim();
    const rel = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    if (!rel || rel.startsWith('.git/')) continue;
    const ext = path.extname(rel).toLowerCase();
    if (exts.size && !exts.has(ext)) continue;
    // Skip deleted-only paths (status D) — no content to reparse; strip via delete entry.
    files.add(rel.replace(/\\/g, '/'));
  }
  return [...files].sort().slice(0, max);
}

/**
 * Build overlay entries for dirty worktree files by reading disk content.
 * Deleted paths (missing on disk) become delete entries.
 */
export function buildWorktreeOverlayEntries(
  root: string,
  dirtyFiles: string[],
  options: { readFile?: (abs: string) => string | null } = {},
): Map<string, OverlayEntry> {
  const read =
    options.readFile ??
    ((abs: string) => {
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    });
  const out = new Map<string, OverlayEntry>();
  for (const rel of dirtyFiles) {
    const abs = path.resolve(root, rel);
    const content = read(abs);
    if (content === null) out.set(normalize(rel), { kind: 'delete' });
    else out.set(normalize(rel), { kind: 'write', content });
  }
  return out;
}

/**
 * Materialize base ⊕ worktree graph. Returns base unchanged when no dirty files.
 */
export async function materializeWorktreeGraph(
  base: VgGraph,
  root: string,
  options: WorktreeDirtyOptions & {
    parseFile?: SessionParseFn;
    readFile?: (abs: string) => string | null;
    dirtyFiles?: string[];
  } = {},
): Promise<SessionGraphResult & { dirtyFiles: string[] }> {
  const dirtyFiles = options.dirtyFiles ?? listWorktreeDirtyFiles(root, options);
  if (!dirtyFiles.length) {
    return { graph: base, deleted: [], rewritten: [], reparsed: [], dirtyFiles: [] };
  }
  const entries = buildWorktreeOverlayEntries(root, dirtyFiles, { readFile: options.readFile });
  const result = await applyOverlayToGraph(base, entries, {
    parseFile: options.parseFile,
    readContent: (rel) => {
      const e = entries.get(normalize(rel));
      if (!e || e.kind === 'delete') return null;
      return e.content;
    },
  });
  return { ...result, dirtyFiles };
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
