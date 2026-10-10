// Directory walks must not open archives. A hostile ZIP (entry count past the
// manifest bound) sits next to a source file; discovery and the scan walk
// finish and do not report the archive.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache } from '../src/core-open/utils/fs.js';
import { ZIP_MANIFEST_MAX_ENTRIES } from '../src/core-open/utils/zip-manifest.js';
import { discover } from '../src/engine/discover.js';

function overEntryZip(): Buffer {
  const name = Buffer.from('package-versions.json');
  const body = Buffer.from('{"npm":{}}');
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(body.length), u32(body.length), u16(name.length), u16(0), name, body,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(body.length), u32(body.length), u16(name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(0), name,
  ]);
  const count = ZIP_MANIFEST_MAX_ENTRIES + 1;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, eocd]);
}

describe('archive files during build and scan walks', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function project(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vg-archive-walk-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'ok.ts'), 'export const n = 1;\n');
    await writeFile(path.join(dir, 'vendor.zip'), overEntryZip());
    return dir;
  }

  it('does not open a hostile archive while discovering or scanning the tree', async () => {
    const root = await project();
    const first = discover({ root }).map((file) => file.rel);
    const second = discover({ root }).map((file) => file.rel);
    expect(first).toEqual(['ok.ts']);
    expect(second).toEqual(first);

    const cache = new FileCache();
    const entries = await cache.walkDir(root);
    const names = entries.filter((entry) => entry.isFile).map((entry) => entry.name).sort();
    expect(names).toEqual(['ok.ts']);
    expect(names).not.toContain('vendor.zip');
  });
});
