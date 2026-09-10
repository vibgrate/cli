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
  // .NET / JVM — discover() already prunes these; a watcher that does not
  // will treat MSBuild / javac output as source edits and fork a full
  // `vg build` every few seconds (the VS Code + vgd memory pile-up).
  'bin',
  'obj',
  '.vs',
  'TestResults',
  '.gradle',
]);

/** True when a watch event's filename is a change worth rebuilding for. */
export function isRelevantChange(filename: string): boolean {
  // fs.watch on Windows recursive sometimes reports `/` even though path.sep
  // is `\`. Split on both so `obj/Debug/x.cs` is skipped the same as `obj\…`.
  const parts = filename.split(/[\\/]/);
  if (parts.some((p) => WATCH_SKIP_NAMES.has(p))) return false;
  if (filename.startsWith('.vibgrate')) return false;
  if (parts.includes('.vibgrate')) return false;
  return true;
}
