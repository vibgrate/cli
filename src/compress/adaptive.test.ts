import { describe, expect, it } from 'vitest';
import { hashString } from '../engine/hash.js';
import { compressibility, computeOptimalK, countUniqueSimhash, findKnee, hammingDistance, simhash, simhashClusters, uniqueBigramCurve, validateWithZlib } from './adaptive.js';

describe('simhash', () => {
  it('is deterministic and near for near-duplicates', () => {
    expect(simhash('hello world')).toEqual(simhash('hello world'));
    expect(hammingDistance(simhash('hello world'), simhash('Hello World'))).toBe(0);
    const near = hammingDistance(simhash('request 12 handled ok fine today'), simhash('request 13 handled ok fine today'));
    const far = hammingDistance(simhash('request 12 handled ok fine today'), simhash('zebra quantum flux capacitor overload'));
    expect(near).toBeLessThan(far);
    expect(far).toBeGreaterThan(12);
    expect(simhash('')).toEqual(simhash(''));
  });
  it('clusters greedily', () => {
    expect(countUniqueSimhash([])).toBe(0);
    expect(countUniqueSimhash(['same line', 'same line', 'same line'])).toBe(1);
    expect(countUniqueSimhash(['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota'])).toBe(3);
    expect(simhashClusters(['a b c', 'a b c', 'x y z'])).toEqual([0, 0, 1]);
  });
});

describe('knee detection', () => {
  it('follows the Kneedle rules', () => {
    expect(findKnee([1, 2])).toBeNull();
    expect(findKnee([3, 3, 3, 3])).toBe(1);
    expect(findKnee([0, 1, 2, 3, 4])).toBeNull();
    expect(findKnee([0, 10, 12, 13, 14, 15, 16, 17, 18, 19])).toBe(2);
  });
  it('builds bigram curves with the cjk and single-word rules', () => {
    expect(uniqueBigramCurve(['a b c', 'b c d', 'x'])).toEqual([2, 3, 4]);
    expect(uniqueBigramCurve(['数据库连接'])).toEqual([4]);
    expect(uniqueBigramCurve([''])).toEqual([1]);
  });
});

describe('computeOptimalK', () => {
  it('tier 1: small arrays and near-duplicates', () => {
    expect(computeOptimalK(['a', 'b', 'c'])).toBe(3);
    expect(computeOptimalK(['a', 'b', 'c', 'd'], 1, 3, 2)).toBe(2);
    const dup = Array.from({ length: 50 }, () => 'the same log line every time');
    expect(computeOptimalK(dup)).toBe(3);
    expect(computeOptimalK(dup, 1, 3, 2)).toBe(2);
  });
  it('tier 2/3: diverse data keeps more, bias scales, caps hold', () => {
    const diverse = Array.from({ length: 60 }, (_, i) => `entry ${i} ${['alpha', 'beta', 'gamma', 'delta'][i % 4]} ${(i * 7919) % 1000} ${['red', 'green', 'blue'][(i * 3) % 3]} token${i * 13}`);
    const k = computeOptimalK(diverse, 1, 3, 100);
    expect(k).toBeGreaterThanOrEqual(3);
    expect(k).toBeLessThanOrEqual(60);
    expect(computeOptimalK(diverse, 1, 3, 15)).toBeLessThanOrEqual(15);
    expect(computeOptimalK(diverse, 1.5, 3, 100)).toBeGreaterThanOrEqual(computeOptimalK(diverse, 0.7, 3, 100));
    expect(computeOptimalK(diverse, Number.NaN, 3, 100)).toBe(computeOptimalK(diverse, 1, 3, 100));
    const repetitive = Array.from({ length: 60 }, (_, i) => `request ${i % 3} ok`);
    expect(computeOptimalK(repetitive, 1, 3, 100)).toBeLessThan(k);
  });
  it('zlib validation grows k when the prefix lacks diversity', () => {
    const items = [...Array.from({ length: 20 }, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ...Array.from({ length: 20 }, (_, i) => hashString(`entropy-${i}`))];
    expect(Math.abs(compressibility(items.join('\n')) - compressibility(items.slice(0, 10).join('\n')))).toBeGreaterThan(0.15);
    expect(validateWithZlib(items, 10, 40)).toBe(12);
    expect(validateWithZlib(items, 40, 40)).toBe(40);
    expect(validateWithZlib(['a', 'b'], 1, 2)).toBe(1);
    expect(compressibility('')).toBe(1);
    expect(compressibility('a'.repeat(1000))).toBeLessThan(0.1);
  });
  it('is deterministic', () => {
    const items = Array.from({ length: 40 }, (_, i) => `item ${i} ${(i * 31) % 17}`);
    expect(computeOptimalK(items, 1, 3, 30)).toBe(computeOptimalK(items, 1, 3, 30));
  });
});
