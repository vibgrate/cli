import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/embeddings.js', () => ({
  resolveEmbedModel: () => 'bge-small-en-v1.5',
  loadEmbedder: vi.fn(),
}));

/**
 * The worker caches its embedder in module state on purpose — loading once and
 * reusing for the process lifetime is the whole point of the warm worker — so
 * each case gets a fresh module rather than inheriting the previous test's
 * loaded (or failed) backend.
 */
async function freshWorker(embedder: unknown) {
  vi.resetModules();
  const embeddings = await import('../../engine/embeddings.js');
  (embeddings.loadEmbedder as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(embedder);
  const mod = await import('./embed-worker.js');
  return { handle: mod.handleWorkerRequest, loadEmbedder: embeddings.loadEmbedder as unknown as ReturnType<typeof vi.fn> };
}

function fakeEmbedder() {
  return {
    id: 'bge-small-en-v1.5',
    embed: vi.fn(async (texts: string[]) => texts.map((_, i) => [i, 0, 1])),
    embedQuery: vi.fn(async () => [9, 9, 9]),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('embed worker protocol', () => {
  it('answers ping without loading the backend', async () => {
    const { handle, loadEmbedder } = await freshWorker(fakeEmbedder());
    const res = await handle({ id: 1, op: 'ping' });
    expect(res).toMatchObject({ id: 1, ok: true, op: 'ping' });
    expect(loadEmbedder).not.toHaveBeenCalled();
  });

  it('embeds documents through the document path', async () => {
    const embedder = fakeEmbedder();
    const { handle } = await freshWorker(embedder);
    const res = await handle({ id: 2, op: 'embed', texts: ['a', 'b'] });
    expect(res).toMatchObject({ id: 2, ok: true, op: 'embed' });
    expect(embedder.embed).toHaveBeenCalledWith(['a', 'b']);
  });

  it('routes a single query through embedQuery, not the document path', async () => {
    // Models prepend a different instruction prefix for queries; using the
    // document path silently degrades ranking.
    const embedder = fakeEmbedder();
    const { handle } = await freshWorker(embedder);
    const res = await handle({ id: 3, op: 'embed', texts: ['find billing'], query: true });
    expect(res).toMatchObject({ ok: true, vectors: [[9, 9, 9]] });
    expect(embedder.embedQuery).toHaveBeenCalledWith('find billing');
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('reports an unavailable backend as an error frame, not a throw', async () => {
    const { handle } = await freshWorker(null);
    const res = await handle({ id: 4, op: 'embed', texts: ['a'] });
    expect(res).toMatchObject({ id: 4, ok: false });
    expect((res as { error: string }).error).toMatch(/unavailable/);
  });

  it('does not retry a backend that already failed to load', async () => {
    const { handle, loadEmbedder } = await freshWorker(null);
    await handle({ id: 5, op: 'embed', texts: ['a'] });
    await handle({ id: 6, op: 'embed', texts: ['b'] });
    expect(loadEmbedder).toHaveBeenCalledTimes(1);
  });

  it('loads the backend once and reuses it across requests', async () => {
    const { handle, loadEmbedder } = await freshWorker(fakeEmbedder());
    await handle({ id: 7, op: 'embed', texts: ['a'] });
    await handle({ id: 8, op: 'embed', texts: ['b'] });
    expect(loadEmbedder).toHaveBeenCalledTimes(1);
  });

  it('returns an empty result for an empty batch without loading anything', async () => {
    const { handle, loadEmbedder } = await freshWorker(fakeEmbedder());
    const res = await handle({ id: 9, op: 'embed', texts: [] });
    expect(res).toMatchObject({ ok: true, vectors: [] });
    expect(loadEmbedder).not.toHaveBeenCalled();
  });

  it('answers an unknown op rather than going silent (the caller is waiting)', async () => {
    const { handle } = await freshWorker(fakeEmbedder());
    const res = await handle({ id: 10, op: 'nope' as unknown as 'ping' });
    expect(res).toMatchObject({ id: 10, ok: false });
  });
});
