import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { c, info, json } from '../util/output.js';
import { ExitCode, usageError } from '../util/exit.js';
import { resolveProxyConfig } from '../proxy/config.js';
import { pidAlive, probeProxy, readProxyState } from '../proxy/lifecycle.js';

/**
 * `vg show savings` — print (and with `--open`, open) the URL of the local
 * savings page served by `vg serve --compress`: live requests, tokens and
 * dollars saved, and the effective settings.
 *
 * Not a new top-level verb (FEATURE-DESIGN-PRINCIPLES P1), and not a second
 * "dashboard": `vg show chart` is the browser view of the code graph, this is
 * the browser view of what `vg savings` reports in the terminal. Opening uses
 * the platform opener only when asked; nothing is launched implicitly.
 */
export function registerShowSavings(show: Command): void {
  const cmd = show
    .command('savings')
    .description('open the local savings page (live requests, tokens and dollars saved)')
    .option('--port <n>', 'compression port (default: VG_PROXY_PORT or 8787)')
    .option('--open', 'open the page in the default browser')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const o = this.opts() as { port?: string; open?: boolean };
      let port = resolveProxyConfig().port;
      if (o.port !== undefined) {
        const n = Number(o.port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw usageError(`invalid port: ${o.port}`);
        port = n;
      }
      const state = readProxyState(port);
      const url = `${state?.url ?? `http://127.0.0.1:${port}`}/`;
      const running = state ? pidAlive(state.pid) && (await probeProxy(state.url, { token: state.token })).ok : false;
      if (global.json) {
        json({ url, port, running, opened: false });
        if (!running) process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      info(`${c.cyan('vg show savings')} · ${c.bold(url)} ${running ? c.green('(compressing)') : c.yellow('(nothing listening — start it with `vg serve --compress`)')}`);
      if (!running) process.exitCode = ExitCode.NOT_FOUND;
      if (o.open) {
        const opened = await openUrl(url);
        if (!opened) info(c.dim('  could not launch a browser; open the URL manually'));
      }
    });
  applyGlobalOptions(cmd);
}

/** `xdg-open` / `open` / `start` — only ever called with `--open`. */
export async function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const [bin, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
