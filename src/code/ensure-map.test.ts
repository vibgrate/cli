import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../engine/load.js', () => ({
  graphExists: vi.fn(),
}));
vi.mock('../commands/build.js', () => ({
  runBuild: vi.fn(async () => undefined),
}));
vi.mock('../runtime/vgd/attach.js', () => ({
  attachVgd: vi.fn(async () => ({ status: 'unavailable', reason: 'test' })),
  daemonDisabledReason: vi.fn(() => 'test'),
}));
vi.mock('../runtime/vgd/client.js', () => ({
  vgdRequest: vi.fn(),
}));

import { graphExists } from '../engine/load.js';
import { runBuild } from '../commands/build.js';
import { attachVgd, daemonDisabledReason } from '../runtime/vgd/attach.js';
import { vgdRequest } from '../runtime/vgd/client.js';
import { ensureCodeMap } from './ensure-map.js';

const graphExistsMock = vi.mocked(graphExists);
const runBuildMock = vi.mocked(runBuild);
const attachMock = vi.mocked(attachVgd);
const disabledMock = vi.mocked(daemonDisabledReason);
const requestMock = vi.mocked(vgdRequest);

describe('ensureCodeMap', () => {
  beforeEach(() => {
    graphExistsMock.mockReset();
    runBuildMock.mockReset();
    runBuildMock.mockResolvedValue(undefined);
    attachMock.mockReset();
    attachMock.mockResolvedValue({ status: 'unavailable', reason: 'test' });
    disabledMock.mockReset();
    disabledMock.mockReturnValue('test');
    requestMock.mockReset();
  });

  it('returns ready without building when a map already exists', async () => {
    graphExistsMock.mockReturnValue(true);
    const onProgress = vi.fn();
    await expect(ensureCodeMap('/repo', {}, { onProgress })).resolves.toBe('ready');
    expect(runBuildMock).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('asks the daemon to build when no map exists and vgd is up', async () => {
    graphExistsMock.mockReturnValue(false);
    disabledMock.mockReturnValue(null);
    attachMock.mockResolvedValue({ status: 'attached', socketPath: '/tmp/vgd.sock', repositoryId: 'r1' });
    requestMock.mockResolvedValue({
      ok: true,
      stored: true,
      repositoryId: 'r1',
      gitRef: 'main',
      nodeCount: 12,
      rebuilt: true,
    });
    const phases: string[] = [];
    await expect(
      ensureCodeMap('/repo', {}, { onProgress: (p) => phases.push(p.phase) }),
    ).resolves.toBe('built');
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'ensure-graph', root: '/repo' }),
      expect.objectContaining({ socketPath: '/tmp/vgd.sock' }),
    );
    expect(runBuildMock).not.toHaveBeenCalled();
    expect(phases).toEqual(['start', 'done']);
  });

  it('builds once and reports start → progress → done', async () => {
    graphExistsMock.mockReturnValue(false);
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
    graphExistsMock.mockReturnValue(false);
    runBuildMock.mockRejectedValue(new Error('disk full'));
    const onProgress = vi.fn();
    await expect(ensureCodeMap('/repo', {}, { onProgress })).rejects.toThrow(/disk full/);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('disk full') }),
    );
  });
});
