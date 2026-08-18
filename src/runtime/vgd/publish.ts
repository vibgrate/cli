import { vgdIsRunning, vgdRequest } from './client.js';

export type VgdPublishOutcome =
  | { status: 'not-running' }
  | { status: 'failed'; error: string }
  /** The daemon already holds this exact map — nothing was sent. */
  | { status: 'current'; repositoryId: string; gitRef: string }
  | { status: 'published'; repositoryId: string; gitRef: string; nodeCount: number; semantic?: string };

export interface VgdPublishOptions {
  /** Override socket path (tests). */
  socketPath?: string;
  /** Branch / detached SHA this map describes; the daemon detects it otherwise. */
  gitRef?: string;
  /** Custom `--graph` artifact, when the map is not at its default location. */
  graphPath?: string;
  /**
   * Also wait for the slot's semantic index. Off by default: publishing already
   * queues a background warm, and a build should not block on embedding.
   */
  warmSemantic?: boolean;
  /** Injected transport (tests). */
  isRunning?: typeof vgdIsRunning;
  request?: typeof vgdRequest;
}

/**
 * Hand a freshly-built code map to a vgd that is **already** running.
 *
 * Without this the daemon only ever learned about a repo through `vg code`, so
 * an ordinary `vg build` left it reporting `0 graph slot(s)` — and because the
 * semantic index hangs off the graph slot, the index never warmed either. The
 * daemon looked idle on a machine that had just spent ten seconds building the
 * very map it was supposed to be holding.
 *
 * `load-graph` rather than `put-graph`: the daemon reads the snapshot from
 * disk itself (binary sidecar when fresh), so a 40k-node map never crosses the
 * socket as one multi-MB JSON line. Storing it runs the registry's slot funnel,
 * which invalidates and re-warms the semantic index for exactly that slot.
 *
 * Never starts a daemon, never throws, and never changes the command's exit
 * status: a machine with no vgd is a supported configuration, not an error.
 */
export async function publishGraphToVgd(root: string, options: VgdPublishOptions = {}): Promise<VgdPublishOutcome> {
  const { socketPath } = options;
  const isRunning = options.isRunning ?? vgdIsRunning;
  const request = options.request ?? vgdRequest;
  try {
    if (!(await isRunning({ socketPath }))) return { status: 'not-running' };

    const loaded = await request(
      { op: 'load-graph', root, gitRef: options.gitRef, graphPath: options.graphPath },
      { socketPath },
    );
    if (!loaded.ok) return { status: 'failed', error: loaded.error };
    if (!('stored' in loaded)) return { status: 'failed', error: 'vgd did not store the map' };

    let semantic: string | undefined;
    if (options.warmSemantic) {
      const indexed = await request(
        { op: 'embed-index', repositoryId: loaded.repositoryId, gitRef: loaded.gitRef },
        { socketPath },
      ).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (indexed.ok && 'state' in indexed) semantic = indexed.state;
    }
    return {
      status: 'published',
      repositoryId: loaded.repositoryId,
      gitRef: loaded.gitRef,
      nodeCount: loaded.nodeCount,
      semantic,
    };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
