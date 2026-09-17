/**
 * `vg show arch` — local interactive map of the code graph, painted by
 * architecture (roles, purposes, rule breaks) when the Architecture module
 * has written its sidecar, and the raw graph when it has not.
 *
 * Not a new top-level verb (FEATURE-DESIGN-PRINCIPLES P1). Nested under
 * `vg show` so the terminal, the map, and `vg show --json` stay one surface.
 * `vg show chart` is the pre-rename spelling, kept as a silent alias for one
 * release (never listed in help).
 */
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { resolveGraphPath } from '../engine/artifacts.js';
import { startChartServer, DEFAULT_CHART_HOST, DEFAULT_CHART_PORT, overviewOf } from '../engine/chart/server.js';
import { locateInOverview } from '../engine/chart/overview.js';
import { loadGraph } from '../engine/load.js';
import { readHaileSidecar } from '../engine/haile/sidecar.js';
import { loadHaileProvider } from '../engine/haile/haile-provider.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

export function registerShowArch(show: Command): void {
  configure(show.command('arch').description('open a local interactive architecture map of the code graph'));
  // Pre-rename alias: same options, same action, hidden from `vg show --help`.
  configure(show.command('chart', { hidden: true }).description('alias of `vg show arch`'));
}

function configure(chart: Command): void {
  chart
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
      const sidecar = readHaileSidecar(graphPath);
      const provider = await loadHaileProvider();
      const overview = overviewOf(graph, sidecar, provider, root);
      const located = opts.focus ? locateInOverview(graph, opts.focus) : null;
      const url = located
        ? `${server.url}/#zoom=slice&package=${encodeURIComponent(located.packageId)}&n=${encodeURIComponent(located.nodeId)}`
        : `${server.url}/#zoom=workspace`;

      if (global.json) {
        json({
          url,
          host: server.host,
          port: server.port,
          architectureLoaded: overview.meta.architectureLoaded,
          packages: overview.meta.packages,
          symbols: overview.meta.symbols,
          nodes: overview.meta.packages,
          pulses: overview.meta.findings,
          missingSteps: overview.meta.missingSteps,
        });
      } else {
        info(`${c.cyan('vg · arch')}  ${url}`);
        info(
          c.dim(
            overview.meta.architectureLoaded
              ? `  architecture loaded · ${overview.meta.packages} packages · ${overview.meta.symbols} symbols · ${overview.meta.findings} rule break(s)`
              : `  architecture module not loaded · ${overview.meta.packages} packages · ${overview.meta.symbols} symbols · raw map`,
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
