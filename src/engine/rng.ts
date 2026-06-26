/**
 * A tiny seeded PRNG (mulberry32). Used to make Louvain clustering deterministic
 * — same graph + same seed → same communities, every run, every machine. Never
 * use `Math.random()` anywhere in the engine; that would break the determinism
 * contract (VG-ENGINE-TEARDOWN §5).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixed clustering seed (matches the documented determinism inputs). */
export const CLUSTER_SEED = 42;
