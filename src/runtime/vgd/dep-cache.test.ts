import { describe, it, expect } from 'vitest';
import { DepContextCache } from './dep-cache.js';
import type { DriftInventory } from '../../engine/drift.js';

/**
 * The point of holding this centrally is that both readers — the manifest
 * digest and the dependency inventory — walk the same tree, so the cache must
 * do that walk once and then not again until something *knows* it moved.
 */

const inv = (names: string[]): DriftInventory =>
  ({
    records: names.map((name) => ({ name, ecosystem: 'npm', declared: '^1.0.0' })),
    counts: { total: names.length },
  }) as unknown as DriftInventory;

function cache(hashes: string[] = ['H1', 'H2', 'H3']) {
  let hashCalls = 0;
  let invCalls = 0;
  const c = new DepContextCache({
    computeHash: () => hashes[Math.min(hashCalls++, hashes.length - 1)]!,
    computeInventory: () => {
      invCalls++;
      return inv(['commander']);
    },
  });
  return { c, calls: () => ({ hashCalls, invCalls }) };
}

describe('DepContextCache', () => {
  it('walks once and reuses, however many callers ask', () => {
    const { c, calls } = cache();

    for (let i = 0; i < 5; i++) expect(c.get('repo1', '/repo')?.manifestHash).toBe('H1');

    expect(calls()).toEqual({ hashCalls: 1, invCalls: 1 });
  });

  it('recomputes only after an explicit invalidation', () => {
    const { c, calls } = cache();

    expect(c.get('repo1', '/repo')?.manifestHash).toBe('H1');
    c.invalidate('repo1');
    expect(c.get('repo1', '/repo')?.manifestHash).toBe('H2');

    expect(calls()).toEqual({ hashCalls: 2, invCalls: 2 });
  });

  it('keeps repositories apart — invalidating one leaves the other warm', () => {
    const { c, calls } = cache();

    expect(c.get('repo1', '/a')?.manifestHash).toBe('H1');
    expect(c.get('repo2', '/b')?.manifestHash).toBe('H2');
    expect(c.size()).toBe(2);

    c.invalidate('repo1');
    expect(c.size()).toBe(1);

    // repo2 was not invalidated, so it answers from the entry it already had.
    expect(c.get('repo2', '/b')?.manifestHash).toBe('H2');
    expect(calls().hashCalls).toBe(2);
  });

  it('returns the dependency records alongside the digest', () => {
    const { c } = cache();
    expect(c.get('repo1', '/repo')?.inventory.records.map((r) => r.name)).toEqual(['commander']);
  });

  it('returns null rather than throwing when the tree cannot be read', () => {
    const c = new DepContextCache({
      computeHash: () => {
        throw new Error('EACCES');
      },
      computeInventory: () => inv([]),
    });

    expect(c.get('repo1', '/repo')).toBeNull();
    // And it did not poison the entry — a later success still caches.
    expect(c.size()).toBe(0);
  });

  it('invalidating an unknown repository is a no-op', () => {
    const { c } = cache();
    expect(() => c.invalidate('never-seen')).not.toThrow();
  });
});
