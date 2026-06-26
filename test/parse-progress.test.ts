import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('parse-phase live progress', () => {
  it('reports onParseProgress climbing to the file total', async () => {
    const dir = makeProject(SAMPLE_FILES);
    dirs.push(dir);
    const seen: Array<[number, number]> = [];
    await buildGraph({
      root: dir,
      inline: true,
      generatedAt: '2020-01-01T00:00:00.000Z',
      onParseProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBeGreaterThan(0);
    const [done, total] = seen.at(-1)!;
    expect(total).toBeGreaterThan(0);
    expect(done).toBe(total); // progress reaches 100%
  });
});
