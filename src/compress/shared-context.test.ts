import { describe, expect, it } from 'vitest';
import { SharedContext } from './shared-context.js';
import { FakeRouter, jsonArrayFixture } from './test-double.js';

describe('SharedContext', () => {
  const big = jsonArrayFixture(60);

  it('publishes compressed hand-offs with retrievable originals', () => {
    const ctx = new SharedContext({ now: () => 1000, deps: { router: new FakeRouter({ keepItems: 4 }) }, compress: { ccr: { enabled: true } } });
    ctx.registerAgent('researcher', { role: 'search' });
    ctx.registerAgent('writer');
    const e = ctx.publish('research', big, { agent: 'researcher' });
    expect(e.compressedTokens).toBeLessThan(e.originalTokens);
    expect(e.compressed).toContain('<<vg-ccr:');
    expect(ctx.get('research')).toBe(e.compressed);
    expect(ctx.get('research', { full: true })).toBe(big);
    expect(ctx.store.retrieve(e.originalHash).content).toBe(big);
    for (const h of e.hashes) expect(ctx.store.exists(h)).toBe(true);
    const s = ctx.stats();
    expect(s).toMatchObject({ entries: 1, agents: 2 });
    expect(s.savingsPercent).toBeGreaterThan(30);
  });

  it('handoff payloads are deterministic and scoped to the sender', () => {
    const make = (): SharedContext => {
      const c = new SharedContext({ now: () => 1000, deps: { router: new FakeRouter({ keepItems: 4 }) } });
      c.publish('a', big, { agent: 'A' });
      c.publish('b', 'small note', { agent: 'B' });
      return c;
    };
    const p1 = make().handoff('A', 'B');
    const p2 = make().handoff('A', 'B');
    expect(p1).toEqual(p2);
    expect(p1.entries.map((e) => e.key)).toEqual(['a']);
    expect(p1.markers.length).toBeGreaterThan(0);
    expect(p1.storeRefs[0]).toMatchObject({ backend: 'memory' });
    expect(p1.tokensAfter).toBeLessThan(p1.tokensBefore);
    const all = make().handoff('C', 'B');
    expect(all.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(make().handoff('A', 'B', { keys: ['b'] }).entries.map((e) => e.key)).toEqual(['b']);
    expect(p1.id).not.toBe(all.id);
  });

  it('expires by TTL, evicts LRU, updates in place and fails open without a router', () => {
    let t = 0;
    const ctx = new SharedContext({ now: () => t, ttlSeconds: 10, maxEntries: 2, deps: { router: new FakeRouter() } });
    ctx.put('k1', 'one');
    t = 1000;
    ctx.put('k2', 'two');
    ctx.get('k1'); // touch → k2 is now least recent
    t = 2000;
    ctx.put('k3', 'three');
    expect(ctx.keys()).toEqual(['k1', 'k3']);
    ctx.put('k1', 'one-updated');
    expect(ctx.keys()).toEqual(['k3', 'k1']);
    t = 13_000;
    expect(ctx.get('k3')).toBeNull();
    expect(ctx.getEntry('k3')).toBeNull();
    expect(ctx.stats().entries).toBe(0);
    const plain = new SharedContext({ now: () => 1 });
    const e = plain.publish('x', 'hello world');
    expect(e.compressed).toBe('hello world');
    expect(plain.delete('x')).toBe(true);
    plain.clear();
  });
});
