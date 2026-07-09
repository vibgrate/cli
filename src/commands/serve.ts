import * as fs from 'node:fs';
import { Command } from 'commander';
import { defaultGraphPath } from '../engine/artifacts.js';
import { serveStdio, createServer, GraphSource, type ServeOptions } from '../mcp/server.js';
import { StatsSharer, statsEndpoint } from '../engine/stats-share.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info } from '../util/output.js';

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
      const shareStats = opts.shareStats === true && !local;
      const serveOpts: ServeOptions = {
        savings: opts.savings === true || shareStats,
        shareStats,
        local,
        dedup: opts.dedup === true,
        refresh,
      };

      if (!fs.existsSync(graphPath)) {
        throw new CliError(
          `no map found at ${graphPath} — run \`vg\` to build one first`,
          ExitCode.NOT_FOUND,
        );
      }

      if (opts.shareStats === true && local) {
        info(c.dim('vg · --share-stats ignored under --local (air-gapped): recording locally, not uploading.'));
      }
      if (shareStats) startSharing(root);

      const freshness = refresh ? 'auto-refresh' : 'as built';
      if (opts.http) {
        await serveHttp(graphPath, opts.host ?? '127.0.0.1', Number(opts.port) || 7437, serveOpts, freshness);
      } else {
        // stdio: NOTHING may go to stdout except the protocol stream.
        info(c.dim(`vg · MCP server on stdio (read-only, ${freshness}). Connect your assistant to this process.`));
        await serveStdio(graphPath, serveOpts);
      }
    });
  applyGlobalOptions(cmd);
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

async function serveHttp(graphPath: string, host: string, port: number, opts: ServeOptions, freshness: string): Promise<void> {
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
  // Keep the process alive until killed.
  await new Promise<never>(() => {});
}
