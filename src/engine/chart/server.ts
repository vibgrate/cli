/**
 * Local loopback server for `vg show chart`.
 *
 * Serves the map page plus JSON that matches `vg show --json` for a node.
 * Never binds a public interface unless the operator passes --host.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveGraphPath } from '../artifacts.js';
import { loadGraph } from '../load.js';
import { readHaileSidecar } from '../haile/sidecar.js';
import type { HaileSidecar } from '../haile/types.js';
import type { VgGraph } from '../../schema.js';
import { originAllowed } from '../../util/origin.js';
import { CliError, ExitCode } from '../../util/exit.js';
import { indexFor } from '../relations.js';
import { chartPage } from './page.js';
import { pathJson, projectChart, searchNodes, showJsonFor } from './model.js';

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

export function startChartServer(opts: ChartListenOptions): Promise<ChartServer> {
  const graphPath = resolveGraphPath(opts.root, opts.graph);
  const graph = loadGraph(opts.root, opts.graph);
  if (!graph) {
    throw new CliError('no map found — run `vg` to build one first', ExitCode.NOT_FOUND);
  }
  const sidecar = readHaileSidecar(graphPath, { corpusHash: graph.provenance?.corpusHash });
  const payload = projectChart(graph, sidecar);
  const host = opts.host ?? DEFAULT_CHART_HOST;
  const requested = opts.port ?? DEFAULT_CHART_PORT;
  const server = http.createServer((req, res) => handle(req, res, graph, sidecar, payload));
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
  payload: ReturnType<typeof projectChart>,
): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originAllowed(origin, process.env.VIBGRATE_ALLOWED_ORIGINS)) {
    send(res, 403, 'forbidden origin', 'text/plain');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathName = url.pathname;

  if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
    send(res, 200, chartPage(), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathName === '/api/meta') {
    json(res, payload.meta);
    return;
  }
  if (req.method === 'GET' && pathName === '/api/graph') {
    json(res, payload);
    return;
  }
  if (req.method === 'GET' && pathName === '/api/sidecar') {
    json(res, sidecar ?? { present: false });
    return;
  }
  if (req.method === 'GET' && pathName === '/api/search') {
    json(res, { results: searchNodes(payload, url.searchParams.get('q') ?? '') });
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
