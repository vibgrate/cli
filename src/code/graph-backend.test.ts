import { describe, it, expect, vi } from 'vitest';
import { localGraphBackend, resolveGraphBackend, vgdGraphBackend } from './graph-backend.js';
import { fixtureGraph } from './graph-fixture.js';

describe('graph backend', () => {
  it('localGraphBackend searches the in-process map', async () => {
    const b = localGraphBackend(fixtureGraph());
    const res = await b.search('scanDir');
    expect(res.source).toBe('local');
    expect(res.matches.some((m) => m.qualifiedName === 'scanDir' || m.id === 'scanDir')).toBe(true);
  });

  it('localGraphBackend impact finds dependents', async () => {
    const b = localGraphBackend(fixtureGraph());
    const imp = await b.impact('scanDir');
    expect(imp).not.toBeNull();
    expect(imp!.source).toBe('local');
    expect(imp!.root.name.length).toBeGreaterThan(0);
  });

  it('vgdGraphBackend uses daemon results when ok', async () => {
    const request = vi.fn(async (req: { op: string }) => {
      if (req.op === 'query-graph') {
        return {
          ok: true,
          matches: [
            {
              id: 'scanDir',
              qualifiedName: 'scanDir',
              kind: 'function',
              file: 'src/scan.ts',
              line: 5,
              score: 1,
              why: 'vgd',
            },
          ],
        };
      }
      return { ok: false, error: 'no' };
    });
    const b = vgdGraphBackend({
      repositoryId: 'r1',
      gitRef: 'main',
      socketPath: '/tmp/fake.sock',
      fallback: fixtureGraph(),
      request: request as never,
    });
    const res = await b.search('scanDir');
    expect(res.source).toBe('vgd');
    expect(res.matches[0]?.why).toBe('vgd');
    expect(request).toHaveBeenCalled();
  });

  it('vgdGraphBackend falls back to local on failure', async () => {
    const request = vi.fn(async () => {
      throw new Error('down');
    });
    const b = vgdGraphBackend({
      repositoryId: 'r1',
      fallback: fixtureGraph(),
      request: request as never,
    });
    const res = await b.search('scanDir');
    expect(res.source).toBe('local');
    expect(res.matches.length).toBeGreaterThan(0);
  });

  it('resolveGraphBackend picks vgd when socket + repo id set', () => {
    const b = resolveGraphBackend({
      graph: fixtureGraph(),
      repositoryId: 'abc',
      gitRef: 'main',
      socketPath: '/tmp/vgd.sock',
    });
    expect(b.source).toBe('vgd');
    const local = resolveGraphBackend({ graph: fixtureGraph() });
    expect(local.source).toBe('local');
  });
});
