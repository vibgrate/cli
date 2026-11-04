import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const fetchDockerVersionsBulk = vi.hoisted(() =>
  vi.fn(async (imageRefs: string[]) => {
    const latest: Record<string, string> = {
      'library/golang': '1.23.0',
      'library/postgres': '16.0.0',
    };
    const results = new Map<string, string>();
    for (const ref of imageRefs) {
      const version = latest[ref];
      if (version) results.set(ref, version);
    }
    return results;
  }),
);

vi.mock('../src/core-open/scanners/docker-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core-open/scanners/docker-cache.js')>();
  return { ...actual, fetchDockerVersionsBulk };
});

import { scanDocker } from '../src/core-open/scanners/docker-scanner.js';

async function writeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-docker-scan-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe('scanDocker tag dedup', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    fetchDockerVersionsBulk.mockClear();
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('keeps every tag of an image and computes drift per tag', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'FROM postgres:16.0.0',
        'FROM golang:1.23.0',
        'FROM golang:1.21.0',
        'FROM postgres:13.0.0',
        'FROM golang:1.21.0',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(scan).not.toBeNull();

    const rows = scan!.dependencies.map((row) => ({
      package: row.package,
      currentSpec: row.currentSpec,
      drift: row.drift,
      majorsBehind: row.majorsBehind,
    }));

    expect(rows).toEqual([
      { package: 'library/golang', currentSpec: '1.21.0', drift: 'minor-behind', majorsBehind: 0 },
      { package: 'library/golang', currentSpec: '1.23.0', drift: 'current', majorsBehind: 0 },
      { package: 'library/postgres', currentSpec: '13.0.0', drift: 'major-behind', majorsBehind: 3 },
      { package: 'library/postgres', currentSpec: '16.0.0', drift: 'current', majorsBehind: 0 },
    ]);

    expect(fetchDockerVersionsBulk).toHaveBeenCalledTimes(1);
    expect(fetchDockerVersionsBulk.mock.calls[0]?.[0]).toEqual([
      'library/golang',
      'library/postgres',
    ]);
  });

  it('reports golang:1.21 and golang:1.23 as separate rows', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM golang:1.23\nFROM golang:1.21\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(scan!.dependencies.map((row) => row.currentSpec)).toEqual(['1.21', '1.23']);
    expect(scan!.dependencies.every((row) => row.package === 'library/golang')).toBe(true);
    expect(fetchDockerVersionsBulk.mock.calls[0]?.[0]).toEqual(['library/golang']);
  });

  it('keeps one row when the same name and tag appear twice', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM golang:1.21.0\nFROM golang:1.21.0\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(scan!.dependencies).toHaveLength(1);
    expect(scan!.dependencies[0]).toMatchObject({
      package: 'library/golang',
      currentSpec: '1.21.0',
      drift: 'minor-behind',
    });
  });

  it('keeps compose services on different tags and drops a repeated tag', async () => {
    const dir = await writeProject({
      'docker-compose.yml': [
        'services:',
        '  db-old:',
        '    image: postgres:16',
        '  db-new:',
        '    image: postgres:13',
        '  db-old-again:',
        '    image: postgres:16',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(scan!.dependencies.map((row) => `${row.package}:${row.currentSpec}`)).toEqual([
      'library/postgres:13',
      'library/postgres:16',
    ]);
    expect(fetchDockerVersionsBulk.mock.calls[0]?.[0]).toEqual(['library/postgres']);
  });

  it('orders rows by name then tag regardless of source order', async () => {
    const forward = await writeProject({
      Dockerfile: 'FROM golang:1.21.0\nFROM postgres:16.0.0\n',
    });
    const reverse = await writeProject({
      Dockerfile: 'FROM postgres:16.0.0\nFROM golang:1.21.0\n',
    });
    dirs.push(forward, reverse);

    const a = await scanDocker(forward, undefined, undefined, true);
    const b = await scanDocker(reverse, undefined, undefined, true);
    const shape = (scan: NonNullable<typeof a>) =>
      scan.dependencies.map((row) => [row.package, row.currentSpec, row.drift]);

    expect(shape(a!)).toEqual([
      ['library/golang', '1.21.0', 'minor-behind'],
      ['library/postgres', '16.0.0', 'current'],
    ]);
    expect(shape(b!)).toEqual(shape(a!));
  });
});
