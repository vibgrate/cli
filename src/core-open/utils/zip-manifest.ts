// Bounded reader for a ZIP package-version manifest.
//
// `vg build` and `vg scan` directory walks do not open archives they find in
// the tree (those extensions are skipped). The inflate path is
// `--package-manifest` when the file is a ZIP: this module checks the central
// directory, then inflates only the well-known manifest member, and never
// writes the rest of the archive out.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** A package-manifest ZIP may contain at most this many central-directory entries. */
export const ZIP_MANIFEST_MAX_ENTRIES = 10_000;

/**
 * Cap on declared uncompressed bytes (sum of members, and any one member) and
 * on the bytes we will inflate. Also the cap on the ZIP file itself.
 */
export const ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

/** On-disk size we will read. Larger files are refused before they are loaded. */
export const ZIP_MANIFEST_MAX_ARCHIVE_BYTES = ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES;

/** Manifest members, in the order a loader tries them. Root names only. */
export const ZIP_MANIFEST_NAMES = ['package-versions.json', 'manifest.json', 'index.json'] as const;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type ArchiveLimitKind = 'archive-bytes' | 'entries' | 'uncompressed-bytes';

/** The ZIP is readable but past a documented size or entry bound. The message is the UX. */
export class ArchiveLimitError extends Error {
  readonly kind: ArchiveLimitKind;
  readonly limit: number;
  readonly actual: number | undefined;
  readonly archivePath: string;

  constructor(archivePath: string, kind: ArchiveLimitKind, limit: number, actual?: number) {
    super(archiveLimitMessage(archivePath, kind, limit, actual));
    this.name = 'ArchiveLimitError';
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
    this.archivePath = archivePath;
  }
}

/** Not a usable ZIP manifest (truncated, encrypted, unknown method, no member). */
export class ZipManifestError extends Error {
  constructor() {
    super('zip manifest is not usable');
    this.name = 'ZipManifestError';
  }
}

/**
 * Path named in an archive-limit error. Inside the working directory this is
 * the relative POSIX path; otherwise it is the resolved absolute path.
 */
export function manifestArchivePath(resolved: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, resolved);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return resolved;
  return rel.split(path.sep).join('/');
}

function formatActual(kind: ArchiveLimitKind, actual: number | undefined): string {
  if (actual === undefined || !Number.isSafeInteger(actual)) return '';
  if (kind === 'entries') return ` (${actual} entries)`;
  return ` (${actual} bytes)`;
}

function limitPhrase(kind: ArchiveLimitKind, limit: number): string {
  if (kind === 'entries') return `${limit}-entry limit`;
  if (kind === 'archive-bytes') return `${limit}-byte size limit`;
  return `${limit}-byte uncompressed size limit`;
}

/** Stable, actionable text. Names the path, the limit, and what to pass instead. */
export function archiveLimitMessage(
  resolved: string,
  kind: ArchiveLimitKind,
  limit: number,
  actual?: number,
  cwd = process.cwd(),
): string {
  const shown = manifestArchivePath(resolved, cwd);
  return (
    `Package manifest is not usable: ${shown}. The archive exceeds the ${limitPhrase(kind, limit)}` +
    `${formatActual(kind, actual)}. Pass a JSON package-version manifest to --package-manifest.`
  );
}

function safeActual(n: bigint): number | undefined {
  if (n < 0n || n > MAX_SAFE) return undefined;
  return Number(n);
}

function need(buf: Buffer, off: number, len: number): void {
  if (off < 0 || len < 0 || off + len > buf.length) throw new ZipManifestError();
}

function u16(buf: Buffer, off: number): number {
  need(buf, off, 2);
  return buf.readUInt16LE(off);
}

function u32(buf: Buffer, off: number): number {
  need(buf, off, 4);
  return buf.readUInt32LE(off);
}

function u64(buf: Buffer, off: number): bigint {
  need(buf, off, 8);
  return buf.readBigUInt64LE(off);
}

interface Zip64Sizes {
  uncomp?: bigint;
  comp?: bigint;
  localOff?: bigint;
}

/** ZIP64 extra stores only the fields whose classic slots were sentinels, in a fixed order. */
function readZip64Extra(extra: Buffer, needUncomp: boolean, needComp: boolean, needOff: boolean): Zip64Sizes {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    const start = p + 4;
    const end = start + size;
    if (end > extra.length) break;
    if (id === ZIP64_EXTRA_ID) {
      let q = start;
      const read8 = (): bigint | undefined => {
        if (q + 8 > end) return undefined;
        const v = extra.readBigUInt64LE(q);
        q += 8;
        return v;
      };
      return {
        uncomp: needUncomp ? read8() : undefined,
        comp: needComp ? read8() : undefined,
        localOff: needOff ? read8() : undefined,
      };
    }
    p = end;
  }
  return {};
}

interface Eocd {
  entries: bigint;
  cdSize: bigint;
  cdOffset: bigint;
}

function findEocd(buf: Buffer): Eocd {
  const min = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) !== EOCD_SIG) continue;
    const commentLen = u16(buf, i + 20);
    if (i + 22 + commentLen !== buf.length) continue;
    return resolveEocd(buf, i);
  }
  throw new ZipManifestError();
}

function resolveEocd(buf: Buffer, eocdOff: number): Eocd {
  // Multi-disk archives are not a package manifest we can read safely.
  if (u16(buf, eocdOff + 4) !== 0 || u16(buf, eocdOff + 6) !== 0) throw new ZipManifestError();

  let entries = BigInt(u16(buf, eocdOff + 10));
  let cdSize = BigInt(u32(buf, eocdOff + 12));
  let cdOffset = BigInt(u32(buf, eocdOff + 16));
  const zip64 = entries === BigInt(U16_MAX) || cdSize === BigInt(U32_MAX) || cdOffset === BigInt(U32_MAX);
  if (!zip64) return { entries, cdSize, cdOffset };
  if (eocdOff < 20 || u32(buf, eocdOff - 20) !== ZIP64_LOCATOR_SIG) return { entries, cdSize, cdOffset };

  const zOff = u64(buf, eocdOff - 20 + 8);
  if (zOff > BigInt(buf.length) || zOff + 56n > BigInt(buf.length)) throw new ZipManifestError();
  const z = Number(zOff);
  if (u32(buf, z) !== ZIP64_EOCD_SIG) throw new ZipManifestError();
  if (entries === BigInt(U16_MAX)) entries = u64(buf, z + 32);
  if (cdSize === BigInt(U32_MAX)) cdSize = u64(buf, z + 40);
  if (cdOffset === BigInt(U32_MAX)) cdOffset = u64(buf, z + 48);
  return { entries, cdSize, cdOffset };
}

interface Member {
  name: string;
  method: number;
  flags: number;
  compSize: bigint;
  uncompSize: bigint;
  localOff: bigint;
}

function rootName(raw: string): string | null {
  const norm = raw.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!norm || norm.startsWith('/') || norm.split('/').includes('..')) return null;
  return norm;
}

function parseMembers(buf: Buffer, archivePath: string, eocd: Eocd): Member[] {
  if (eocd.entries > BigInt(ZIP_MANIFEST_MAX_ENTRIES)) {
    throw new ArchiveLimitError(archivePath, 'entries', ZIP_MANIFEST_MAX_ENTRIES, safeActual(eocd.entries));
  }
  if (eocd.cdOffset > BigInt(buf.length) || eocd.cdSize > BigInt(buf.length)) throw new ZipManifestError();
  if (eocd.cdOffset + eocd.cdSize > BigInt(buf.length)) throw new ZipManifestError();

  const count = Number(eocd.entries);
  let p = Number(eocd.cdOffset);
  const end = p + Number(eocd.cdSize);
  const members: Member[] = [];
  let totalUncomp = 0n;
  const maxUncomp = BigInt(ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES);

  for (let n = 0; n < count; n++) {
    if (p + 46 > end || u32(buf, p) !== CD_SIG) throw new ZipManifestError();
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    let compSize = BigInt(u32(buf, p + 20));
    let uncompSize = BigInt(u32(buf, p + 24));
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let localOff = BigInt(u32(buf, p + 42));
    const nameStart = p + 46;
    const extraStart = nameStart + nameLen;
    const next = extraStart + extraLen + commentLen;
    if (next > end) throw new ZipManifestError();

    const needUncomp = uncompSize === BigInt(U32_MAX);
    const needComp = compSize === BigInt(U32_MAX);
    const needOff = localOff === BigInt(U32_MAX);
    if (needUncomp || needComp || needOff) {
      const extra = readZip64Extra(buf.subarray(extraStart, extraStart + extraLen), needUncomp, needComp, needOff);
      if (needUncomp && extra.uncomp !== undefined) uncompSize = extra.uncomp;
      if (needComp && extra.comp !== undefined) compSize = extra.comp;
      if (needOff && extra.localOff !== undefined) localOff = extra.localOff;
    }

    if (uncompSize > maxUncomp || compSize > maxUncomp) {
      const over = uncompSize > maxUncomp ? uncompSize : compSize;
      throw new ArchiveLimitError(archivePath, 'uncompressed-bytes', ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES, safeActual(over));
    }
    totalUncomp += uncompSize;
    if (totalUncomp > maxUncomp) {
      throw new ArchiveLimitError(
        archivePath,
        'uncompressed-bytes',
        ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES,
        safeActual(totalUncomp),
      );
    }

    members.push({
      name: buf.toString('utf8', nameStart, nameStart + nameLen),
      method,
      flags,
      compSize,
      uncompSize,
      localOff,
    });
    p = next;
  }
  return members;
}

function inflateMember(buf: Buffer, archivePath: string, member: Member): Buffer {
  if ((member.flags & 0x1) !== 0) throw new ZipManifestError();
  if (member.localOff > BigInt(buf.length)) throw new ZipManifestError();
  const off = Number(member.localOff);
  if (u32(buf, off) !== LOCAL_SIG) throw new ZipManifestError();
  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const dataOff = off + 30 + nameLen + extraLen;
  if (member.compSize > BigInt(buf.length)) throw new ZipManifestError();
  const compSize = Number(member.compSize);
  need(buf, dataOff, compSize);
  const compressed = buf.subarray(dataOff, dataOff + compSize);
  const cap = ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES;

  if (member.method === 0) {
    if (compressed.length > cap) {
      throw new ArchiveLimitError(archivePath, 'uncompressed-bytes', cap, compressed.length);
    }
    return Buffer.from(compressed);
  }
  if (member.method !== 8) throw new ZipManifestError();

  // `maxOutputLength: 0` is not a usable cap (zlib treats 0 as unset). A member
  // that declares no output still cannot grow past one byte before we refuse.
  const declared = member.uncompSize > BigInt(cap) ? cap : Number(member.uncompSize);
  try {
    const out = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, declared) });
    if (out.length > declared || out.length > cap) {
      throw new ArchiveLimitError(archivePath, 'uncompressed-bytes', cap);
    }
    return out;
  } catch (err) {
    if (err instanceof ArchiveLimitError) throw err;
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveLimitError(archivePath, 'uncompressed-bytes', cap);
    }
    throw new ZipManifestError();
  }
}

/**
 * Inflate the well-known manifest members of `buf`, in preference order.
 * Other members are counted and sized, then left compressed.
 * Throws {@link ArchiveLimitError} or {@link ZipManifestError}.
 */
export function readManifestZipMembersFromBuffer(buf: Buffer, archivePath: string): string[] {
  if (buf.length > ZIP_MANIFEST_MAX_ARCHIVE_BYTES) {
    throw new ArchiveLimitError(archivePath, 'archive-bytes', ZIP_MANIFEST_MAX_ARCHIVE_BYTES, buf.length);
  }
  const members = parseMembers(buf, archivePath, findEocd(buf));
  const byName = new Map<string, Member>();
  for (const member of members) {
    const name = rootName(member.name);
    if (!name) continue;
    if ((ZIP_MANIFEST_NAMES as readonly string[]).includes(name)) byName.set(name, member);
  }

  const texts: string[] = [];
  for (const name of ZIP_MANIFEST_NAMES) {
    const member = byName.get(name);
    if (!member) continue;
    try {
      texts.push(inflateMember(buf, archivePath, member).toString('utf8'));
    } catch (err) {
      if (err instanceof ArchiveLimitError) throw err;
      // Unreadable member (unknown method, truncated local header). Try the
      // next well-known name; do not inflate anything else in the archive.
    }
  }
  if (texts.length === 0) throw new ZipManifestError();
  return texts;
}

/** Read a ZIP package manifest from disk without unpacking the archive onto the filesystem. */
export async function readManifestZipMembers(zipPath: string): Promise<string[]> {
  const size = (await stat(zipPath)).size;
  if (size > ZIP_MANIFEST_MAX_ARCHIVE_BYTES) {
    throw new ArchiveLimitError(zipPath, 'archive-bytes', ZIP_MANIFEST_MAX_ARCHIVE_BYTES, size);
  }
  const buf = await readFile(zipPath);
  return readManifestZipMembersFromBuffer(buf, zipPath);
}
