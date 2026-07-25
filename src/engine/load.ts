import * as fs from 'node:fs';
import { resolveGraphPath } from './artifacts.js';
import { parseGraph } from './serialize.js';
import type { VgGraph } from '../schema.js';

/**
 * Load the code map for a repository.
 *
 * When `graphPath` is omitted, prefers an existing global-store snapshot, then
 * the legacy `.vibgrate/graph.json`, matching {@link resolveGraphPath}.
 * Returns null if none exists at the resolved path.
 */
export function loadGraph(root: string, graphPath?: string): VgGraph | null {
  const file = resolveGraphPath(root, graphPath);
  if (!fs.existsSync(file)) return null;
  return parseGraph(fs.readFileSync(file, 'utf8'));
}
