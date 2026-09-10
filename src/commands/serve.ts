import { Command } from 'commander';
import { resolveGraphPath } from '../engine/artifacts.js';
import { mapFileExists } from '../engine/snapshot.js';
import { serveStdio, createServer, GraphSource, attachGraphSource, type ServeOptions } from '../mcp/server.js';
import { StatsSharer, statsEndpoint, telemetryOptOut } from '../engine/stats-share.js';
import { refreshIfStale } from '../engine/refresh.js';
import { driftCount } from '../engine/freshness.js';
import { runBuild } from './build.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';
import { originAllowed } from '../util/origin.js';
import { printLogo } from '../util/logo.js';
import { SessionStats, ServeStatusDisplay } from '../mcp/serve-stats.js';
import { LedgerTail } from '../mcp/ledger-tail.js';
import { LiveStatsBus, liveStatsDir } from '../mcp/live-stats.js';
import { savingsLedgerPath } from '../engine/savings.js';
import { compressionOverrides, registerServeCompression, startCompression } from './serve-compress.js';
import { registerServeCompressCommand } from './compress.js';
import { registerServeRetrieve } from './retrieve.js';
import { registerServeMemory } from './memory.js';
import { resolveProxyConfig } from '../proxy/config.js';
import { isWrapAgent, WRAP_AGENTS, wrap } from '../wrap/index.js';

/** How often the opt-in `--share-stats` flusher uploads new ledger entries. */
const SHARE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `vg serve` (VG-CLI-SPEC §3.6) — a LOCAL MCP server over the map. Default
 * transport is stdio (what assistants spawn); `--http` exposes a stateless
 * streamable-HTTP endpoint for local browser/shared hosts. Fully offline,
 * read-only tools only. Independent of Vibgrate's hosted cloud MCP.
 *
 * The map auto-refreshes: tool calls run a cheap freshness probe and trigger
 * an incremental in-process rebuild when the working tree drifted, so the AI
 * always queries an up-to-date graph (see mcp/server.ts). `--no-refresh`
 * pins serving to the map as built; a custom `--graph` implies it.
 *
 * Startup only **blocks** to build a missing map. A present-but-stale map is
 * left for the in-process probe (and a background kick from
 * `ensureServableGraph`) so the MCP `initialize` handshake is never delayed by
 * a multi-second rebuild — hosts time out the handshake when serve blocks too
 * long before connecting the transport.
 *
 * `--compress` adds context compression to the same process: an Anthropic- and
 * OpenAI-compatible listener that shrinks bulky tool output before it reaches
 * the model, plus the compression tools on the MCP side. One local runtime,
 * two listeners — not a second server (FEATURE-DESIGN-PRINCIPLES P1).
 */
export function registerServe(program: Command): void {
  const cmd = program
    .command('serve')
    .description('start Vibgrate AI Context — local-first MCP serving your code map, drift & version-correct docs to your AI')
    .argument('[agent...]', 'with --compress: run this agent through the compression listener for one session, then restore (put its own flags after `--`)')
    .option('--http', 'serve over streamable HTTP instead of stdio')
    .option('--port <n>', 'port for --http', '7437')
    .option('--host <h>', 'host for --http', '127.0.0.1')
    .option('--savings', 'record local, counts-only usage savings (opt-in; off by default)')
    .option('--share-stats', 'ALSO upload the counts-only usage ledger to Vibgrate to improve the local MCP (opt-in; off by default; implies --savings; disabled under --local)')
    .option('--dedup', "collapse a node's heavy relation lists on repeat reads within a session (opt-in; saves tokens)")
    .option('--no-refresh', 'serve the map as built — skip the auto-rebuild when files change')
    .option('--no-watch', 'disable the event-driven file watcher — freshness falls back to the periodic poll')
    .option('--surface <mode>', 'tool listing surface: "hot" lists only the navigation core (orient/search_symbols/query_graph/get_node); "full" lists all tools. Every tool stays callable either way. Env: VG_MCP_SURFACE')
    .option('--tools <names>', 'comma-separated tool names to list (listing only — all tools remain callable). Env: VG_MCP_TOOLS')
    .option('--compress', 'also compress context: an Anthropic/OpenAI-compatible listener for any agent, plus the compression MCP tools. Point an agent at it with `vg install <agent> --compress`')
    // Not `--no-graph`: the global `--graph <file>` already owns that name, and
    // commander would read the negation as "unset the map path".
    .option('--compress-only', 'compression without the code map — do not build or serve one (implies --compress)')
    .option('--compress-port <n>', 'port for the compression listener (default: VG_PROXY_PORT or 8787)')
    .option('--compress-mode <mode>', 'cache (prefix-cache safe, default) | token (maximum removal)')
    .option('--profile <name>', 'compression profile: coding | balanced | aggressive | general')
    .option('--memory', 'expose cross-agent memory tools (memory_search / memory_save) scoped to this project. Env: VG_MEMORY=1')
    .action(async function (this: Command, agentArgv: string[], opts: { http?: boolean; port?: string; host?: string; savings?: boolean; shareStats?: boolean; dedup?: boolean; refresh?: boolean; watch?: boolean; surface?: string; tools?: string; compress?: boolean; compressOnly?: boolean; compressPort?: string; compressMode?: string; profile?: string; memory?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      // `--compress-only` is the "I just want compression" path: no map is
      // built, none is required, and the graph tools are not listed. It is the
      // honest answer for a repo with no map yet, or an agent that only needs
      // its context shrunk.
      const compressOnly = opts.compressOnly === true;
      const compress = opts.compress === true || compressOnly;
      if (agentArgv.length && !compress) {
        throw new CliError(
          `\`vg serve ${agentArgv[0]}\` needs --compress — it runs an agent through the compression listener. Try \`vg serve --compress -- ${agentArgv.join(' ')}\``,
          ExitCode.USAGE_ERROR,
        );
      }
      // One-shot: `vg serve --compress -- claude …` runs a single agent session
      // through the compression listener using its own environment, restores
      // everything when the child exits, and never touches durable config.
      // (`vg install <agent> --compress` is the durable form.)
      if (agentArgv.length) {
        await runAgentOnce(agentArgv, opts, global);
        return;
      }

      const graphPath = resolveGraphPath(root, global.graph);
      // A custom --graph is an explicit artifact — never rebuild over it.
      const refresh = opts.refresh !== false && !global.graph;
      // Sharing needs the network, so `--local` (air-gapped) hard-disables the
      // upload — but still lets `--savings` record locally. Sharing implies
      // recording so there's something to send.
      const local = global.offline === true;
      // The universal DO_NOT_TRACK opt-out (and VIBGRATE_TELEMETRY=0) wins even
      // over an explicit --share-stats: the env is how operators of shared or
      // managed machines say "never upload", and CI passes flags mechanically.
      const optOut = telemetryOptOut();
      const shareStats = opts.shareStats === true && !local && optOut === null;
      // Live session stats (in-memory only — nothing persisted or uploaded, so
      // no opt-in needed): uptime, which AI is calling, per-tool calls/timing,
      // and the context-vs-grep-baseline estimate, rendered to stderr while the
      // server runs. `--quiet` turns the whole display off.
      const quiet = global.quiet === true;
      const stats = quiet ? undefined : new SessionStats();
      if (!quiet) {
        // Brand banner for a human at a TTY, same as the scanner (printLogo
        // no-ops under a pipe, so assistant-spawned stdio stays clean).
        printLogo(root, { product: 'AI Context', tagline: 'Local-first MCP for your AI' });
      }
      const serveOpts: ServeOptions = {
        // A *requested* --share-stats always implies local recording, even when
        // the upload itself is suppressed (--local / env opt-out) — the local
        // ledger never leaves the machine, and the disclosure messages below
        // promise "recording locally".
        savings: opts.savings === true || opts.shareStats === true,
        shareStats,
        local,
        dedup: opts.dedup === true,
        refresh,
        watch: opts.watch !== false,
        daemon: global.daemon,
        root,
        stats,
        // Listing surface: flags win over env; unknown values fall back to the
        // full surface inside listedToolNames (fail-open).
        toolSurface: {
          surface: (opts.surface ?? process.env.VG_MCP_SURFACE) === 'hot' ? 'hot' : 'full',
          tools: (opts.tools ?? process.env.VG_MCP_TOOLS)?.split(',').map((s) => s.trim()).filter(Boolean),
        },
        // P2: the compression tools are flag-gated at registration, so a
        // default `vg serve` never pays their schema tokens. They stay
        // callable either way — only the listing is gated.
        compressTools: compress,
        memory: opts.memory === true || /^(1|true|yes|on)$/i.test(process.env.VG_MEMORY ?? ''),
        graphless: compressOnly,
      };
      // No map means nothing to refresh or watch.
      if (compressOnly) {
        serveOpts.refresh = false;
        serveOpts.watch = false;
      }

      // Check the map is up to date and, when it isn't, run the build before we
      // start serving — build a missing map from scratch, rebuild a stale one
      // incrementally. Skipped under `--no-refresh`/`--graph`, which serve the
      // map exactly as built, and under `--compress-only`, which has no map.
      if (!compressOnly) await ensureServableGraph(root, graphPath, global, refresh);

      if (opts.shareStats === true && local) {
        info(c.dim('vg · --share-stats ignored under --local (air-gapped): recording locally, not uploading.'));
      } else if (opts.shareStats === true && optOut !== null) {
        info(c.dim(`vg · --share-stats disabled by ${optOut}: recording locally, not uploading.`));
      }
      if (shareStats) startSharing(root);

      // Cross-process live stats, split by role so nothing double-counts:
      // an assistant-spawned (non-interactive) serve PUBLISHES its counts to
      // the ephemeral bus; the operator's terminal (interactive) serve
      // AGGREGATES — it folds sibling snapshots and the CLI `--client` ledger
      // into its display. See mcp/live-stats.ts and mcp/ledger-tail.ts.
      const interactive = process.stderr.isTTY === true;
      const bus = stats ? new LiveStatsBus(liveStatsDir(root), stats) : undefined;
      if (bus && !interactive) bus.start();
      // The display starts only after the startup lines are printed, so they
      // stay in scroll history above the repainted status block.
      const display = stats
        ? new ServeStatusDisplay(stats, process.stderr, bus && interactive ? () => bus.siblings() : undefined)
        : undefined;
      // Fold in CLI navigation calls (`vg <cmd> --client=<ai>`) made while
      // serving: they land in the local ledger from a separate process, so the
      // watching display tails it — otherwise an agent that shells out to the
      // CLI would leave this dashboard frozen at zero. Interactive-only: if a
      // publisher folded them too, the aggregate would count each call twice.
      if (stats && interactive) new LedgerTail(savingsLedgerPath(root), stats).start();

      // The compression listener lives in this same process. It binds its own
      // port so the URL an agent is configured with never depends on whether
      // MCP happens to be on stdio or HTTP today.
      if (compress) {
        const overrides = compressionOverrides(opts);
        if (global.offline) overrides.offline = true;
        const cfg = resolveProxyConfig(overrides);
        const listener = await startCompression(cfg, { stderr: !quiet && !global.json, pinned: Object.keys(overrides) });
        if (!quiet) {
          info(
            listener.attached
              ? c.dim(`vg · compressing via the listener already running at ${listener.url}`)
              : `vg · compressing at ${c.bold(listener.url)} ${c.dim(`(${cfg.mode} mode, ${cfg.profile} profile)`)}`,
          );
          info(c.dim(`  Anthropic ${listener.url}/v1/messages · OpenAI ${listener.url}/v1/chat/completions · savings ${listener.url}/`));
          info(c.dim('  point an agent at it with `vg install <agent> --compress`, or run one session with `vg serve --compress -- <agent>`'));
        }
        const closeListener = (): void => {
          void listener.close().then(() => process.exit(0));
        };
        process.once('SIGINT', closeListener);
        process.once('SIGTERM', closeListener);
      }

      const freshness = compressOnly ? 'no code map' : refresh ? 'auto-refresh' : 'as built';
      if (opts.http) {
        await serveHttp(graphPath, opts.host ?? '127.0.0.1', Number(opts.port) || 7437, serveOpts, freshness, () => display?.start());
      } else {
        // stdio: NOTHING may go to stdout except the protocol stream.
        // Start the status display before connect so operators see activity
        // while the transport waits for initialize (serveStdio blocks forever).
        info(c.dim(`vg · MCP server on stdio (read-only, ${freshness}). Connect your assistant to this process.`));
        display?.start();
        await serveStdio(graphPath, serveOpts);
      }
    });
  applyGlobalOptions(cmd);

  // Everything that manages the compression half of the runtime nests here
  // rather than becoming its own verb (FEATURE-DESIGN-PRINCIPLES P1).
  registerServeCompression(cmd);
  registerServeCompressCommand(cmd);
  registerServeRetrieve(cmd);
  registerServeMemory(cmd);
}

/**
 * `vg serve --compress -- <agent> [args…]` — one session, environment only.
 *
 * The durable form is `vg install <agent> --compress`, which writes the
 * agent's own config; this is the "just this run" path, so nothing survives
 * the child exiting.
 */
async function runAgentOnce(
  argv: string[],
  opts: { compressPort?: string; profile?: string },
  global: GlobalOpts,
): Promise<void> {
  const [agent, ...args] = argv;
  if (!isWrapAgent(agent)) {
    throw new CliError(
      `cannot run "${agent}" through the compression listener — supported agents: ${WRAP_AGENTS.join(', ')}`,
      ExitCode.USAGE_ERROR,
    );
  }
  const port = opts.compressPort !== undefined ? Number.parseInt(opts.compressPort, 10) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new CliError(`--compress-port must be 1..65535, got ${opts.compressPort}`, ExitCode.USAGE_ERROR);
  }
  const result = await wrap(agent, {
    args,
    port,
    cwd: global.cwd,
    profile: opts.profile,
    quiet: global.quiet || global.json ? true : undefined,
  });
  if (global.json) json({ agent, exitCode: result.exitCode, url: result.proxyUrl, applied: result.applied, plan: result.plan });
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

/**
 * Ensure there is a map to serve before the MCP server starts.
 *
 * When auto-refresh is on (the default; disabled by `--no-refresh` or a pinned
 * `--graph`):
 * - **No map yet** → run the ordinary `vg build` so a fresh checkout can `vg
 *   serve` without a separate build step first. Forced out of `--json` so the
 *   build summary never lands on stdout — under stdio that channel is the MCP
 *   protocol stream and carries nothing else. This is the only blocking work
 *   at startup.
 * - **Map present but stale** → **do not block**. Kick a background
 *   `refreshIfStale` and let the transport connect immediately. Blocking here
 *   on multi-second rebuilds causes host-side MCP handshake timeouts (Grok /
 *   Cursor / etc. abort before `initialize` returns). Tool calls still run the
 *   in-process micro-budget probe (`GraphSource`) and pick up the rebuild via
 *   hot-reload.
 *
 * With auto-refresh off we serve the map exactly as built and only verify one
 * exists. Either way, if there is still no map afterwards we stop with an
 * actionable error instead of starting a server with nothing to answer from.
 *
 * `opts.inline` forces single-threaded build/refresh (tests only).
 * `opts.awaitStaleRefresh` (tests only) waits for the background stale refresh
 * so unit tests can assert the rebuild without racing.
 */
export async function ensureServableGraph(
  root: string,
  graphPath: string,
  global: GlobalOpts,
  refresh: boolean,
  opts: { inline?: boolean; awaitStaleRefresh?: boolean } = {},
): Promise<void> {
  if (refresh) {
    if (!mapFileExists(graphPath)) {
      info(c.dim('vg · no map found — building it before serving…'));
      await runBuild(
        [],
        { html: false, report: false, jobs: opts.inline ? '1' : undefined },
        { ...global, json: false },
      );
    } else {
      // Non-blocking: handshake must not wait on a large-repo rebuild.
      const kick = refreshIfStale(root, { inline: opts.inline, graphPath })
        .then((refreshed) => {
          if (refreshed.status === 'refreshed') {
            const n = driftCount(refreshed.drift);
            info(
              c.dim(
                `vg · map refreshed in background — ${n} file(s) drifted (${(refreshed.ms / 1000).toFixed(2)}s)`,
              ),
            );
          } else if (refreshed.status === 'error') {
            info(c.yellow(`vg · map refresh failed (${refreshed.message}) — serving the last built map`));
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          info(c.yellow(`vg · map refresh failed (${msg}) — serving the last built map`));
        });
      if (opts.awaitStaleRefresh) await kick;
      else void kick;
    }
  }

  if (!mapFileExists(graphPath)) {
    throw new CliError(
      `no map found at ${graphPath} — run \`vg\` to build one first`,
      ExitCode.NOT_FOUND,
    );
  }
}

/**
 * Start the opt-in usage-stats upload for this serve session: a clear one-time
 * disclosure, a periodic flush of the counts-only ledger, and a final flush when
 * the process is asked to stop. Everything is best-effort — a network problem
 * never affects serving. Nothing here is reached unless the operator passed
 * `--share-stats` (and is not `--local`).
 */
function startSharing(root: string): void {
  const sharer = new StatsSharer(root);
  // Transparency (GUARDRAILS §3.4): say exactly what is shared, where, and how to
  // stop. To stderr, so it never pollutes the stdio protocol stream.
  info(
    c.dim(
      `vg · sharing counts-only usage stats with Vibgrate (${statsEndpoint()}) to improve the local MCP. ` +
        'No code, paths, or questions are sent. Stop by omitting --share-stats.',
    ),
  );
  const timer = setInterval(() => void sharer.flush(), SHARE_FLUSH_INTERVAL_MS);
  timer.unref?.(); // the server, not this timer, keeps the process alive

  let flushed = false;
  const finalFlush = (): void => {
    if (flushed) return;
    flushed = true;
    void sharer.flush();
  };
  process.once('SIGINT', () => {
    finalFlush();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    finalFlush();
    process.exit(0);
  });
  process.once('beforeExit', finalFlush);
}

async function serveHttp(
  graphPath: string,
  host: string,
  port: number,
  opts: ServeOptions,
  freshness: string,
  onReady?: () => void,
): Promise<void> {
  const { createServer: createHttp } = await import('node:http');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  // One graph source for the whole process: the parsed graph, hot-reload state,
  // and refresh debounce live across requests (re-parsing per request would be
  // wasteful and would probe freshness on every call).
  const source = new GraphSource(graphPath, opts.refresh !== false, { root: opts.root });
  await attachGraphSource(source, opts);

  const httpServer = createHttp(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }
    // DNS-rebinding protection (MCP 2025-11-25): a browser-set Origin must be
    // loopback or explicitly allowlisted; absent Origin (CLI clients) passes.
    // See util/origin.ts.
    const origin = req.headers.origin;
    if (!originAllowed(origin, process.env.VIBGRATE_ALLOWED_ORIGINS)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end(
        'forbidden origin — vg serve only accepts browser requests from loopback origins. ' +
          'Set VIBGRATE_ALLOWED_ORIGINS to allow others.',
      );
      return;
    }
    try {
      // Stateless: a fresh server+transport per request (no session state) —
      // simple and robust for a local single-user endpoint. (Per-request, so
      // `--dedup` only accumulates within stdio sessions, not across HTTP calls.)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createServer(source, opts);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end('internal error');
      info(c.red(`vg serve: request error: ${(err as Error).message}`));
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  info(c.dim(`vg · MCP server on http://${host}:${port}/mcp (read-only, local, ${freshness})`));
  // Live status display, once the listen line is safely in scroll history.
  onReady?.();
  // Keep the process alive until killed.
  await new Promise<never>(() => {});
}
