/**
 * Package digests copied from a lockfile onto an SBOM component.
 *
 * CycloneDX `hashes` and SPDX `checksums` are the same list. Each entry is
 * sorted by the CycloneDX algorithm name, then by the lowercase hex value,
 * using code-unit order (the same order as `<` on strings). That order is
 * independent of lockfile order, Map insertion, and which format is written.
 * A token that is not a known algorithm, or whose decoded length is not that
 * algorithm's digest length, is dropped. The component stays.
 */

export type PackageDigestAlgorithm =
  | 'MD5'
  | 'SHA-1'
  | 'SHA-256'
  | 'SHA-384'
  | 'SHA-512'
  | 'SHA3-256'
  | 'SHA3-384'
  | 'SHA3-512'
  | 'BLAKE2b-256'
  | 'BLAKE2b-384'
  | 'BLAKE2b-512'
  | 'BLAKE3';

export interface PackageDigest {
  /** CycloneDX hash algorithm. First sort key. */
  alg: PackageDigestAlgorithm;
  /** Lowercase hex. Second sort key. Also the SPDX `checksumValue`. */
  content: string;
}

interface AlgSpec {
  alg: PackageDigestAlgorithm;
  spdx: string;
  bytes: number;
}

const ALGS: Record<string, AlgSpec> = {
  md5: { alg: 'MD5', spdx: 'MD5', bytes: 16 },
  sha1: { alg: 'SHA-1', spdx: 'SHA1', bytes: 20 },
  'sha-1': { alg: 'SHA-1', spdx: 'SHA1', bytes: 20 },
  sha256: { alg: 'SHA-256', spdx: 'SHA256', bytes: 32 },
  'sha-256': { alg: 'SHA-256', spdx: 'SHA256', bytes: 32 },
  sha384: { alg: 'SHA-384', spdx: 'SHA384', bytes: 48 },
  'sha-384': { alg: 'SHA-384', spdx: 'SHA384', bytes: 48 },
  sha512: { alg: 'SHA-512', spdx: 'SHA512', bytes: 64 },
  'sha-512': { alg: 'SHA-512', spdx: 'SHA512', bytes: 64 },
  'sha3-256': { alg: 'SHA3-256', spdx: 'SHA3-256', bytes: 32 },
  'sha3-384': { alg: 'SHA3-384', spdx: 'SHA3-384', bytes: 48 },
  'sha3-512': { alg: 'SHA3-512', spdx: 'SHA3-512', bytes: 64 },
  'blake2b-256': { alg: 'BLAKE2b-256', spdx: 'BLAKE2b-256', bytes: 32 },
  'blake2b-384': { alg: 'BLAKE2b-384', spdx: 'BLAKE2b-384', bytes: 48 },
  'blake2b-512': { alg: 'BLAKE2b-512', spdx: 'BLAKE2b-512', bytes: 64 },
  blake3: { alg: 'BLAKE3', spdx: 'BLAKE3', bytes: 32 },
};

const SPDX_BY_ALG: Record<string, string> = {};
for (const spec of Object.values(ALGS)) SPDX_BY_ALG[spec.alg] = spec.spdx;

function lookupAlg(raw: string): AlgSpec | undefined {
  const key = raw.trim().toLowerCase().replace(/_/g, '-');
  return ALGS[key];
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Stable order: CycloneDX algorithm name, then lowercase hex content. */
export function comparePackageDigests(a: PackageDigest, b: PackageDigest): number {
  return compareText(a.alg, b.alg) || compareText(a.content, b.content);
}

/**
 * Dedupe by algorithm + content and sort. An empty input is an empty array;
 * callers that omit the SBOM field use {@link mergePackageDigests}.
 */
export function sortPackageDigests(digests: readonly PackageDigest[]): PackageDigest[] {
  const byKey = new Map<string, PackageDigest>();
  for (const digest of digests) {
    byKey.set(`${digest.alg}\0${digest.content}`, digest);
  }
  return [...byKey.values()].sort(comparePackageDigests);
}

/** Union of digest lists. `undefined` when nothing well-formed remains, so the field can be omitted. */
export function mergePackageDigests(...groups: Array<readonly PackageDigest[] | undefined>): PackageDigest[] | undefined {
  const sorted = sortPackageDigests(groups.flatMap((group) => group ?? []));
  return sorted.length > 0 ? sorted : undefined;
}

/** SPDX 2.3 algorithm name for a CycloneDX `alg`. Unknown names are returned unchanged. */
export function spdxAlgorithm(alg: string): string {
  return SPDX_BY_ALG[alg] ?? alg;
}

function digestFromHex(spec: AlgSpec, hex: string): PackageDigest | undefined {
  if (hex.length !== spec.bytes * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  return { alg: spec.alg, content: hex.toLowerCase() };
}

function digestFromBase64Bytes(spec: AlgSpec, encoded: string): PackageDigest | undefined {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bytes = Buffer.from(normalized + pad, 'base64');
  if (bytes.length !== spec.bytes) return undefined;
  return { alg: spec.alg, content: bytes.toString('hex') };
}

/** `sha256:<hex>` and the other prefixed forms. */
export function parsePrefixedDigest(token: string): PackageDigest | undefined {
  const m = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*):([0-9a-fA-F]+)$/.exec(token.trim());
  if (!m) return undefined;
  const spec = lookupAlg(m[1]);
  if (!spec) return undefined;
  return digestFromHex(spec, m[2]);
}

/** Subresource Integrity token: `sha512-<base64>`. */
export function parseSriToken(token: string): PackageDigest | undefined {
  const m = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-([A-Za-z0-9+/_-]+={0,2})$/.exec(token.trim());
  if (!m) return undefined;
  const spec = lookupAlg(m[1]);
  if (!spec) return undefined;
  return digestFromBase64Bytes(spec, m[2]);
}

/**
 * One lockfile integrity string. Several digests are separated by whitespace
 * (`sha512-<base64> sha256-<base64>`). Prefixed `algo:hex` tokens are accepted
 * in the same string. Tokens that do not decode are skipped.
 */
export function parseIntegrity(value: string): PackageDigest[] {
  const out: PackageDigest[] = [];
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    const parsed = parseSriToken(token) ?? parsePrefixedDigest(token);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Cargo.lock `checksum`: 64 hex characters, SHA-256. Anything else is dropped. */
export function parseCargoChecksum(hex: string): PackageDigest | undefined {
  const spec = lookupAlg('sha256');
  return spec ? digestFromHex(spec, hex.trim()) : undefined;
}

/** go.sum `h1:` payload: base64 SHA-256. A short or non-decoding value is dropped. */
export function parseGoSumHash(encoded: string): PackageDigest | undefined {
  const spec = lookupAlg('sha256');
  return spec ? digestFromBase64Bytes(spec, encoded.trim()) : undefined;
}

/**
 * `hash = "sha256:…"` inside a poetry.lock / uv.lock package block.
 * `content-hash` and `content_hash` do not match: the character before `hash`
 * has to be outside `[A-Za-z0-9_-]`.
 */
export function parsePrefixedHashList(block: string): PackageDigest[] {
  const out: PackageDigest[] = [];
  const re = /(?:^|[^A-Za-z0-9_-])hash\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const token = m[1] ?? m[2];
    if (!token) continue;
    const parsed = parsePrefixedDigest(token);
    if (parsed) out.push(parsed);
  }
  return out;
}
