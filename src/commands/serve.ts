import * as fs from 'node:fs';
import { Command } from 'commander';
import { defaultGraphPath } from '../engine/artifacts.js';
import { serveStdio, createServer, GraphSource, type ServeOptions } from '../mcp/server.js';
import { StatsSharer, statsEndpoint, telemetryOptOut } from '../engine/stats-share.js';
import { refreshIfStale } from '../engine/refresh.js';
import { driftCount } from '../engine/freshness.js';
import { runBuild } from './build.js';
import { applyGlobalOptions, readGlobal, type GlobalOpts } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info } from '../util/output.js';
import { originAllowed } from '../util/origin.js';
import { printLogo } from '../util/logo.js';
import { SessionStats, ServeStatusDisplay } from '../mcp/serve-stats.js';
import { LedgerTail } from '../mcp/ledger-tail.js';
import { savingsLedgerPath } from '../engine/savings.js';

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
 * Before the server accepts its first request it also brings the map in sync
 * once, up front: a missing map is built from scratch and a stale map is
 * rebuilt incrementally (see `ensureServableGraph`). That way the first tool
 * call already sees an up-to-date graph instead of waiting for the in-process
 * probe — which only fires once tool calls start arriving — to notice drift.
 */
export function registerServe(program: Command): void {
  const cmd = program
    .command('serve')
    .description('start Vibgrate AI Context — local-first MCP serving your code map, drift & version-correct docs to your AI')
    .option('--http', 'serve over streamable HTTP instead of stdio')
    .option('--port <n>', 'port for --http', '7437')
    .option('--host <h>', 'host for --http', '127.0.0.1')
    .option('--savings', 'record local, counts-only usage savings (opt-in; off by default)')
    .option('--share-stats', 'ALSO upload the counts-only usage ledger to Vibgrate to improve the local MCP (opt-in; off by default; implies --savings; disabled under --local)')
    .option('--dedup', "collapse a node's heavy relation lists on repeat reads within a session (opt-in; saves tokens)")
    .option('--no-refresh', 'serve the map as built — skip the auto-rebuild when files change')
    .action(async function (this: Command, opts: { http?: boolean; port?: string; host?: string; savings?: boolean; shareStats?: boolean; dedup?: boolean; refresh?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const graphPath = global.graph ?? defaultGraphPath(root);
      // A custom --graph is an explicit artifact — never rebuild over it.
      const refresh = opts.refresh !== false && !global.graph;
      // Sharing needs the network, so `--local` (air-gapped) hard-disables the
      // upload — but still lets `--savings` record locally. Sharing implies
      // recording so there's something to send.
      const local = global.local === true;
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
        stats,
      };

      // Check the map is up to date and, when it isn't, run the build before we
      // start serving — build a missing map from scratch, rebuild a stale one
      // incrementally. Skipped under `--no-refresh`/`--graph`, which serve the
      // map exactly as built.
      await ensureServableGraph(root, graphPath, global, refresh);

      if (opts.shareStats === true && local) {
        info(c.dim('vg · --share-stats ignored under --local (air-gapped): recording locally, not uploading.'));
      } else if (opts.shareStats === true && optOut !== null) {
        info(c.dim(`vg · --share-stats disabled by ${optOut}: recording locally, not uploading.`));
      }
      if (shareStats) startSharing(root);

      // The display starts only after the startup lines are printed, so they
      // stay in scroll history above the repainted status block.
      const display = stats ? new ServeStatusDisplay(stats) : undefined;
      // Fold in CLI navigation calls (`vg <cmd> --client=<ai>`) made while
      // serving: they land in the local ledger from a separate process, so the
      // display tails it — otherwise an agent that shells out to the CLI would
      // leave this dashboard frozen at zero (see mcp/ledger-tail.ts).
      if (stats) new LedgerTail(savingsLedgerPath(root), stats).start();
      const freshness = refresh ? 'auto-refresh' : 'as built';
      if (opts.http) {
        await serveHttp(graphPath, opts.host ?? '127.0.0.1', Number(opts.port) || 7437, serveOpts, freshness, () => display?.start());
      } else {
        // stdio: NOTHING may go to stdout except the protocol stream.
        info(c.dim(`vg · MCP server on stdio (read-only, ${freshness}). Connect your assistant to this process.`));
        await serveStdio(graphPath, serveOpts);
        display?.start();
      }
    });
  applyGlobalOptions(cmd);
}

/**
 * Ensure there is an up-to-date map to serve before the MCP server starts.
 *
 * When auto-refresh is on (the default; disabled by `--no-refresh` or a pinned
 * `--graph`):
 * - **No map yet** → run the ordinary `vg build` so a fresh checkout can `vg
 *   serve` without a separate build step first. Forced out of `--json` so the
 *   build summary never lands on stdout — under stdio that channel is the MCP
 *   protocol stream and carries nothing else.
 * - **Map present but stale** → the incremental refresh (`refreshIfStale`),
 *   replaying the last build's scope. Fail-soft: a refresh error degrades to
 *   serving the last built map rather than refusing to start.
 *
 * With auto-refresh off we serve the map exactly as built and only verify one
 * exists. Either way, if there is still no map afterwards we stop with an
 * actionable error instead of starting a server with nothing to answer from.
 *
 * `opts.inline` forces single-threaded build/refresh (tests only).
 */
export async function ensureServableGraph(
  root: string,
  graphPath: string,
  global: GlobalOpts,
  refresh: boolean,
  opts: { inline?: boolean } = {},
): Promise<void> {
  if (refresh) {
    if (!fs.existsSync(graphPath)) {
      info(c.dim('vg · no map found — building it before serving…'));
      await runBuild(
        [],
        { html: false, report: false, jobs: opts.inline ? '1' : undefined },
        { ...global, json: false },
      );
    } else {
      const refreshed = await refreshIfStale(root, { inline: opts.inline });
      if (refreshed.status === 'refreshed') {
        const n = driftCount(refreshed.drift);
        info(c.dim(`vg · map refreshed before serving — ${n} file(s) drifted (${(refreshed.ms / 1000).toFixed(2)}s)`));
      } else if (refreshed.status === 'error') {
        info(c.yellow(`vg · map refresh failed (${refreshed.message}) — serving the last built map`));
      }
    }
  }

  if (!fs.existsSync(graphPath)) {
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
  const source = new GraphSource(graphPath, opts.refresh !== false);

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
