import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../engine/load.js', () => ({
  loadGraph: vi.fn(),
}));
vi.mock('../commands/build.js', () => ({
  runBuild: vi.fn(async () => undefined),
}));

import { loadGraph } from '../engine/load.js';
import { runBuild } from '../commands/build.js';
import { ensureCodeMap } from './ensure-map.js';

const loadGraphMock = vi.mocked(loadGraph);
const runBuildMock = vi.mocked(runBuild);

describe('ensureCodeMap', () => {
  beforeEach(() => {
    loadGraphMock.mockReset();
    runBuildMock.mockReset();
    runBuildMock.mockResolvedValue(undefined);
  });

  it('returns ready without building when a map already exists', async () => {
    loadGraphMock.mockReturnValue({ nodes: [] } as never);
    const onProgress = vi.fn();
    await expect(ensureCodeMap('/repo', {}, { onProgress })).resolves.toBe('ready');
    expect(runBuildMock).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('builds once and reports start → progress → done', async () => {
    loadGraphMock.mockReturnValue(null);
    runBuildMock.mockImplementation(async (_paths, _opts, _global, hooks) => {
      hooks?.onParseProgress?.(2, 10);
      hooks?.onParseProgress?.(10, 10);
    });
    const phases: string[] = [];
    const status = await ensureCodeMap('/repo', { quiet: true }, {
      onProgress: (p) => phases.push(p.phase),
    });
    expect(status).toBe('built');
    expect(runBuildMock).toHaveBeenCalledOnce();
    expect(phases).toEqual(['start', 'progress', 'progress', 'done']);
  });

  it('reports error and rethrows when build fails', async () => {
    loadGraphMock.mockReturnValue(null);
    runBuildMock.mockRejectedValue(new Error('disk full'));
    const onProgress = vi.fn();
    await expect(ensureCodeMap('/repo', {}, { onProgress })).rejects.toThrow(/disk full/);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('disk full') }),
    );
  });
});
