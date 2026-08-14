import { resolveGraphPath } from './artifacts.js';
import { loadGraphFileWithSnapshot } from './snapshot.js';
import { loadGraphPreferIndex } from './index-db.js';
import type { VgGraph } from '../schema.js';

/**
 * Load the code map for a repository.
 *
 * When `graphPath` is omitted, prefers an existing global-store snapshot, then
 * the legacy `.vibgrate/graph.json`, matching {@link resolveGraphPath}.
 * Prefers the SQLite index when its corpusHash matches the committed map
 * (faster cold serve on large repos). Returns null if none exists.
 */
export function loadGraph(root: string, graphPath?: string): VgGraph | null {
  const file = resolveGraphPath(root, graphPath);
  // Index is always rooted at the project root; only use it when loading the
  // default map for that root (not an arbitrary --graph path).
  if (!graphPath) {
    const preferred = loadGraphPreferIndex(root, file);
    if (preferred) return preferred.graph;
  }
  return loadGraphFileWithSnapshot(file);
}
