import { describe, it, expect } from 'vitest';
import {
  KvBlockRegistry,
  contentHash,
  graphDraftCandidates,
  approxTokens,
  longestWarmPrefix,
  SessionPrefixCursor,
} from './kv-cache.js';

describe('kv-cache', () => {
  it('plans hits and misses by content hash', () => {
    const reg = new KvBlockRegistry();
    const system = 'You are a coding agent.';
    const capsule = 'function readConfig() {}';
    const p1 = reg.plan([
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
    ]);
    expect(p1.hit).toHaveLength(0);
    expect(p1.miss).toHaveLength(2);
    expect(p1.order).toHaveLength(2);
    expect(p1.totalTokens).toBe(approxTokens(system) + approxTokens(capsule));

    reg.commit([
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
    ]);
    const p2 = reg.plan([
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
      { kind: 'user', text: 'rename it' },
    ]);
    expect(p2.hit).toHaveLength(2);
    expect(p2.miss).toHaveLength(1);
    expect(p2.hitTokens).toBeGreaterThan(0);
    expect(contentHash(system)).toHaveLength(64);
  });

  it('longestWarmPrefix stops at first miss', () => {
    const reg = new KvBlockRegistry();
    const system = 'sys';
    const capsule = 'cap';
    reg.commit([
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
    ]);
    const prefix = longestWarmPrefix(reg, [
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
      { kind: 'user', text: 'new turn' },
    ]);
    expect(prefix.count).toBe(2);
    expect(prefix.tokens).toBeGreaterThan(0);
    expect(prefix.text).toContain('sys');
    expect(prefix.hashes).toHaveLength(2);

    const cold = longestWarmPrefix(reg, [{ kind: 'user', text: 'brand new' }]);
    expect(cold.count).toBe(0);
  });

  it('SessionPrefixCursor computes delta from fork', () => {
    const cursor = new SessionPrefixCursor();
    const segs1 = [
      { kind: 'system', text: 'sys' },
      { kind: 'capsule', text: 'cap' },
      { kind: 'user', text: 'turn1' },
    ];
    const reg = new KvBlockRegistry();
    const p1 = reg.plan(segs1, cursor);
    expect(p1.cursorSkipBlocks).toBe(0);
    cursor.commit(p1.order);
    reg.commit(segs1);

    const segs2 = [
      { kind: 'system', text: 'sys' },
      { kind: 'capsule', text: 'cap' },
      { kind: 'user', text: 'turn2' },
    ];
    const p2 = reg.plan(segs2, cursor);
    expect(p2.cursorSkipBlocks).toBe(2);
    expect(p2.deltaTokens).toBe(approxTokens('turn2'));
    expect(p2.hit.length).toBe(2);
  });

  it('graphDraftCandidates filters short/long', () => {
    const drafts = graphDraftCandidates(['short', 'export function readConfig(): Config {', 'x'.repeat(500)]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatch(/readConfig/);
  });
});
