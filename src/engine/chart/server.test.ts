import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { startChartServer, type ChartServer } from './server.js';

let server: ChartServer | undefined;
let dir: string | undefined;

async function fetchJson(url: string): Promise<Record<string, any>> {
  return (await fetch(url)).json() as Promise<Record<string, any>>;
}

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('chart server', () => {
  it('serves the map and vg-show-shaped node JSON on loopback', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-chart-'));
    const graphPath = path.join(dir, 'graph.json');
    fs.writeFileSync(graphPath, JSON.stringify(fixtureGraph()));
    server = await startChartServer({ root: dir, graph: graphPath, host: '127.0.0.1', port: 0 });
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);

    const page = await fetch(server.url + '/');
    expect(page.ok).toBe(true);
    const html = await page.text();
    expect(html).toContain('Code map');
    expect(html).not.toContain('HAILE');
    expect(html).not.toContain('confidence');

    const meta = await fetchJson(server.url + '/api/meta');
    expect(meta.magic).toBe('vg.chart.service.v1');
    expect(meta.architectureLoaded).toBe(false);

    const graph = await fetchJson(server.url + '/api/graph');
    expect(graph.nodes.every((n: { kind: string }) => n.kind !== 'file')).toBe(true);

    const node = await fetchJson(server.url + '/api/node/scanDir');
    expect(node.name).toBe('scanDir');
    expect(node.calls).toEqual(['readConfig']);
    expect(node.arch).toBeNull();
    expect(node.view.job).toBe('Function');

    const pathRes = await fetchJson(server.url + '/api/path?from=formatReport&to=readConfig');
    expect(pathRes.connected).toBe(true);
    expect(pathRes.ids).toEqual(['formatReport', 'scanDir', 'readConfig']);

    const reach = await fetchJson(server.url + '/api/reach/scanDir?dir=down');
    expect(reach.ids).toContain('readConfig');

    const search = await fetchJson(server.url + '/api/search?q=scan');
    expect(search.results.some((n: { id: string }) => n.id === 'scanDir')).toBe(true);

    const missing = await fetch(server.url + '/api/node/nope');
    expect(missing.status).toBe(404);
  });
});
