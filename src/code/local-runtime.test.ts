import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gatherSystemMemory } from './local-runtime.js';

// Regression guard: the loaded-models probe must reach Ollama over HTTP only.
// Shelling `ollama ps` auto-launches the Ollama desktop app on Windows/macOS
// whenever the server is down, so a read-only status probe (VS Code panel,
// `vg models`, `vg doctor`) would start software the user never asked for.

const savedHost = process.env.OLLAMA_HOST;

afterEach(() => {
  if (savedHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = savedHost;
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('gatherSystemMemory', () => {
  it('reads loaded models from a running server via /api/ps', async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/api/ps');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 5_500_000_000 }] }));
    });
    const port = await listen(server);
    process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
    try {
      const sys = await gatherSystemMemory();
      expect(sys.loaded).toEqual([{ name: 'qwen2.5-coder:7b', bytes: 5_500_000_000 }]);
      expect(sys.totalRamBytes).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('reports nothing loaded when the server is down — without launching anything', async () => {
    // Grab a port that is definitely closed.
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    process.env.OLLAMA_HOST = `127.0.0.1:${port}`; // schemeless, as Ollama allows
    const sys = await gatherSystemMemory();
    expect(sys.loaded).toEqual([]);
  });
});
