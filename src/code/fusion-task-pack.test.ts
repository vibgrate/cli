import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  fullOfflineFusionCorpus,
  fusionTaskFromSweJson,
  loadFusionTasksFromDir,
  sweBenchLiteOfflinePack,
} from './fusion-task-pack.js';
import { loadScaledFusionCorpus, runFusionTaskPack } from './trajectory-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePackDir = path.resolve(here, '../../bench/fusion-tasks');

describe('SWE-bench Lite offline corpus', () => {
  it('includes ≥10 tasks with capsule + oracle arms', () => {
    const pack = sweBenchLiteOfflinePack();
    expect(pack.length).toBeGreaterThanOrEqual(10);
    for (const t of pack) {
      expect(t.id).toMatch(/^swe-lite-/);
      expect(t.scripts.capsule?.length).toBeGreaterThan(0);
      expect(t.scripts.oracle?.length).toBeGreaterThan(0);
    }
  });

  it('loads JSON pack from bench/fusion-tasks', () => {
    const loaded = loadFusionTasksFromDir(samplePackDir);
    expect(loaded.some((t) => t.id === 'swe-lite-json-hello')).toBe(true);
  });

  it('parses SWE-shaped JSON', () => {
    const t = fusionTaskFromSweJson({
      instance_id: 'x',
      problem_statement: 'do thing',
      files: { 'a.ts': '1' },
      scripts: { capsule: [{ toolCalls: [{ id: '1', name: 'finish', arguments: { summary: 'ok' } }] }] },
    });
    expect(t?.id).toBe('x');
    expect(t?.instruction).toBe('do thing');
  });

  it('scaled corpus merges disk + built-in', () => {
    const all = loadScaledFusionCorpus([samplePackDir]);
    expect(all.length).toBeGreaterThan(fullOfflineFusionCorpus().length - 1);
    expect(all.some((t) => t.id === 'swe-lite-json-hello')).toBe(true);
  });

  it('runs scaled pack offline with FCS defined', async () => {
    // Subset for speed: first 4 built-in + json sample.
    const tasks = [...fullOfflineFusionCorpus().slice(0, 4), ...loadFusionTasksFromDir(samplePackDir)];
    const { report, results } = await runFusionTaskPack(tasks, { arms: ['capsule', 'oracle'] });
    expect(results.length).toBeGreaterThanOrEqual(8);
    expect(report.fcs).not.toBeNull();
    expect(report.capsuleRuns).toBeGreaterThan(0);
    expect(results.some((r) => r.trajectory.znsAt1)).toBe(true);
  }, 60_000);
});
