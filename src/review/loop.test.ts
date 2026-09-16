import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPatches, collectLoopPatches, loopNote } from './loop.js';
import type { DeterministicPatch } from './patches.js';
import { FINDINGS_SCHEMA, RECEIPT_SCHEMA } from './schemas.js';
import type { RunReviewResult } from './run.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function patch(overrides: Partial<DeterministicPatch> = {}): DeterministicPatch {
  return {
    path: 'package.json',
    before: '{ "dependencies": { "left-pad": "1.0.0" } }\n',
    after: '{ "dependencies": { "left-pad": "3.0.0" } }\n',
    reason: 'bump',
    packageName: 'left-pad',
    fromVersion: '1.0.0',
    toVersion: '3.0.0',
    ...overrides,
  };
}

describe('applyPatches', () => {
  it('writes the after text when the file still matches before', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-loop-'));
    dirs.push(root);
    const p = patch();
    fs.writeFileSync(path.join(root, 'package.json'), p.before);
    const applied = applyPatches(root, [p]);
    expect(applied).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(p.after);
  });

  it('skips a file that the user edited after inspect', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-loop-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "other" }\n');
    expect(applyPatches(root, [patch()])).toEqual([]);
  });
});

describe('loopNote', () => {
  it('is honest when no patch exists', () => {
    expect(loopNote([], 1)).toMatch(/does not invent a fix/);
    expect(loopNote([], 1)).not.toMatch(/AI/);
  });
});

describe('collectLoopPatches', () => {
  it('parses a current → latest pair from a finding claim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-loop-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{ "dependencies": { "left-pad": "1.0.0" } }\n');
    const result = {
      receipt: {
        schema_version: RECEIPT_SCHEMA,
        findings: {
          schema_version: FINDINGS_SCHEMA,
          architecture_findings: [],
          security_findings: [
            {
              id: 'sec-01',
              kind: 'known_vulnerable_dependency',
              claim: 'left-pad is 2 major version(s) behind (1.0.0 → 3.0.0).',
              paths: ['package.json'],
            },
          ],
        },
      },
    } as unknown as RunReviewResult;
    expect(collectLoopPatches(root, result)[0]?.toVersion).toBe('3.0.0');
  });
});
