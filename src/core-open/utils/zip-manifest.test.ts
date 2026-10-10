import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackageVersionManifest as loadCoreManifest } from '../package-version-manifest.js';
import { loadPackageVersionManifest, PackageManifestError } from '../../reporting/package-version-manifest.js';
import {
  ArchiveLimitError,
  ZIP_MANIFEST_MAX_ENTRIES,
  ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES,
  archiveLimitMessage,
  manifestArchivePath,
  readManifestZipMembers,
  readManifestZipMembersFromBuffer,
} from './zip-manifest.js';

const BODY = '{"npm":{"react":{"latest":"19.0.0"}}}';
const SENTINEL = 'manifest-body-sentinel-9f3a2c';

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: number;
  /** Central-directory uncompressed size. Defaults to `data` length for stored entries. */
  uncompressedSize?: number;
}

/** Minimal ZIP (stored or deflated) with sizes taken from the central directory. */
function buildZip(entries: ZipEntry[], entryCount = entries.length): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const compressed = entry.data;
    const uncomp = entry.uncompressedSize ?? compressed.length;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(compressed.length),
      u32(Math.min(uncomp, 0xffffffff)),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(compressed.length),
      u32(Math.min(uncomp, 0xffffffff)),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entryCount),
    u16(entryCount),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('zip manifest bounds', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vg-zip-manifest-'));
    dirs.push(dir);
    return dir;
  }

  it('uses a relative path inside the working directory and an absolute path outside it', () => {
    expect(manifestArchivePath('/repo/pkg/package-versions.zip', '/repo')).toBe('pkg/package-versions.zip');
    expect(manifestArchivePath('/tmp/package-versions.zip', '/repo')).toBe('/tmp/package-versions.zip');
  });

  it('inflates a stored manifest and ignores other members', () => {
    const zip = buildZip([
      { name: 'readme.txt', data: Buffer.from(SENTINEL) },
      { name: 'package-versions.json', data: Buffer.from(BODY) },
    ]);
    const texts = readManifestZipMembersFromBuffer(zip, '/tmp/package-versions.zip');
    expect(texts).toEqual([BODY]);
  });

  it('inflates a deflated manifest', () => {
    const raw = Buffer.from(BODY);
    const zip = buildZip([
      { name: 'package-versions.json', data: deflateRawSync(raw), method: 8, uncompressedSize: raw.length },
    ]);
    expect(readManifestZipMembersFromBuffer(zip, '/tmp/m.zip')).toEqual([BODY]);
  });

  it('prefers package-versions.json, then manifest.json, then index.json', () => {
    const zip = buildZip([
      { name: 'index.json', data: Buffer.from('{"npm":{"a":{"latest":"1"}}}') },
      { name: 'manifest.json', data: Buffer.from('{"npm":{"b":{"latest":"2"}}}') },
      { name: 'package-versions.json', data: Buffer.from(BODY) },
    ]);
    expect(readManifestZipMembersFromBuffer(zip, '/tmp/m.zip')[0]).toBe(BODY);
  });

  it('refuses a declared entry count over the limit without inflating the body', () => {
    const zip = buildZip(
      [{ name: 'package-versions.json', data: Buffer.from(`${BODY}${SENTINEL}`) }],
      ZIP_MANIFEST_MAX_ENTRIES + 1,
    );
    const archivePath = '/tmp/package-versions.zip';
    const expected = archiveLimitMessage(archivePath, 'entries', ZIP_MANIFEST_MAX_ENTRIES, ZIP_MANIFEST_MAX_ENTRIES + 1);
    const first = () => readManifestZipMembersFromBuffer(zip, archivePath);
    const second = () => readManifestZipMembersFromBuffer(Buffer.from(zip), archivePath);
    expect(first).toThrow(ArchiveLimitError);
    expect(second).toThrow(ArchiveLimitError);
    let a: unknown;
    let b: unknown;
    try {
      first();
    } catch (err) {
      a = err;
    }
    try {
      second();
    } catch (err) {
      b = err;
    }
    expect((a as Error).message).toBe(expected);
    expect((b as Error).message).toBe((a as Error).message);
    expect((a as Error).message).not.toContain(SENTINEL);
    expect((a as ArchiveLimitError).kind).toBe('entries');
  });

  it('refuses a declared uncompressed size over the limit before inflate', () => {
    const zip = buildZip([
      {
        name: 'package-versions.json',
        data: Buffer.from(SENTINEL),
        uncompressedSize: ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES + 1,
      },
    ]);
    const archivePath = '/var/tmp/package-versions.zip';
    expect(() => readManifestZipMembersFromBuffer(zip, archivePath)).toThrow(ArchiveLimitError);
    try {
      readManifestZipMembersFromBuffer(zip, archivePath);
    } catch (err) {
      expect(err).toMatchObject({
        kind: 'uncompressed-bytes',
        limit: ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES,
        actual: ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES + 1,
        message: archiveLimitMessage(
          archivePath,
          'uncompressed-bytes',
          ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES,
          ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES + 1,
        ),
      });
      expect((err as Error).message).not.toContain(SENTINEL);
    }
  });

  it('refuses a deflate stream that grows past its declared size', () => {
    const raw = Buffer.alloc(64, 0x61);
    const zip = buildZip([
      { name: 'package-versions.json', data: deflateRawSync(raw), method: 8, uncompressedSize: 1 },
    ]);
    expect(() => readManifestZipMembersFromBuffer(zip, '/tmp/bomb.zip')).toThrow(ArchiveLimitError);
    try {
      readManifestZipMembersFromBuffer(zip, '/tmp/bomb.zip');
    } catch (err) {
      expect((err as ArchiveLimitError).kind).toBe('uncompressed-bytes');
      expect((err as Error).message).toContain(`${ZIP_MANIFEST_MAX_UNCOMPRESSED_BYTES}-byte uncompressed size limit`);
      expect((err as Error).message).toContain('Pass a JSON package-version manifest to --package-manifest.');
    }
  });

  it('loads the same manifest from the same ZIP bytes through both loaders', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'package-versions.zip');
    await writeFile(zipPath, buildZip([{ name: 'package-versions.json', data: Buffer.from(BODY) }]));

    const reporting = await loadPackageVersionManifest(zipPath);
    const again = await loadPackageVersionManifest(zipPath);
    const core = await loadCoreManifest(zipPath);
    expect(reporting).toEqual(again);
    expect(core).toEqual(reporting);
    expect(reporting.npm?.react?.latest).toBe('19.0.0');
  });

  it('reports a stable actionable error from the package-manifest loaders', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'package-versions.zip');
    await writeFile(
      zipPath,
      buildZip(
        [{ name: 'package-versions.json', data: Buffer.from(SENTINEL) }],
        ZIP_MANIFEST_MAX_ENTRIES + 1,
      ),
    );
    const expected = archiveLimitMessage(zipPath, 'entries', ZIP_MANIFEST_MAX_ENTRIES, ZIP_MANIFEST_MAX_ENTRIES + 1);

    const reporting = await loadPackageVersionManifest(zipPath).catch((err: unknown) => err);
    const again = await loadPackageVersionManifest(zipPath).catch((err: unknown) => err);
    const core = await loadCoreManifest(zipPath).catch((err: unknown) => err);
    const direct = await readManifestZipMembers(zipPath).catch((err: unknown) => err);

    expect(reporting).toBeInstanceOf(PackageManifestError);
    expect(reporting).toMatchObject({ failure: 'unusable', message: expected });
    expect((again as Error).message).toBe((reporting as Error).message);
    expect(core).toBeInstanceOf(ArchiveLimitError);
    expect((core as Error).message).toBe(expected);
    expect((direct as Error).message).toBe(expected);
    for (const err of [reporting, core, direct]) {
      expect((err as Error).message).toContain(zipPath);
      expect((err as Error).message).toContain(`${ZIP_MANIFEST_MAX_ENTRIES}-entry limit`);
      expect((err as Error).message).not.toContain(SENTINEL);
      expect((err as Error).message).not.toContain('ENOENT');
    }
  });
});
