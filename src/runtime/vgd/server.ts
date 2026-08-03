import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { VGD_PROTOCOL_VERSION, parseRequest, type VgdResponse } from './protocol.js';
import { WorkspaceRegistry } from './registry.js';
import { vgdPidPath, vgdSocketPath } from './paths.js';
import { queryGraph } from '../../engine/query.js';
import { loadGraph } from '../../engine/load.js';
import { impactOf } from '../../engine/impact.js';
import { resolveOne } from '../../engine/lookup.js';
import { getVgdHostBroker, type VgdHostBroker } from './host-broker.js';
import { EmbedBroker } from './embed-broker.js';
import type { VgGraph } from '../../schema.js';

export interface VgdServerOptions {
  /** Override socket path (tests). */
  socketPath?: string;
  /** Override PID path (tests). */
  pidPath?: string;
  registry?: WorkspaceRegistry;
  now?: () => Date;
  /** Process id recorded in status / pid file (tests). */
  pid?: number;
  /** Inject host broker (tests); default process-wide broker. */
  hostBroker?: VgdHostBroker;
  /** Inject the semantic broker (tests); default owns a worker child. */
  embedBroker?: EmbedBroker;
  /**
   * Diagnostic sink. `vg daemon start` points this at stdout so the daemon's
   * work — graph publishes, branch switches, index builds — is visible while
   * it happens instead of being inferred after the fact.
   */
  log?: (message: string) => void;
  /**
   * Invoked (shortly after the reply is written) when a client sends the
   * `shutdown` op. Only a standalone `vg daemon start` passes this — an
   * in-process vgd (e.g. inside `vg code`) leaves it unset, and the op is
   * refused so another process can never take down the owning session.
   */
  onShutdownRequest?: () => void;
}

export interface VgdServer {
  readonly socketPath: string;
  readonly registry: WorkspaceRegistry;
  /** Wall time when the server started listening. */
  readonly startedAt: number;
  close(): Promise<void>;
}

/**
 * Start a line-delimited JSON daemon on the local vgd socket.
 * Creates the daemon directory; removes a stale Unix socket file if present.
 */
export async function startVgdServer(options: VgdServerOptions = {}): Promise<VgdServer> {
  const socketPath = options.socketPath ?? vgdSocketPath();
  const pidPath = options.pidPath ?? vgdPidPath();
  const registry = options.registry ?? new WorkspaceRegistry();
  const hostBroker = options.hostBroker ?? getVgdHostBroker();
  const log = options.log ?? ((): void => {});
  // Semantic warm: the index is slot-scoped like the graph, so it attaches to
  // the registry's lifecycle rather than being managed alongside it by hand.
  const embedBroker = options.embedBroker ?? new EmbedBroker({ log });
  embedBroker.setGraphProvider((repositoryId, gitRef) => registry.graphs.get(repositoryId, gitRef)?.graph);
  registry.setSlotListener(embedBroker);
  const onShutdownRequest = options.onShutdownRequest;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const startedAt = Date.now();

  // Unix sockets need a free path; named pipes on Windows are cleaned by the OS.
  if (!socketPath.startsWith('\\\\.\\pipe')) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* nothing to remove */
    }
  } else {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        void Promise.resolve(
          handleLine(line, { registry, hostBroker, embedBroker, now, pid, startedAt, socketPath, onShutdownRequest, log }),
        ).then(
          (response) => {
            socket.write(JSON.stringify(response) + '\n');
          },
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${pid}\n`, 'utf8');
  } catch {
    /* pid file is best-effort */
  }

  return {
    socketPath,
    registry,
    startedAt,
    async close() {
      // The worker is a child of this process — never leave it orphaned.
      embedBroker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* gone */
      }
      if (!socketPath.startsWith('\\\\.\\pipe')) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          /* gone */
        }
      }
    },
  };
}

async function handleLine(
  line: string,
  ctx: {
    registry: WorkspaceRegistry;
    hostBroker: VgdHostBroker;
    embedBroker: EmbedBroker;
    log: (message: string) => void;
    now: () => Date;
    pid: number;
    startedAt: number;
    socketPath: string;
    onShutdownRequest?: () => void;
  },
): Promise<VgdResponse> {
  const req = parseRequest(line);
  if ('error' in req) return { ok: false, error: req.error, code: 'bad_request' };

  switch (req.op) {
    case 'ping':
      return { ok: true, pong: true, version: VGD_PROTOCOL_VERSION };
    case 'status':
      return {
        ok: true,
        pid: ctx.pid,
        uptimeMs: Date.now() - ctx.startedAt,
        workspaces: ctx.registry.size(),
        graphSlots: ctx.registry.graphs.size(),
        version: VGD_PROTOCOL_VERSION,
        socketPath: ctx.socketPath,
      };
    case 'shutdown': {
      if (!ctx.onShutdownRequest) {
        return {
          ok: false,
          error:
            'this vgd is embedded in another process (e.g. vg code) and cannot be stopped remotely — stop the owning process instead',
          code: 'shutdown_unsupported',
        };
      }
      // Let the reply flush to the client before the listener goes away.
      const hook = ctx.onShutdownRequest;
      setTimeout(() => hook(), 150);
      return { ok: true, stopping: true };
    }
    case 'embed-status':
      return { ok: true, semantic: ctx.embedBroker.status() };
    case 'embed-query': {
      const vector = await ctx.embedBroker.embedQuery(req.text);
      if (!vector) {
        return {
          ok: false,
          error: 'semantic unavailable — rank lexically',
          code: 'semantic_unavailable',
        };
      }
      return { ok: true, vector, model: ctx.embedBroker.status().model };
    }
    case 'embed-index': {
      const gitRef = req.gitRef ?? ctx.registry.graphs.selectedRef(req.repositoryId);
      if (!gitRef) return { ok: false, error: 'no current gitRef for this repository', code: 'no_slot' };
      const slot = ctx.registry.graphs.get(req.repositoryId, gitRef);
      if (!slot) {
        return { ok: false, error: `no graph slot for ${req.repositoryId}@${gitRef} — publish the map first`, code: 'no_slot' };
      }
      const idx = await ctx.embedBroker.ensureIndex(req.repositoryId, gitRef, slot.graph);
      return {
        ok: true,
        indexed: true,
        repositoryId: req.repositoryId,
        gitRef,
        state: idx.state,
        vectors: idx.vectors.size,
        buildMs: idx.buildMs,
      };
    }
    case 'host-status':
      return { ok: true, host: ctx.hostBroker.status() };
    case 'host-load': {
      const r = await ctx.hostBroker.load(req.modelPath);
      if (!r.ok) return { ok: false, error: r.error, code: 'host_error' };
      return { ok: true, hostLoaded: true, modelPath: r.modelPath };
    }
    case 'host-unload': {
      const r = await ctx.hostBroker.unload(req.modelPath);
      return { ok: true, hostUnloaded: true, cleared: r.cleared };
    }
    case 'host-generate': {
      const r = await ctx.hostBroker.generate(
        req.modelPath,
        req.messages.map((m) => ({
          role: (m.role === 'system' || m.role === 'assistant' ? m.role : 'user') as 'system' | 'user' | 'assistant',
          content: m.content,
        })),
        {
          grammar: req.grammar,
          requireGrammar: req.requireGrammar,
          maxTokens: req.maxTokens,
          temperature: req.temperature,
        },
      );
      if (!r.ok) return { ok: false, error: r.error, code: 'host_error' };
      return {
        ok: true,
        hostGenerated: true,
        text: r.result.text,
        model: r.result.model,
        constrained: r.result.constrained,
        grammarApplied: r.result.grammarApplied,
        draftAcceptedChars: r.result.draftAcceptedChars,
        latencyMs: r.result.latencyMs,
        unknownIdentifiers: r.result.unknownIdentifiers,
      };
    }
    case 'list':
      return { ok: true, workspaces: ctx.registry.list() };
    case 'register': {
      const known = ctx.registry.size();
      const workspace = ctx.registry.register(req.root, ctx.now, { label: req.label, role: req.role });
      // A repo the daemon has not seen before is the interesting case — that is
      // when a warm daemon still has cold work to do.
      if (ctx.registry.size() > known) {
        ctx.log(`register: new workspace ${workspace.id} (${workspace.root}${workspace.gitRef ? ` @${workspace.gitRef}` : ''})`);
      }
      return { ok: true, workspace };
    }
    case 'unregister':
      return { ok: true, removed: ctx.registry.unregister(req.root) };
    case 'register-federation': {
      const workspaces = ctx.registry.registerFederation(req.members, ctx.now);
      return { ok: true, workspaces, federation: true };
    }
    case 'list-graph-slots': {
      ctx.registry.graphs.evictIdle();
      return { ok: true, slots: ctx.registry.graphs.list(req.repositoryId) };
    }
    case 'select-git-ref': {
      const before = ctx.registry.graphs.selectedRef(req.repositoryId);
      if (before !== req.gitRef) {
        ctx.log(`select-git-ref: ${req.repositoryId} ${before ?? '(none)'} → ${req.gitRef}`);
      }
      ctx.registry.selectGitRef(req.repositoryId, req.gitRef);
      return { ok: true, selected: true, repositoryId: req.repositoryId, gitRef: req.gitRef };
    }
    case 'put-graph': {
      try {
        // The wire line was already JSON.parse'd by parseRequest — re-encoding a
        // large repo's graph (`parseGraph(JSON.stringify(...))`) blocked the
        // daemon's event loop for seconds, timing out every concurrent client.
        const graph = req.graph as VgGraph;
        ctx.log(`put-graph: ${req.repositoryId}@${req.gitRef} · ${graph.nodes?.length ?? 0} nodes`);
        ctx.registry.putGraph(req.repositoryId, req.gitRef, graph);
        return {
          ok: true,
          stored: true,
          repositoryId: req.repositoryId,
          gitRef: req.gitRef,
          nodeCount: graph.nodes?.length ?? 0,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'invalid graph', code: 'bad_graph' };
      }
    }
    case 'load-graph': {
      // Load from disk inside the daemon: the snapshot-first loader decodes
      // the binary sidecar (msgpack) when fresh — no multi-MB JSON line ever
      // crosses the socket, which is what made put-graph publishes slow on
      // large repos.
      const record = ctx.registry.register(req.root, ctx.now, { gitRef: req.gitRef });
      const gitRef = req.gitRef ?? record.gitRef ?? 'HEAD';
      ctx.log(`load-graph: ${record.id}@${gitRef} from ${req.root}`);
      const graph = loadGraph(req.root, req.graphPath);
      if (!graph) {
        return {
          ok: false,
          error: `no code map found for ${req.root} — run \`vg build\` (or bare \`vg\`) first`,
          code: 'no_map',
        };
      }
      ctx.registry.putGraph(record.id, gitRef, graph);
      return {
        ok: true,
        stored: true,
        repositoryId: record.id,
        gitRef,
        nodeCount: graph.nodes?.length ?? 0,
      };
    }
    case 'query-graph': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const result = queryGraph(resolved.graph, req.query, { limit: req.limit ?? 12, budget: 2000 });
      return {
        ok: true,
        query: req.query,
        repositoryId: req.repositoryId,
        gitRef: resolved.gitRef,
        matches: result.matches.slice(0, req.limit ?? 12).map((m) => ({
          id: m.node.id,
          qualifiedName: m.node.qualifiedName,
          kind: m.node.kind,
          file: m.node.file,
          line: m.node.span?.start ?? 0,
          score: m.score,
          why: m.why,
        })),
        tokensEstimate: result.tokensEstimate,
      };
    }
    case 'impact-of': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const node = resolveSymbol(resolved.graph, req.symbol);
      if (!node) {
        return { ok: false, error: `symbol not found: ${req.symbol}`, code: 'not_found' };
      }
      const impact = impactOf(resolved.graph, node.id, { depth: req.depth ?? 4 });
      return {
        ok: true,
        repositoryId: req.repositoryId,
        gitRef: resolved.gitRef,
        symbol: req.symbol,
        root: impact.root,
        depth: impact.depth,
        affected: impact.affected.slice(0, 40).map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          file: a.file,
          line: a.line,
          depth: a.depth,
          confidence: a.confidence,
        })),
        direct: impact.direct,
        transitive: impact.transitive,
      };
    }
    case 'graph-summary': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const g = resolved.graph;
      return {
        ok: true,
        repositoryId: req.repositoryId,
        gitRef: resolved.gitRef,
        summary: {
          nodeCount: g.nodes?.length ?? 0,
          edgeCount: g.edges?.length ?? 0,
          languages: g.meta?.languages ?? [],
          corpusHash: g.provenance?.corpusHash ?? null,
          root: g.meta?.root ?? null,
        },
      };
    }
  }
}

function resolveSymbol(graph: VgGraph, symbol: string): { id: string } | null {
  // Prefer exact id, then qualified-name / short-name lookup.
  if (graph.nodes.some((n) => n.id === symbol)) return { id: symbol };
  const hit = resolveOne(graph, symbol);
  if (hit.node?.id) return { id: hit.node.id };
  if (hit.candidates.length === 1 && hit.candidates[0]?.id) return { id: hit.candidates[0].id };
  const q = symbol.toLowerCase();
  const byQn = graph.nodes.find((n) => n.qualifiedName?.toLowerCase() === q || n.name?.toLowerCase() === q);
  return byQn ? { id: byQn.id } : null;
}
