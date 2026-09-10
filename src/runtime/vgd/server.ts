import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { VGD_PROTOCOL_VERSION, parseRequest, type VgdResponse } from './protocol.js';
import { VERSION } from '../../version.js';
import { WorkspaceRegistry } from './registry.js';
import { vgdPidPath, vgdSocketPath } from './paths.js';
import { queryGraph, queryGraphSemantic } from '../../engine/query.js';
import { loadGraph } from '../../engine/load.js';
import { resolveGraphPath } from '../../engine/artifacts.js';
import { globalGraphPathForRef } from '../paths.js';
import { clearDetectGitRefCache, detectGitRef } from '../git-ref.js';
import { mapFileStat } from '../../engine/snapshot.js';
import { impactOf } from '../../engine/impact.js';
import { resolveOne } from '../../engine/lookup.js';
import { runGraphQuery, type GraphQueryParams } from '../../lsp/graph-query.js';
import { TOOLS } from '../../mcp/tools.js';
import { getVgdHostBroker, type VgdHostBroker } from './host-broker.js';
import { EmbedBroker } from './embed-broker.js';
import { FreshnessSupervisor, spawnRebuild, DEFAULT_REBUILD_TIMEOUT_MS } from './freshness.js';
import { DepContextCache } from './dep-cache.js';
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
  /** Inject the freshness supervisor (tests); default watches every registered root. */
  freshness?: FreshnessSupervisor;
  /** Inject the shared dependency-context cache (tests). */
  depCache?: DepContextCache;
  /** Watch registered workspaces and rebuild on drift (default true). */
  watch?: boolean;
  /**
   * Rebuild a repo that has no on-disk map (`ensure-graph`). Default is a
   * detached `vg build --no-daemon --no-warm` child. Tests inject a writer.
   */
  rebuild?: (root: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Diagnostic sink. `vg daemon start` points this at stdout so the daemon's
   * work — graph publishes, branch switches, index builds — is visible while
   * it happens instead of being inferred after the fact.
   */
  log?: (message: string) => void;
  /**
   * Invoked (shortly after the reply is written) when a client sends the
   * `shutdown` op. Only a standalone `vg daemon start` passes this — a
   * listener started without the hook refuses the op so another process
   * cannot take down the owning process.
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
  const watchEnabled = options.watch !== false;
  // Freshness belongs where the graphs are. Reloading is the daemon's own
  // cheap disk read; the expensive rebuild happens in a child (see freshness.ts).
  const freshness =
    options.freshness ??
    new FreshnessSupervisor({
      log,
      reload: (repositoryId, root, gitRef) => {
        const graph = loadGraph(root);
        if (!graph) return Promise.resolve(null);
        registry.putGraph(repositoryId, gitRef, graph);
        return Promise.resolve(graph.nodes?.length ?? 0);
      },
      select: (repositoryId, gitRef) => registry.selectGitRef(repositoryId, gitRef),
    });
  // Semantic warm: the index is slot-scoped like the graph, so it attaches to
  // the registry's lifecycle rather than being managed alongside it by hand.
  // Skip warming a slot whose repo is mid-rebuild — those vectors will be
  // dropped the moment the child lands.
  const embedBroker =
    options.embedBroker ??
    new EmbedBroker({
      log,
      isRebuilding: (repositoryId) =>
        watchEnabled && freshness.list().some((s) => s.repositoryId === repositoryId && s.building),
    });
  embedBroker.setGraphProvider((repositoryId, gitRef) => registry.graphs.get(repositoryId, gitRef)?.graph);
  const rebuildImpl =
    options.rebuild ?? ((root: string) => spawnRebuild(root, DEFAULT_REBUILD_TIMEOUT_MS));
  const inflightEnsure = new Map<string, Promise<VgdResponse>>();
  // Shared dependency context: one manifest walk per daemon instead of one per
  // process, per call. Invalidated by the freshness watcher below, which is
  // already the component that notices a manifest write.
  const depCache = options.depCache ?? new DepContextCache({ log });
  freshness.setManifestListener((repositoryId) => depCache.invalidate(repositoryId));
  // The repo root lives in the registry, never on the graph (`meta.root` is
  // relative so snapshots stay portable) — the broker needs it to reuse the
  // on-disk vectors `vg embed` already wrote instead of re-deriving them.
  embedBroker.setRootProvider((repositoryId) => registry.getById(repositoryId)?.root);
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

  /**
   * Sockets holding an open `watch-slots` subscription, with the repository
   * they care about (undefined = every repository). This is the one place the
   * daemon speaks unprompted: it exists so a long-lived client can retire its
   * own filesystem watcher instead of duplicating the daemon's.
   */
  const subscribers = new Map<net.Socket, { repositoryId?: string }>();

  const broadcastSlot = (repositoryId: string, gitRef: string, graph: VgGraph): void => {
    if (!subscribers.size) return;
    const frame =
      JSON.stringify({
        ok: true,
        event: 'slot-changed',
        repositoryId,
        gitRef,
        nodeCount: graph.nodes?.length ?? 0,
        corpusHash: graph.provenance?.corpusHash ?? null,
      }) + '\n';
    for (const [socket, filter] of subscribers) {
      if (filter.repositoryId && filter.repositoryId !== repositoryId) continue;
      try {
        socket.write(frame);
      } catch {
        subscribers.delete(socket);
      }
    }
  };
  registry.setPublishListener(broadcastSlot);

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('close', () => subscribers.delete(socket));
    socket.on('error', () => subscribers.delete(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        void Promise.resolve(
          handleLine(line, {
            registry,
            hostBroker,
            embedBroker,
            freshness: watchEnabled ? freshness : undefined,
            depCache,
            rebuild: rebuildImpl,
            inflightEnsure,
            subscribe: (repositoryId) => {
              subscribers.set(socket, { repositoryId });
              log(`watch-slots: subscriber attached${repositoryId ? ` for ${repositoryId}` : ' (all repositories)'}`);
            },
            now,
            pid,
            startedAt,
            socketPath,
            onShutdownRequest,
            log,
          }),
        ).then(
          (response) => {
            socket.write(JSON.stringify(response) + '\n');
          },
          (err) => {
            try {
              socket.write(
                JSON.stringify({
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                  code: 'internal',
                }) + '\n',
              );
            } catch {
              /* socket already gone */
            }
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
      freshness.stopAll();
      depCache.clear();
      // watch-slots connections stay open for the life of the client.
      // `net.Server.close()` waits for them, so a daemon stop with an LSP or
      // `vg serve` still subscribed would hang until those processes exited.
      // Destroying them is what fires the client's onDetach → local watch.
      for (const socket of subscribers.keys()) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      subscribers.clear();
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
    freshness?: FreshnessSupervisor;
    depCache: DepContextCache;
    rebuild: (root: string) => Promise<{ ok: boolean; error?: string }>;
    inflightEnsure: Map<string, Promise<VgdResponse>>;
    /** Hold this connection open as a slot subscriber. */
    subscribe?: (repositoryId?: string) => void;
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
    case 'status': {
      const mem = process.memoryUsage();
      return {
        ok: true,
        pid: ctx.pid,
        uptimeMs: Date.now() - ctx.startedAt,
        workspaces: ctx.registry.size(),
        graphSlots: ctx.registry.graphs.size(),
        version: VGD_PROTOCOL_VERSION,
        socketPath: ctx.socketPath,
        cliVersion: VERSION,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          graphSlots: ctx.registry.graphs.size(),
          embedSlots: ctx.embedBroker.status().slots.length,
        },
        freshness: ctx.freshness?.list() ?? [],
      };
    }
    case 'shutdown': {
      if (!ctx.onShutdownRequest) {
        return {
          ok: false,
          error:
            'this vgd cannot be stopped remotely — it is running inside another process; stop that process instead',
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
      if (req.wait === false) {
        void ctx.embedBroker.ensureIndex(req.repositoryId, gitRef, slot.graph, { waitForWriter: true });
        const kicked = ctx.embedBroker.slot(req.repositoryId, gitRef);
        return {
          ok: true,
          indexed: true,
          repositoryId: req.repositoryId,
          gitRef,
          state: kicked?.state ?? 'building',
          vectors: kicked?.vectors.size ?? 0,
          buildMs: kicked?.buildMs,
        };
      }
      const idx = await ctx.embedBroker.ensureIndex(req.repositoryId, gitRef, slot.graph, { waitForWriter: true });
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
    case 'embed-rank': {
      const gitRef = req.gitRef ?? ctx.registry.graphs.selectedRef(req.repositoryId);
      if (!gitRef) return { ok: false, error: 'no current gitRef for this repository', code: 'no_slot' };
      const slot = ctx.registry.graphs.get(req.repositoryId, gitRef);
      if (!slot) {
        return { ok: false, error: `no graph slot for ${req.repositoryId}@${gitRef} — publish the map first`, code: 'no_slot' };
      }
      // Rank immediately when any vectors are resident (including a stale copy
      // kept across republish). If the slot is empty, kick a background build
      // and tell the caller it is warming — blocking here is what made
      // `vg ask` sit silent for tens of seconds.
      const existing = ctx.embedBroker.slot(req.repositoryId, gitRef);
      if (existing && existing.vectors.size > 0) {
        if (existing.state !== 'ready') {
          void ctx.embedBroker.ensureIndex(req.repositoryId, gitRef, slot.graph);
        }
      } else {
        void ctx.embedBroker.ensureIndex(req.repositoryId, gitRef, slot.graph, { waitForWriter: true });
        const warming = ctx.embedBroker.slot(req.repositoryId, gitRef);
        return {
          ok: false,
          error: 'semantic index is warming — retry shortly',
          code: 'semantic_warming',
          state: warming?.state ?? 'building',
          vectors: warming?.vectors.size ?? 0,
          pending: warming?.pending,
          nodeCount: warming?.nodeCount,
        };
      }
      const started = Date.now();
      const result = await ctx.embedBroker.rank(req.repositoryId, gitRef, req.text, req.limit);
      if (!result) {
        return { ok: false, error: 'semantic unavailable — rank lexically', code: 'semantic_unavailable' };
      }
      return {
        ok: true,
        ranked: result.ranked,
        repositoryId: req.repositoryId,
        gitRef,
        state: result.state,
        vectors: result.vectors,
        model: ctx.embedBroker.status().model,
        rankMs: Date.now() - started,
      };
    }
    case 'watch-slots': {
      if (!ctx.subscribe) {
        return { ok: false, error: 'this listener does not support subscriptions', code: 'unsupported' };
      }
      ctx.subscribe(req.repositoryId);
      return { ok: true, watching: true, repositoryId: req.repositoryId };
    }
    case 'dep-context': {
      const record = ctx.registry.getById(req.repositoryId);
      if (!record) {
        return { ok: false, error: `unknown repository ${req.repositoryId} — register it first`, code: 'not_found' };
      }
      const context = ctx.depCache.get(req.repositoryId, record.root);
      if (!context) {
        return { ok: false, error: 'could not read this repository’s manifests', code: 'no_deps' };
      }
      return {
        ok: true,
        repositoryId: req.repositoryId,
        manifestHash: context.manifestHash,
        dependencies: context.inventory.records.map((r) => ({
          name: r.name,
          ecosystem: r.ecosystem,
          declared: r.declared,
          installed: r.installed,
        })),
        builtAt: context.builtAt,
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
      // The process-lifetime git-ref cache is wrong in a daemon that outlives
      // checkouts. Re-detect on every register so a branch switch is visible.
      clearDetectGitRefCache(req.root);
      const workspace = ctx.registry.register(req.root, ctx.now, { label: req.label, role: req.role });
      // A repo the daemon has not seen before is the interesting case — that is
      // when a warm daemon still has cold work to do.
      if (ctx.registry.size() > known) {
        ctx.log(`register: new workspace ${workspace.id} (${workspace.root}${workspace.gitRef ? ` @${workspace.gitRef}` : ''})`);
      }
      return { ok: true, workspace };
    }
    case 'unregister': {
      const record = ctx.registry.get(req.root);
      if (record) ctx.freshness?.stop(record.id);
      return { ok: true, removed: ctx.registry.unregister(req.root) };
    }
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
      // A selected ref with no resident slot is not "serve some other branch".
      // Try the on-disk snapshot for that ref so a checkout the daemon has
      // seen before is instant; otherwise queries return no_graph until
      // ensure-graph rebuilds it.
      if (!ctx.registry.graphs.get(req.repositoryId, req.gitRef)) {
        loadRefFromDisk(ctx, req.repositoryId, req.gitRef);
      }
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
        startWatching(ctx, req.repositoryId, req.gitRef);
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
      return loadGraphIntoSlot(ctx, req.root, req.gitRef, req.graphPath, { rebuildIfMissing: false });
    }
    case 'ensure-graph': {
      // Single-flight per root: two clients asking at once share one child
      // rebuild rather than two `vg build` processes fighting over one lock.
      const key = path.resolve(req.root);
      const existing = ctx.inflightEnsure.get(key);
      if (existing) return existing;
      const work = loadGraphIntoSlot(ctx, req.root, req.gitRef, req.graphPath, { rebuildIfMissing: true }).finally(
        () => {
          if (ctx.inflightEnsure.get(key) === work) ctx.inflightEnsure.delete(key);
        },
      );
      ctx.inflightEnsure.set(key, work);
      return work;
    }
    case 'graph-query': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const record = ctx.registry.getById(req.repositoryId);
      const root = record?.root ?? '.';
      const params: GraphQueryParams = {
        mode: req.mode as GraphQueryParams['mode'],
        question: req.question,
        semantic: req.semantic,
        budget: req.budget,
        limit: req.limit,
        name: req.name,
        depth: req.depth,
        a: req.a,
        b: req.b,
        callers: req.callers,
      };
      const result = await runGraphQuery(resolved.graph, params, {
        root,
        offline: false,
        semantic: req.semantic !== false,
        rank: async (question) => {
          const ranking = await ctx.embedBroker.rank(req.repositoryId, resolved.gitRef, question);
          if (!ranking?.ranked.length) return null;
          return {
            ranked: ranking.ranked,
            vectors: ranking.vectors,
            model: ctx.embedBroker.status().model,
          };
        },
      });
      return {
        ok: true,
        graphQuery: true,
        repositoryId: req.repositoryId,
        gitRef: resolved.gitRef,
        result,
      };
    }
    case 'query-graph': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const limit = req.limit ?? 12;
      let mode = 'lexical';
      let result = queryGraph(resolved.graph, req.query, { limit, budget: 2000 });
      if (req.semantic) {
        // Rank and fuse here: the caller asked for semantic precisely because
        // it holds neither the graph nor the embedder. A slot whose index is
        // not ready answers lexically rather than making the caller wait.
        const ranking = await ctx.embedBroker.rank(req.repositoryId, resolved.gitRef, req.query);
        if (ranking && ranking.ranked.length) {
          result = await queryGraphSemantic(resolved.graph, req.query, {
            limit,
            budget: 2000,
            semanticRanked: ranking.ranked,
          });
          mode = `semantic (vgd${ctx.embedBroker.status().model ? `, ${ctx.embedBroker.status().model}` : ''})`;
        }
      }
      return {
        ok: true,
        query: req.query,
        repositoryId: req.repositoryId,
        gitRef: resolved.gitRef,
        mode,
        matches: result.matches.slice(0, limit).map((m) => ({
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
          fileCount: fileCountOf(g),
        },
      };
    }
    case 'run-tool': {
      const resolved = ctx.registry.resolveGraph(req.repositoryId, req.gitRef);
      if (!resolved) {
        return { ok: false, error: 'no ActiveGraph loaded for repository — put-graph first', code: 'no_graph' };
      }
      const tool = TOOLS.find((t) => t.name === req.name);
      if (!tool) {
        return { ok: false, error: `unknown tool "${req.name}"`, code: 'unknown_tool' };
      }
      const record = ctx.registry.getById(req.repositoryId);
      const seen = new Set(req.seen ?? []);
      try {
        const result = await tool.handler(resolved.graph, req.args ?? {}, {
          root: record?.root ?? '.',
          local: req.local,
          dedup: req.dedup,
          seen,
          graphPath: record?.graphPath,
          rank: async (question) => {
            const ranking = await ctx.embedBroker.rank(req.repositoryId, resolved.gitRef, question);
            if (!ranking?.ranked.length) return null;
            return {
              ranked: ranking.ranked,
              vectors: ranking.vectors,
              model: ctx.embedBroker.status().model,
            };
          },
        });
        return { ok: true, tool: true, name: req.name, result, seen: [...seen] };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'tool_failed',
        };
      }
    }
  }
}

/**
 * Put this repo's on-disk map into a slot, or — when `rebuildIfMissing` — spawn
 * a child `vg build` and then load. Idempotent: a slot that already holds a
 * map as new as the disk file is left alone, so a second publish does not
 * drop the semantic index.
 */
async function loadGraphIntoSlot(
  ctx: {
    registry: WorkspaceRegistry;
    freshness?: FreshnessSupervisor;
    rebuild: (root: string) => Promise<{ ok: boolean; error?: string }>;
    log: (message: string) => void;
    now: () => Date;
  },
  root: string,
  gitRefArg: string | undefined,
  graphPath: string | undefined,
  options: { rebuildIfMissing: boolean },
): Promise<VgdResponse> {
  clearDetectGitRefCache(root);
  const record = ctx.registry.register(root, ctx.now, { gitRef: gitRefArg });
  const gitRef = gitRefArg ?? record.gitRef ?? 'HEAD';
  const held = alreadyHeldSlot(ctx.registry, record.id, gitRef, root, graphPath);
  if (held) {
    startWatching(ctx, record.id, gitRef);
    ctx.log(`load-graph: ${record.id}@${gitRef} already held (${held.nodeCount} nodes) — not reloading`);
    return {
      ok: true,
      stored: true,
      repositoryId: record.id,
      gitRef: held.gitRef,
      nodeCount: held.nodeCount,
      alreadyHeld: true,
    };
  }

  ctx.log(`load-graph: ${record.id}@${gitRef} from ${root}`);
  let graph = loadGraph(root, graphPath);
  let rebuilt = false;
  if (!graph && options.rebuildIfMissing) {
    ctx.log(`ensure-graph: no map for ${root} — rebuilding in a child`);
    const result = await ctx.rebuild(root);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `could not build a code map for ${root}`,
        code: 'rebuild_failed',
      };
    }
    graph = loadGraph(root, graphPath);
    rebuilt = true;
  }
  if (!graph) {
    return {
      ok: false,
      error: `no code map found for ${root} — run \`vg build\` (or bare \`vg\`) first`,
      code: 'no_map',
    };
  }
  ctx.registry.putGraph(record.id, gitRef, graph);
  startWatching(ctx, record.id, gitRef);
  return {
    ok: true,
    stored: true,
    repositoryId: record.id,
    gitRef,
    nodeCount: graph.nodes?.length ?? 0,
    rebuilt: rebuilt || undefined,
  };
}

function alreadyHeldSlot(
  registry: WorkspaceRegistry,
  repositoryId: string,
  gitRef: string,
  root: string,
  graphPath: string | undefined,
): { gitRef: string; nodeCount: number } | null {
  const slot =
    (gitRef ? registry.graphs.get(repositoryId, gitRef) : undefined) ?? registry.graphs.current(repositoryId);
  if (!slot || slot.nodeCount <= 0) return null;
  try {
    const file = resolveGraphPath(root, graphPath);
    const st = mapFileStat(file);
    // Disk is newer than the slot — a `vg build` landed since we loaded.
    if (st.mtimeMs > slot.loadedAt) return null;
  } catch {
    // No on-disk file: keep the resident slot rather than dropping it.
  }
  return { gitRef: slot.gitRef, nodeCount: slot.nodeCount };
}

/**
 * Load a (repositoryId, gitRef) slot from disk without shipping the graph over
 * the socket. Used by `select-git-ref` so a previously built branch is instant.
 */
function loadRefFromDisk(
  ctx: { registry: WorkspaceRegistry; freshness?: FreshnessSupervisor; log: (message: string) => void; now: () => Date },
  repositoryId: string,
  gitRef: string,
): void {
  const record = ctx.registry.getById(repositoryId);
  if (!record) return;
  const fromRefPath = loadGraph(record.root, globalGraphPathForRef(record.root, gitRef));
  if (fromRefPath) {
    ctx.registry.putGraph(repositoryId, gitRef, fromRefPath);
    startWatching(ctx, repositoryId, gitRef);
    ctx.log(`select-git-ref: loaded ${repositoryId}@${gitRef} from disk (${fromRefPath.nodes?.length ?? 0} nodes)`);
    return;
  }
  // In-repo / current-HEAD snapshot only if this process is actually on that ref.
  clearDetectGitRefCache(record.root);
  if (detectGitRef(record.root).ref !== gitRef) return;
  const current = loadGraph(record.root);
  if (!current) return;
  ctx.registry.putGraph(repositoryId, gitRef, current);
  startWatching(ctx, repositoryId, gitRef);
  ctx.log(`select-git-ref: loaded ${repositoryId}@${gitRef} from HEAD snapshot (${current.nodes?.length ?? 0} nodes)`);
}

function fileCountOf(graph: VgGraph): number {
  const files = new Set<string>();
  for (const n of graph.nodes ?? []) if (n.file) files.add(n.file);
  return files.size;
}

/**
 * Begin watching a repository the moment the daemon actually holds its map.
 * Registration alone is not enough: a root with no slot has nothing to keep
 * fresh, and the VS Code extension registers roots it never publishes.
 */
function startWatching(
  ctx: { registry: WorkspaceRegistry; freshness?: FreshnessSupervisor },
  repositoryId: string,
  gitRef: string,
): void {
  const record = ctx.registry.getById(repositoryId);
  if (record) ctx.freshness?.start(repositoryId, record.root, gitRef);
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
