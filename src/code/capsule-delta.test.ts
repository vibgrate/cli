import { describe, it, expect } from 'vitest';
import { TASK_CAPSULE_SCHEMA_VERSION, CAPSULE_RANKING_VERSION, CAPSULE_COMPILER_ID, type TaskCapsule } from './capsule.js';
import { buildCapsuleDelta, isEmptyCapsuleDelta } from './capsule-delta.js';

function miniCapsule(over: Partial<TaskCapsule> & { sourceContent?: string } = {}): TaskCapsule {
  const content = over.sourceContent ?? 'function scanDir() { return 0; }';
  const { sourceContent: _drop, ...rest } = over;
  return {
    schemaVersion: TASK_CAPSULE_SCHEMA_VERSION,
    instruction: 'raise timeout',
    primary: [
      {
        id: 'scanDir',
        qualifiedName: 'scanDir',
        kind: 'function',
        file: 'src/scan.ts',
        span: { start: 1, end: 1 },
        why: 'seed',
        importance: 1,
      },
    ],
    supporting: [],
    sourceSlices: [
      {
        file: 'src/scan.ts',
        start: 1,
        end: 1,
        content,
        contentHash: content.length.toString(16).padStart(64, '0'),
        symbolIds: ['scanDir'],
      },
    ],
    relationships: [],
    pinnedFacts: [],
    targetFiles: ['src/scan.ts'],
    verificationPlan: { syntaxFiles: ['src/scan.ts'], suggestedTests: [], notes: [] },
    rendered: content,
    tokensEstimate: 10,
    provenance: {
      compiler: CAPSULE_COMPILER_ID,
      rankingVersion: CAPSULE_RANKING_VERSION,
      graphCorpusHash: 'x',
      repositoryId: null,
    },
    ...rest,
  };
}

describe('capsule delta', () => {
  it('is empty for identical capsules', () => {
    const a = miniCapsule();
    const d = buildCapsuleDelta(a, a);
    expect(isEmptyCapsuleDelta(d)).toBe(true);
    expect(d.schemaVersion).toBe('capsule-delta/0');
  });

  it('detects source hash changes and primary adds', () => {
    const prev = miniCapsule({ sourceContent: 'function scanDir() { return 0; }' });
    const next = miniCapsule({
      sourceContent: 'function scanDir() { return 5000; }',
      primary: [
        ...prev.primary,
        {
          id: 'helper',
          qualifiedName: 'helper',
          kind: 'function',
          file: 'src/util.ts',
          span: { start: 1, end: 2 },
          why: 'new',
          importance: 0.5,
        },
      ],
    });
    // Ensure distinct hashes
    next.sourceSlices[0]!.contentHash = 'b'.repeat(64);
    prev.sourceSlices[0]!.contentHash = 'a'.repeat(64);

    const d = buildCapsuleDelta(prev, next);
    expect(d.changedSourceFiles).toContain('src/scan.ts');
    expect(d.addedPrimary.some((p) => p.qualifiedName === 'helper')).toBe(true);
    expect(isEmptyCapsuleDelta(d)).toBe(false);
    expect(d.rendered).toContain('Capsule delta');
    expect(d.tokensEstimate).toBeGreaterThan(0);
  });
});
