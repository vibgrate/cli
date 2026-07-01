import * as fs from 'node:fs';
import { Command } from 'commander';
import { defaultGraphPath } from '../engine/artifacts.js';
import { serveStdio, createServer } from '../mcp/server.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info } from '../util/output.js';

/**
 * `vg serve` (VG-CLI-SPEC §3.6) — a LOCAL MCP server over the map. Default
 * transport is stdio (what assistants spawn); `--http` exposes a stateless
 * streamable-HTTP endpoint for local browser/shared hosts. Fully offline,
 * read-only tools only. Independent of Vibgrate's hosted cloud MCP.
 */
export function registerServe(program: Command): void {
  const cmd = program
    .command('serve')
    .description('start Vibgrate AI Context — local, offline MCP serving your code map, drift & version-correct docs to your AI')
    .option('--http', 'serve over streamable HTTP instead of stdio')
    .option('--port <n>', 'port for --http', '7437')
    .option('--host <h>', 'host for --http', '127.0.0.1')
    .option('--savings', 'record local, counts-only usage savings (opt-in; off by default)')
    .option('--dedup', "collapse a node's heavy relation lists on repeat reads within a session (opt-in; saves tokens)")
    .action(async function (this: Command, opts: { http?: boolean; port?: string; host?: string; savings?: boolean; dedup?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const graphPath = global.graph ?? defaultGraphPath(root);
      const savings = opts.savings === true;
      const dedup = opts.dedup === true;
      const local = global.local === true;

      if (!fs.existsSync(graphPath)) {
        throw new CliError(
          `no map found at ${graphPath} — run \`vg\` to build one first`,
          ExitCode.NOT_FOUND,
        );
      }

      if (opts.http) {
        await serveHttp(graphPath, opts.host ?? '127.0.0.1', Number(opts.port) || 7437, savings, local, dedup);
      } else {
        // stdio: NOTHING may go to stdout except the protocol stream.
        info(c.dim('vg · MCP server on stdio (read-only). Connect your assistant to this process.'));
        await serveStdio(graphPath, savings, local, dedup);
      }
    });
  applyGlobalOptions(cmd);
}

async function serveHttp(graphPath: string, host: string, port: number, savings: boolean, local: boolean, dedup: boolean): Promise<void> {
  const { createServer: createHttp } = await import('node:http');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

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
      const server = createServer(graphPath, savings, local, dedup);
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
  info(c.dim(`vg · MCP server on http://${host}:${port}/mcp (read-only, local)`));
  // Keep the process alive until killed.
  await new Promise<never>(() => {});
}
