import { describe, it, expect, afterEach } from 'vitest';
import { verifyDeterminism } from '../src/engine/verify.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('verifyDeterminism', () => {
  it('passes on a normal project', async () => {
    const root = makeProject(SAMPLE_FILES);
    dirs.push(root);
    const result = await verifyDeterminism({ root });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
