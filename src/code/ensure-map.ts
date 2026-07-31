/**
 * Ensure a code map exists before VG Code (or any host) starts work.
 *
 * Interactive CLI, `vg code --stream-json`, and VS Code all share this path so
 * the first turn never fails with "no map found" — we build once (with progress
 * callbacks for host UIs) and then proceed.
 */

import { loadGraph } from '../engine/load.js';
import { runBuild } from '../commands/build.js';
import type { GlobalOpts } from '../cli-options.js';

export type EnsureMapPhase = 'start' | 'progress' | 'done' | 'error';

export interface EnsureMapProgress {
  phase: EnsureMapPhase;
  message: string;
  /** 0–100 when known (parse phase); omitted when indeterminate. */
  pct?: number;
}

export interface EnsureMapHooks {
  onProgress?: (p: EnsureMapProgress) => void;
}

/**
 * @returns `ready` when a map already existed; `built` when this call built one.
 */
export async function ensureCodeMap(
  root: string,
  global: GlobalOpts,
  hooks?: EnsureMapHooks,
): Promise<'ready' | 'built'> {
  if (loadGraph(root, global.graph)) return 'ready';

  hooks?.onProgress?.({
    phase: 'start',
    message: 'Building the code map for this project… (first run only)',
    pct: 0,
  });

  try {
    await runBuild(
      [root],
      { html: false, report: false },
      { ...global, quiet: true },
      {
        onParseProgress: (done, total) => {
          const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : undefined;
          hooks?.onProgress?.({
            phase: 'progress',
            message:
              total > 0
                ? `Parsing files… ${done.toLocaleString()}/${total.toLocaleString()}`
                : 'Parsing files…',
            pct,
          });
        },
      },
    );
    hooks?.onProgress?.({ phase: 'done', message: 'Code map ready — starting your task…', pct: 100 });
    return 'built';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    hooks?.onProgress?.({
      phase: 'error',
      message: `Could not build the code map: ${message}`,
    });
    throw e;
  }
}
