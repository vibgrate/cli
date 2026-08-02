import * as path from 'node:path';

/**
 * Shared change-event filter for the two file watchers (`vg watch` and the
 * serve-loop watcher in mcp/server.ts): which filesystem events are real
 * source changes, and which are dependency/artifact/VCS noise that must never
 * trigger a rebuild — including vg's own artifacts, or every build would
 * re-trigger itself.
 */
export const WATCH_SKIP_NAMES = new Set([
  '.git',
  'node_modules',
  '.vibgrate',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

/** True when a watch event's filename is a change worth rebuilding for. */
export function isRelevantChange(filename: string): boolean {
  if (filename.split(path.sep).some((p) => WATCH_SKIP_NAMES.has(p))) return false;
  if (filename.includes(`${path.sep}.vibgrate${path.sep}`) || filename.startsWith('.vibgrate')) return false;
  return true;
}
