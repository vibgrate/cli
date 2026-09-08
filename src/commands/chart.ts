/**
 * `vg show chart` — local interactive code map.
 *
 * Not a new top-level verb (FEATURE-DESIGN-PRINCIPLES P1). Nested under
 * `vg show` so the terminal, the map, and `vg show --json` stay one surface.
 */
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { startChartServer, DEFAULT_CHART_HOST, DEFAULT_CHART_PORT } from '../engine/chart/server.js';
import { projectChart } from '../engine/chart/model.js';
import { loadGraph } from '../engine/load.js';
import { readHaileSidecar } from '../engine/haile/sidecar.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

export function registerShowChart(show: Command): void {
  const chart = show
    .command('chart')
    .description('open a local interactive map of the code graph')
    .option('--port <n>', 'port', String(DEFAULT_CHART_PORT))
    .option('--host <h>', 'bind address (loopback by default)', DEFAULT_CHART_HOST)
    .option('--focus <name>', 'open the map on this symbol')
    .option('--no-open', 'print the URL without opening a browser')
    .action(async function (
      this: Command,
      opts: { port?: string; host?: string; open?: boolean; focus?: string },
    ) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const host = opts.host ?? DEFAULT_CHART_HOST;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !global.json) {
        info(c.dim('vg · binding off loopback — only do this on a trusted network'));
      }
      const server = await startChartServer({
        root,
        graph: global.graph,
        host,
        port: Number(opts.port) || DEFAULT_CHART_PORT,
      });

      const graphPath = resolveGraphPath(root, global.graph);
      const graph = loadGraph(root, global.graph);
      if (!graph) {
        await server.close();
        throw new CliError('no map found — run `vg` to build one first', ExitCode.NOT_FOUND);
      }
      const sidecar = readHaileSidecar(graphPath, { corpusHash: graph.provenance?.corpusHash });
      const payload = projectChart(graph, sidecar);
      const url = opts.focus
        ? `${server.url}/#n=${encodeURIComponent(opts.focus)}`
        : server.url;

      if (global.json) {
        json({
          url,
          host: server.host,
          port: server.port,
          architectureLoaded: payload.meta.architectureLoaded,
          nodes: payload.meta.nodes,
          pulses: payload.meta.pulses,
          missingSteps: payload.meta.missingSteps,
        });
      } else {
        info(`${c.cyan('vg · chart')}  ${url}`);
        info(
          c.dim(
            payload.meta.architectureLoaded
              ? `  architecture loaded · ${payload.meta.nodes} symbols · ${payload.meta.pulses} rule break(s)`
              : `  architecture module not loaded · ${payload.meta.nodes} symbols · raw map`,
          ),
        );
        info(c.dim('  q / Ctrl-C to stop'));
      }

      if (opts.open !== false && !global.json) openBrowser(url);

      await new Promise<void>((resolve) => {
        const stop = () => {
          void server.close().finally(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
  applyGlobalOptions(chart);
}

function openBrowser(url: string): void {
  const plat = process.platform;
  const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'cmd' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* printed URL is enough */
  }
}
