import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mergePackageDigests,
  parseCargoChecksum,
  parseGoSumHash,
  parseIntegrity,
  parsePrefixedHashList,
  sortPackageDigests,
  spdxAlgorithm,
  type PackageDigest,
} from './package-digest.js';

function sri(alg: 'sha256' | 'sha512', payload: string): { token: string; hex: string } {
  const buf = createHash(alg).update(payload).digest();
  return { token: `${alg}-${buf.toString('base64')}`, hex: buf.toString('hex') };
}

describe('package digests', () => {
  it('sorts by algorithm name, then hex value, and ignores input order', () => {
    const sha256 = sri('sha256', 'alpha');
    const sha512 = sri('sha512', 'beta');
    const other = sri('sha256', 'gamma');
    const smaller = sha256.hex < other.hex ? sha256.hex : other.hex;
    const larger = sha256.hex < other.hex ? other.hex : sha256.hex;
    expect(smaller).not.toBe(larger);

    const reversed: PackageDigest[] = [
      { alg: 'SHA-512', content: sha512.hex },
      { alg: 'SHA-256', content: larger },
      { alg: 'SHA-256', content: smaller },
      { alg: 'SHA-512', content: sha512.hex },
    ];
    const forward = [...reversed].reverse();
    const expected: PackageDigest[] = [
      { alg: 'SHA-256', content: smaller },
      { alg: 'SHA-256', content: larger },
      { alg: 'SHA-512', content: sha512.hex },
    ];

    expect(sortPackageDigests(reversed)).toEqual(expected);
    expect(sortPackageDigests(forward)).toEqual(expected);
    expect(mergePackageDigests(reversed, forward)).toEqual(expected);
    expect(spdxAlgorithm('SHA-256')).toBe('SHA256');
    expect(spdxAlgorithm('SHA-512')).toBe('SHA512');
  });

  it('decodes an SRI string and a prefixed hash to the same lowercase hex', () => {
    const sha256 = sri('sha256', 'payload');
    const fromSri = parseIntegrity(`${sri('sha512', 'other').token} ${sha256.token}`);
    const fromPrefixed = parseIntegrity(`sha256:${sha256.hex.toUpperCase()}`);
    expect(fromSri.map((d) => d.alg)).toEqual(['SHA-512', 'SHA-256']);
    expect(fromPrefixed).toEqual([{ alg: 'SHA-256', content: sha256.hex }]);
    expect(mergePackageDigests(fromSri, fromPrefixed)?.filter((d) => d.alg === 'SHA-256')).toEqual([
      { alg: 'SHA-256', content: sha256.hex },
    ]);
  });

  it('drops a token that is not a full digest and ignores content-hash', () => {
    expect(parseIntegrity('sha512-abc')).toEqual([]);
    expect(parseIntegrity('sha512-deadbeef==')).toEqual([]);
    expect(parseCargoChecksum('abc')).toBeUndefined();
    expect(parseGoSumHash('abc=')).toBeUndefined();
    expect(parsePrefixedHashList('content-hash = "sha256:' + 'ab'.repeat(32) + '"\n')).toEqual([]);
  });

  it('reads Cargo checksums and go.sum h1 values as SHA-256 hex', () => {
    const raw = createHash('sha256').update('crate').digest();
    expect(parseCargoChecksum(raw.toString('hex').toUpperCase())).toEqual({
      alg: 'SHA-256',
      content: raw.toString('hex'),
    });
    expect(parseGoSumHash(raw.toString('base64'))).toEqual({
      alg: 'SHA-256',
      content: raw.toString('hex'),
    });
  });
});
