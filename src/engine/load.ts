import * as fs from 'node:fs';
import { defaultGraphPath } from './artifacts.js';
import { parseGraph } from './serialize.js';
import type { VgGraph } from '../schema.js';

/** Load a committed `graph.json`. Returns null if none exists at the path. */
export function loadGraph(root: string, graphPath?: string): VgGraph | null {
  const file = graphPath ?? defaultGraphPath(root);
  if (!fs.existsSync(file)) return null;
  return parseGraph(fs.readFileSync(file, 'utf8'));
}
