import { describe, it, expect, vi } from 'vitest';
import { loadEmbedder } from '../src/engine/embeddings.js';
import { makeProject, cleanup } from './helpers.js';

// No ambient backend: this is the shape a host that bundles the engine without
// the native optional dependency runs in (Vibgrate for VS Code), which is
// exactly where the host-supplied backend is the only one there is.
vi.mock('fastembed', () => {
  throw new Error("Cannot find module 'fastembed'");
});

/**
 * A backend that resolves but cannot load — a half-extracted npm tree, a native
 * binary built for another ABI, a missing transitive dependency. Reported as a
 * bare "not-installed", it sends the user to reinstall a backend that is
 * already on disk, forever. The loader must carry the real error out.
 */
describe('embedder loading diagnostics', () => {
  it('reports why a host-supplied backend did not load, not just "not-installed"', async () => {
    const host = makeProject({
      'node_modules/fastembed/package.json': JSON.stringify({
        name: 'fastembed',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/fastembed/index.cjs': "require('a-dependency-that-is-missing');",
    });
    const saved = process.env.VIBGRATE_EMBEDDER_PATH;
    process.env.VIBGRATE_EMBEDDER_PATH = host;
    try {
      let reason: string | undefined;
      let detail: string | undefined;
      const embedder = await loadEmbedder({
        onUnavailable: (r, d) => {
          reason = r;
          detail = d;
        },
      });
      expect(embedder).toBeNull();
      expect(reason).toBe('not-installed');
      expect(detail).toContain('a-dependency-that-is-missing');
      expect(detail).toContain(host);
    } finally {
      if (saved === undefined) delete process.env.VIBGRATE_EMBEDDER_PATH;
      else process.env.VIBGRATE_EMBEDDER_PATH = saved;
      cleanup(host);
    }
  });

  it('a backend present but exporting nothing usable is named as such', async () => {
    const host = makeProject({
      'node_modules/fastembed/package.json': JSON.stringify({
        name: 'fastembed',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/fastembed/index.cjs': 'module.exports = {};',
    });
    const saved = process.env.VIBGRATE_EMBEDDER_PATH;
    process.env.VIBGRATE_EMBEDDER_PATH = host;
    try {
      let detail: string | undefined;
      const embedder = await loadEmbedder({ onUnavailable: (_r, d) => (detail = d) });
      expect(embedder).toBeNull();
      expect(detail).toContain('exported no FlagEmbedding');
    } finally {
      if (saved === undefined) delete process.env.VIBGRATE_EMBEDDER_PATH;
      else process.env.VIBGRATE_EMBEDDER_PATH = saved;
      cleanup(host);
    }
  });
});
