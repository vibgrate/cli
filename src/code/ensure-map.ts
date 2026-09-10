/**
 * Ensure a code map exists before VG Code (or any host) starts work.
 *
 * Interactive CLI, `vg code --stream-json`, and VS Code all share this path so
 * the first turn never fails with "no map found" — we build once (with progress
 * callbacks for host UIs) and then proceed.
 */

import { graphExists } from '../engine/load.js';
import { runBuild } from '../commands/build.js';
import type { GlobalOpts } from '../cli-options.js';
import { attachVgd, daemonDisabledReason, envForNamedVgdSocket } from '../runtime/vgd/attach.js';
import { vgdRequest } from '../runtime/vgd/client.js';

export type EnsureMapPhase = 'start' | 'progress' | 'done' | 'error';

export interface EnsureMapProgress {
  phase: EnsureMapPhase;
  message: string;
  /** 0–100 when known (parse phase); omitted when indeterminate. */
  pct?: number;
}

export interface EnsureMapHooks {
  onProgress?: (p: EnsureMapProgress) => void;
  /**
   * Talk to this vgd socket. Hosts that already started the runtime (VS Code,
   * tests) pass it so this path does not race the default daemon or skip in CI.
   */
  socketPath?: string;
}

/**
 * @returns `ready` when a map already existed; `built` when this call built one.
 */
export async function ensureCodeMap(
  root: string,
  global: GlobalOpts,
  hooks?: EnsureMapHooks,
): Promise<'ready' | 'built'> {
  // Existence only — never parse the map just to know it is there.
  if (graphExists(root, global.graph)) return 'ready';

  const daemonAllowed =
    Boolean(hooks?.socketPath) || !daemonDisabledReason({ disabled: global.daemon === false });
  if (daemonAllowed) {
    try {
      const attached = await attachVgd(root, {
        publish: false,
        disabled: global.daemon === false,
        socketPath: hooks?.socketPath,
        autoStart: hooks?.socketPath ? false : true,
        env: hooks?.socketPath ? envForNamedVgdSocket() : undefined,
      });
      if (attached.status === 'attached' && attached.socketPath) {
        hooks?.onProgress?.({
          phase: 'start',
          message: 'Building the code map for this project… (first run only)',
          pct: 0,
        });
        const ensured = await vgdRequest(
          { op: 'ensure-graph', root, graphPath: global.graph },
          { socketPath: attached.socketPath },
        );
        if (ensured.ok && 'stored' in ensured) {
          hooks?.onProgress?.({ phase: 'done', message: 'Code map ready — starting your task…', pct: 100 });
          return ensured.rebuilt ? 'built' : 'ready';
        }
      }
    } catch {
      /* daemon could not build — fall through to in-process */
    }
  }

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
