import { describe, it, expect, afterEach } from 'vitest';
import { runBenchmarkSuite } from '../src/commands/benchmark.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('runBenchmarkSuite', () => {
  it('reports build, throughput, memory, limits, and determinism metrics', async () => {
    const root = project(SAMPLE_FILES);
    const result = await runBenchmarkSuite(root, 2000);

    // Repo + build
    expect(result.repo.files).toBe(3);
    expect(result.repo.nodes).toBeGreaterThan(0);
    expect(result.build.coldMs).toBeGreaterThan(0);
    expect(result.build.incrementalMs).toBeGreaterThan(0);
    expect(result.build.reusedOnWarm).toBe(3); // warm build reuses every file

    // Throughput — derived from the cold build over the real corpus bytes.
    expect(result.throughput.corpusBytes).toBeGreaterThan(0);
    expect(result.throughput.filesPerSec).toBeGreaterThan(0);
    expect(result.throughput.mbPerSec).toBeGreaterThan(0);

    // Memory — peaks can never be below the baseline snapshot, and the
    // serialized artifact always has real size.
    expect(result.memory.baselineRssMb).toBeGreaterThan(0);
    expect(result.memory.peakRssMb).toBeGreaterThanOrEqual(result.memory.baselineRssMb);
    expect(result.memory.peakHeapMb).toBeGreaterThan(0);
    expect(result.memory.retainedHeapMb).toBeGreaterThanOrEqual(0);
    expect(result.memory.graphJsonBytes).toBeGreaterThan(0);
    expect(result.memory.bytesPerNode).toBeGreaterThan(0);

    // The effective resource-safeguard environment is recorded with the run.
    expect(result.limits.maxFileBytes).toBeGreaterThan(0);
    expect(result.limits.maxFiles).toBeGreaterThan(0);
    expect(result.limits.tscMaxFiles).toBeGreaterThan(0);
    expect(result.limits.memoryBudgetMb).toBeGreaterThan(0);

    // The artifact itself must stay deterministic even though timings vary.
    expect(result.determinism.byteIdentical).toBe(true);

    expect(result.tokenReduction.questions.length).toBeGreaterThan(0);
  });
});
