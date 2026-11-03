import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  digestFromCargoChecksum,
  digestFromComposerShasum,
  digestFromGoSumHash,
  digestFromNugetContentHash,
  digestsFromHashLabels,
  digestsFromSri,
  orderComponentDigests,
  toCycloneHashes,
  toSpdxChecksums,
} from './component-digests.js';

function b64(algorithm: 'sha256' | 'sha512' | 'sha1', text: string): string {
  return createHash(algorithm).update(text).digest('base64');
}

const SHA256 = b64('sha256', 'alpha');
const SHA512 = b64('sha512', 'alpha');
const SHA1 = b64('sha1', 'alpha');

describe('orderComponentDigests', () => {
  it('sorts by algorithm name, then value, and collapses a duplicate pair', () => {
    const reversed = [
      { alg: 'SHA-512', content: 'zzz' },
      { alg: 'SHA-256', content: 'mmm' },
      { alg: 'sha1', content: 'aaa' },
      { alg: 'SHA-256', content: 'aaa' },
      { alg: 'sha512', content: 'zzz' },
    ];
    const ordered = [
      { alg: 'SHA-1', content: 'aaa' },
      { alg: 'SHA-256', content: 'aaa' },
      { alg: 'SHA-256', content: 'mmm' },
      { alg: 'SHA-512', content: 'zzz' },
    ];
    expect(orderComponentDigests(reversed)).toEqual(ordered);
    expect(orderComponentDigests([...reversed].reverse())).toEqual(ordered);
    expect(toCycloneHashes(reversed)).toEqual(ordered.map((digest) => ({ alg: digest.alg, content: digest.content })));
    expect(toSpdxChecksums(reversed)).toEqual([
      { algorithm: 'SHA1', checksumValue: 'aaa' },
      { algorithm: 'SHA256', checksumValue: 'aaa' },
      { algorithm: 'SHA256', checksumValue: 'mmm' },
      { algorithm: 'SHA512', checksumValue: 'zzz' },
    ]);
  });

  it('reads a multi-algorithm integrity string in algorithm order, not source order', () => {
    const integrity = `sha512-${SHA512} sha256-${SHA256} sha1-${SHA1}`;
    expect(digestsFromSri(integrity)).toEqual([
      { alg: 'SHA-1', content: SHA1 },
      { alg: 'SHA-256', content: SHA256 },
      { alg: 'SHA-512', content: SHA512 },
    ]);
    expect(digestsFromSri(`sha256-${SHA256} sha512-${SHA512} sha1-${SHA1}`)).toEqual(digestsFromSri(integrity));
  });

  it('drops a value that is not a digest, including a token planted in the field', () => {
    expect(digestsFromSri('sha512-super-secret-token')).toEqual([]);
    expect(digestsFromSri(`sha512-${SHA512} sha256-not-a-digest`)).toEqual([{ alg: 'SHA-512', content: SHA512 }]);
    expect(digestFromCargoChecksum('super-secret-token')).toEqual([]);
    expect(digestFromComposerShasum('super-secret-token')).toEqual([]);
    expect(digestFromComposerShasum('a'.repeat(64))).toEqual([]);
    expect(digestFromGoSumHash('h1:abc=')).toEqual([]);
    expect(digestFromNugetContentHash('super-secret-token')).toEqual([]);
    expect(digestFromNugetContentHash(SHA256)).toEqual([]);
    expect(digestsFromHashLabels('hash = "sha256:super-secret-token"')).toEqual([]);
  });

  it('reads a NuGet contentHash as SHA-512 and keeps the lockfile text', () => {
    expect(digestFromNugetContentHash(`  ${SHA512}  `)).toEqual([{ alg: 'SHA-512', content: SHA512 }]);
  });
});
