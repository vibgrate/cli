/**
 * Package digests copied from a lockfile onto one SBOM component.
 *
 * Several digests on one component (two algorithms in one integrity string,
 * or the same package recorded by two lockfiles) are ordered by algorithm
 * name, then by the digest value, before anything serializes them. The
 * comparison is code-point order, so the array does not depend on locale or
 * on the order the lockfile listed the values.
 */

export interface ComponentDigest {
  /** CycloneDX hash algorithm name, such as `SHA-256`. */
  alg: string;
  /** Digest text copied from the lockfile (hex or base64). */
  content: string;
}

/** CycloneDX 1.5 `hash-alg` names, keyed by the spellings lockfiles use. */
const CYCLONE_ALG: Record<string, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  'sha-1': 'SHA-1',
  sha256: 'SHA-256',
  'sha-256': 'SHA-256',
  sha384: 'SHA-384',
  'sha-384': 'SHA-384',
  sha512: 'SHA-512',
  'sha-512': 'SHA-512',
  'sha3-256': 'SHA3-256',
  'sha3-384': 'SHA3-384',
  'sha3-512': 'SHA3-512',
  'blake2b-256': 'BLAKE2b-256',
  'blake2b-384': 'BLAKE2b-384',
  'blake2b-512': 'BLAKE2b-512',
  blake3: 'BLAKE3',
};

/** SPDX 2.3 checksum algorithm names for the same set. */
const SPDX_ALG: Record<string, string> = {
  MD5: 'MD5',
  'SHA-1': 'SHA1',
  'SHA-256': 'SHA256',
  'SHA-384': 'SHA384',
  'SHA-512': 'SHA512',
  'SHA3-256': 'SHA3-256',
  'SHA3-384': 'SHA3-384',
  'SHA3-512': 'SHA3-512',
  'BLAKE2b-256': 'BLAKE2b-256',
  'BLAKE2b-384': 'BLAKE2b-384',
  'BLAKE2b-512': 'BLAKE2b-512',
  BLAKE3: 'BLAKE3',
};

/** Digest lengths, in bytes, for the algorithms above. */
const DIGEST_BYTES = new Set([16, 20, 32, 48, 64]);

const ALG_PREFIXES = Object.keys(CYCLONE_ALG).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

export function compareDigestText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function canonicalDigestAlgorithm(raw: string): string | undefined {
  return CYCLONE_ALG[raw.trim().toLowerCase()];
}

/**
 * True for a hex or base64 encoding of a digest at one of the known lengths.
 * A lockfile field that does not match is not copied: registry tokens and
 * truncated strings stay out of the SBOM.
 */
export function isPackageDigestContent(content: string): boolean {
  if (/^[a-fA-F0-9]+$/.test(content) && content.length % 2 === 0 && DIGEST_BYTES.has(content.length / 2)) {
    return true;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 === 1) return false;
  const bytes = Buffer.from(content, 'base64');
  if (!DIGEST_BYTES.has(bytes.length)) return false;
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  return canonical === content.replace(/=+$/, '');
}

/** Sort by algorithm name, then value. Identical pairs collapse to one entry. */
export function orderComponentDigests(digests: readonly ComponentDigest[]): ComponentDigest[] {
  const unique = new Map<string, ComponentDigest>();
  for (const digest of digests) {
    const alg = canonicalDigestAlgorithm(digest.alg);
    const content = digest.content.trim();
    if (!alg || !content) continue;
    const key = `${alg}\0${content}`;
    if (!unique.has(key)) unique.set(key, { alg, content });
  }
  return [...unique.values()].sort((a, b) => compareDigestText(a.alg, b.alg) || compareDigestText(a.content, b.content));
}

export function toCycloneHashes(digests: readonly ComponentDigest[]): Array<{ alg: string; content: string }> {
  return orderComponentDigests(digests).map((digest) => ({ alg: digest.alg, content: digest.content }));
}

export function toSpdxChecksums(
  digests: readonly ComponentDigest[],
): Array<{ algorithm: string; checksumValue: string }> {
  return orderComponentDigests(digests)
    .map((digest) => ({ algorithm: SPDX_ALG[digest.alg] ?? digest.alg, checksumValue: digest.content }))
    .sort((a, b) => compareDigestText(a.algorithm, b.algorithm) || compareDigestText(a.checksumValue, b.checksumValue));
}

/** Stable fragment for the document id. Empty when the component has no digests. */
export function digestIdentity(digests: readonly ComponentDigest[] | undefined): string {
  return orderComponentDigests(digests ?? [])
    .map((digest) => `${digest.alg}:${digest.content}`)
    .join(',');
}

function splitLabeled(token: string, separator: '-' | ':'): ComponentDigest | undefined {
  const lower = token.toLowerCase();
  for (const prefix of ALG_PREFIXES) {
    const head = `${prefix}${separator}`;
    if (!lower.startsWith(head)) continue;
    const alg = CYCLONE_ALG[prefix];
    const content = token.slice(head.length).trim();
    if (!alg || !isPackageDigestContent(content)) return undefined;
    return { alg, content };
  }
  return undefined;
}

/** npm / pnpm / yarn Subresource Integrity (`sha512-<base64>`, several tokens allowed). */
export function digestsFromSri(integrity: string | undefined): ComponentDigest[] {
  if (!integrity) return [];
  const found: ComponentDigest[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const parsed = splitLabeled(token, '-');
    if (parsed) found.push(parsed);
  }
  return orderComponentDigests(found);
}

/** `hash = "sha256:<hex>"` labels inside a poetry.lock or uv.lock package block. */
export function digestsFromHashLabels(block: string): ComponentDigest[] {
  const found: ComponentDigest[] = [];
  for (const match of block.matchAll(/(?:^|[\s,{])hash\s*=\s*"([^"]+)"/g)) {
    const parsed = splitLabeled(match[1] ?? '', ':');
    if (parsed) found.push(parsed);
  }
  return orderComponentDigests(found);
}

/** Cargo.lock `checksum`, which is the crate's SHA-256 hex. */
export function digestFromCargoChecksum(checksum: string | undefined): ComponentDigest[] {
  if (!checksum || !/^[a-fA-F0-9]{64}$/.test(checksum)) return [];
  return [{ alg: 'SHA-256', content: checksum }];
}

/** go.sum `h1:` value for the module zip. The `/go.mod` line is not passed here. */
export function digestFromGoSumHash(hash: string | undefined): ComponentDigest[] {
  if (!hash?.startsWith('h1:')) return [];
  const content = hash.slice(3);
  if (!isPackageDigestContent(content)) return [];
  return [{ alg: 'SHA-256', content }];
}

/**
 * NuGet `packages.lock.json` `contentHash`. NuGet records the nupkg's
 * SHA-512 as standard base64. A value that is not 64 bytes of base64 is
 * left out: a token or a truncated string is not a digest.
 */
export function digestFromNugetContentHash(contentHash: string | undefined): ComponentDigest[] {
  if (!contentHash) return [];
  const content = contentHash.trim();
  if (!isPackageDigestContent(content)) return [];
  if (Buffer.from(content, 'base64').length !== 64) return [];
  return [{ alg: 'SHA-512', content }];
}
