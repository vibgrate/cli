import * as path from 'node:path';
import { loadGraph } from '../engine/load.js';
import { CliError, ExitCode } from '../util/exit.js';
import type { GlobalOpts } from '../cli-options.js';
import type { VgGraph } from '../schema.js';

export function rootOf(global: GlobalOpts): string {
  return path.resolve(global.cwd ?? '.');
}

/** Load the committed graph, or fail with an actionable NOT_FOUND error. */
export function requireGraph(global: GlobalOpts): { root: string; graph: VgGraph } {
  const root = rootOf(global);
  const graph = loadGraph(root, global.graph);
  if (!graph) {
    throw new CliError(
      `no map found — run \`vg\` to build one first` +
        (global.graph ? ` (looked at ${global.graph})` : ''),
      ExitCode.NOT_FOUND,
    );
  }
  return { root, graph };
}
