import { describe, it, expect } from 'vitest';
import {
  buildRunProvenance,
  hashMutation,
  mutationOp,
  CONTEXT_POLICY_VERSION,
  RUN_PROVENANCE_SCHEMA_VERSION,
} from './run-provenance.js';
import { CAPSULE_RANKING_VERSION } from './capsule.js';
import { hashString, canonicalize } from '../engine/hash.js';
import type { FileChange } from './types.js';

function change(over: Partial<FileChange> & Pick<FileChange, 'file' | 'before' | 'after'>): FileChange {
  return {
    outcomes: [],
    diff: over.diff ?? '',
    ...over,
  };
}

describe('mutationOp', () => {
  it('classifies create / delete / edit', () => {
    expect(mutationOp(null, 'x')).toBe('create');
    expect(mutationOp('x', null)).toBe('delete');
    expect(mutationOp('a', 'b')).toBe('edit');
  });
});

describe('hashMutation', () => {
  it('hashes before, after, and diff content', () => {
    const m = hashMutation(
      change({
        file: 'src/a.ts',
        before: 'old\n',
        after: 'new\n',
        diff: '--- a/src/a.ts\n+++ b/src/a.ts\n',
      }),
    );
    expect(m.op).toBe('edit');
    expect(m.beforeHash).toBe(hashString('old\n'));
    expect(m.afterHash).toBe(hashString('new\n'));
    expect(m.diffHash).toBe(hashString('--- a/src/a.ts\n+++ b/src/a.ts\n'));
  });

  it('uses null hashes for creates and deletes', () => {
    const created = hashMutation(change({ file: 'n.ts', before: null, after: 'hi', diff: '+hi' }));
    expect(created.op).toBe('create');
    expect(created.beforeHash).toBeNull();
    expect(created.afterHash).toBe(hashString('hi'));

    const deleted = hashMutation(change({ file: 'g.ts', before: 'bye', after: null, diff: '-bye' }));
    expect(deleted.op).toBe('delete');
    expect(deleted.afterHash).toBeNull();
    expect(deleted.beforeHash).toBe(hashString('bye'));
  });
});

describe('buildRunProvenance', () => {
  it('pins context-policy and ranking, and roots mutations stably', () => {
    const a = change({ file: 'b.ts', before: '1', after: '2', diff: 'd1' });
    const b = change({ file: 'a.ts', before: null, after: 'x', diff: 'd2' });
    const p = buildRunProvenance({
      modelProfileId: 'mep/local-7b',
      securityTier: 'L1',
      graphCorpusHash: 'abc',
      changes: [a, b],
    });
    expect(p.schemaVersion).toBe(RUN_PROVENANCE_SCHEMA_VERSION);
    expect(p.policyVersion).toBe(CONTEXT_POLICY_VERSION);
    expect(p.rankingVersion).toBe(CAPSULE_RANKING_VERSION);
    expect(p.modelProfileId).toBe('mep/local-7b');
    expect(p.securityTier).toBe('L1');
    expect(p.graphCorpusHash).toBe('abc');
    // Sorted by file: a.ts then b.ts
    expect(p.mutations.map((m) => m.file)).toEqual(['a.ts', 'b.ts']);
    expect(p.mutationsRootHash).toBe(hashString(canonicalize(p.mutations)));
  });

  it('is deterministic for the same inputs', () => {
    const changes = [change({ file: 'z.ts', before: 'a', after: 'b', diff: 'd' })];
    const x = buildRunProvenance({ changes, graphCorpusHash: 'g' });
    const y = buildRunProvenance({ changes, graphCorpusHash: 'g' });
    expect(x).toEqual(y);
  });

  it('empty mutations still produce a stable root hash', () => {
    const p = buildRunProvenance({});
    expect(p.mutations).toEqual([]);
    expect(p.mutationsRootHash).toBe(hashString(canonicalize([])));
    expect(p.policyVersion).toBe(CONTEXT_POLICY_VERSION);
  });

  it('hashes verification steps when provided', () => {
    const p = buildRunProvenance({
      verification: [
        { kind: 'syntax', passed: true, diagnostic: 'ok' },
        { kind: 'command', command: 'npm test', passed: false, diagnostic: 'FAIL' },
      ],
    });
    expect(p.verification).toHaveLength(2);
    expect(p.verificationRootHash).toBeTruthy();
    expect(p.verification?.every((v) => v.diagnosticHash)).toBe(true);
  });
});
