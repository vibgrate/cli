/**
 * Local loopback server for `vg show arch`.
 *
 * Serves the map page plus JSON that matches `vg show --json` for a node.
 * The default paint payload is a workspace overview (packages), not every symbol.
 * Never binds a public interface unless the operator passes --host.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGraphPath } from '../artifacts.js';
import { loadGraph } from '../load.js';
import { readHaileSidecar } from '../haile/sidecar.js';
import type { HaileSidecar } from '../haile/types.js';
import { loadHaileProvider, type HaileProvider } from '../haile/haile-provider.js';
import type { VgGraph } from '../../schema.js';
import { originAllowed } from '../../util/origin.js';
import { CliError, ExitCode } from '../../util/exit.js';
import { indexFor } from '../relations.js';
import { chartPage } from './page.js';
import { pathJson, searchGraph, showJsonFor } from './model.js';
import { projectOverview } from './overview.js';
import { projectSlice } from './slice.js';
import { sanitizeOverview, sanitizeSlice } from './sanitize.js';
import type { ArchOverview, ArchSlice, ArchSliceView } from './arch-types.js';

export const DEFAULT_CHART_HOST = '127.0.0.1';
export const DEFAULT_CHART_PORT = 7420;

export interface ChartListenOptions {
  root: string;
  graph?: string;
  host?: string;
  port?: number;
}

export interface ChartServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function startChartServer(opts: ChartListenOptions): Promise<ChartServer> {
  const graphPath = resolveGraphPath(opts.root, opts.graph);
  const graph = loadGraph(opts.root, opts.graph);
  if (!graph) {
    throw new CliError('no map found — run `vg` to build one first', ExitCode.NOT_FOUND);
  }
  const sidecar = readHaileSidecar(graphPath, { corpusHash: graph.provenance?.corpusHash });
  const provider = await loadHaileProvider();
  const host = opts.host ?? DEFAULT_CHART_HOST;
  const requested = opts.port ?? DEFAULT_CHART_PORT;
  const server = http.createServer((req, res) => {
    try {
      handle(req, res, graph, sidecar, provider);
    } catch {
      send(res, 500, 'map failed', 'text/plain');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requested;
      resolve({
        url: `http://${host}:${port}`,
        host,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  graph: VgGraph,
  sidecar: HaileSidecar | null,
  provider: HaileProvider | null,
): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originAllowed(origin, process.env.VIBGRATE_ALLOWED_ORIGINS)) {
    send(res, 403, 'forbidden origin', 'text/plain');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathName = url.pathname;

  if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
    send(res, 200, pageHtml(provider), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathName.startsWith('/arch-ui/')) {
    serveArchUi(res, provider, pathName.slice('/arch-ui/'.length));
    return;
  }
  if (req.method === 'GET' && pathName === '/api/meta') {
    json(res, overviewOf(graph, sidecar, provider).meta);
    return;
  }
  if (req.method === 'GET' && pathName === '/api/overview') {
    json(res, overviewOf(graph, sidecar, provider));
    return;
  }
  if (req.method === 'GET' && pathName === '/api/slice') {
    const packageId = url.searchParams.get('package') ?? '';
    const view = parseView(url.searchParams.get('view'));
    const focus = url.searchParams.get('focus') ?? undefined;
    const architecture = url.searchParams.get('arch') !== '0';
    const tests = url.searchParams.get('tests') === '1';
    json(res, sliceOf(graph, sidecar, provider, { packageId, view, focus, architecture, tests }));
    return;
  }
  if (req.method === 'GET' && pathName === '/api/graph') {
    res.setHeader('Warning', '299 vg "/api/graph is deprecated; use /api/overview"');
    json(res, overviewOf(graph, sidecar, provider));
    return;
  }
  if (req.method === 'GET' && pathName === '/api/sidecar') {
    json(res, sidecar ?? { present: false });
    return;
  }
  if (req.method === 'GET' && pathName === '/api/search') {
    json(res, { results: searchGraph(graph, sidecar, url.searchParams.get('q') ?? '') });
    return;
  }
  if (req.method === 'GET' && pathName.startsWith('/api/node/')) {
    const key = decodeURIComponent(pathName.slice('/api/node/'.length));
    const node = lookup(graph, key);
    if (!node) {
      json(res, { error: 'not found', id: key }, 404);
      return;
    }
    json(res, showJsonFor(graph, node, sidecar));
    return;
  }
  if (req.method === 'GET' && pathName === '/api/path') {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const src = lookup(graph, from);
    const dst = lookup(graph, to);
    if (!src || !dst) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, pathJson(graph, src.id, dst.id));
    return;
  }
  if (req.method === 'GET' && pathName.startsWith('/api/reach/')) {
    const key = decodeURIComponent(pathName.slice('/api/reach/'.length));
    const node = lookup(graph, key);
    if (!node) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    const dir = url.searchParams.get('dir') === 'up' ? 'up' : 'down';
    json(res, reachJson(graph, node.id, dir));
    return;
  }
  json(res, { error: 'not found' }, 404);
}

export function overviewOf(
  graph: VgGraph,
  sidecar: HaileSidecar | null,
  provider: HaileProvider | null,
): ArchOverview {
  if (provider?.projectOverview) {
    try {
      const clean = sanitizeOverview(provider.projectOverview(graph, sidecar));
      if (clean) return clean;
    } catch {
      /* host fallback */
    }
  }
  return projectOverview(graph, sidecar);
}

export function sliceOf(
  graph: VgGraph,
  sidecar: HaileSidecar | null,
  provider: HaileProvider | null,
  spec: {
    packageId: string;
    view: ArchSliceView;
    focus?: string;
    architecture: boolean;
    tests: boolean;
  },
): ArchSlice {
  const resolved = spec.packageId || projectOverview(graph, sidecar).packages[0]?.id || 'root';
  const input = {
    packageId: resolved,
    view: spec.view,
    focus: spec.focus,
    architecture: spec.architecture,
    tests: spec.tests,
  };
  if (provider?.projectSlice) {
    try {
      const clean = sanitizeSlice(provider.projectSlice(graph, sidecar, input));
      if (clean) return clean;
    } catch {
      /* host fallback */
    }
  }
  return projectSlice(graph, sidecar, input);
}

function pageHtml(provider: HaileProvider | null): string {
  if (provider?.renderArchPage) {
    try {
      const html = provider.renderArchPage({ host: 'browser' });
      if (
        typeof html === 'string' &&
        html.includes('<html') &&
        html.length > 100 &&
        html.length < 2_000_000 &&
        !/HAILE/i.test(html)
      ) {
        return html;
      }
    } catch {
      /* host fallback */
    }
  }
  return chartPage();
}

function parseView(raw: string | null): ArchSliceView {
  if (raw === 'calls' || raw === 'missing' || raw === 'problems') return raw;
  return 'job';
}

function serveArchUi(res: ServerResponse, provider: HaileProvider | null, rel: string): void {
  const root = provider?.archUiAssets?.();
  if (!root || typeof root !== 'string') {
    json(res, { error: 'not found' }, 404);
    return;
  }
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.resolve(root, safe);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    json(res, { error: 'not found' }, 404);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
  };
  const type = types[ext];
  if (!type || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    json(res, { error: 'not found' }, 404);
    return;
  }
  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function lookup(graph: VgGraph, key: string) {
  return graph.nodes.find((n) => n.id === key || n.qualifiedName === key || n.name === key);
}

function reachJson(graph: VgGraph, id: string, dir: 'up' | 'down'): { id: string; dir: 'up' | 'down'; ids: string[] } {
  const index = indexFor(graph);
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const next = dir === 'down' ? index.callees(cur) : index.callers(cur);
    for (const n of next) stack.push(n.node.id);
  }
  seen.delete(id);
  return { id, dir, ids: [...seen] };
}

function json(res: ServerResponse, body: unknown, code = 200): void {
  send(res, code, JSON.stringify(body), 'application/json');
}

function send(res: ServerResponse, code: number, body: string, type: string): void {
  res.writeHead(code, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}
