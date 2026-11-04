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

import { isDockerManifest, scanDocker, scanDockerProjects } from '../src/core-open/scanners/docker-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';

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

describe('docker manifest names', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    fetchDockerVersionsBulk.mockClear();
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function writeTree(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-docker-scan-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      const abs = path.join(dir, name);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
    }
    return dir;
  }

  function imageRows(scan: { dependencies: { package: string; currentSpec: string | null }[] }): string[] {
    return scan.dependencies.map((row) => `${row.package}:${row.currentSpec}`);
  }

  it('recognises Dockerfiles, Containerfiles, and Compose overrides', () => {
    const names = [
      'Dockerfile',
      'Containerfile',
      'Dockerfile.prod',
      'Dockerfile.dev',
      'api.Dockerfile',
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
      'docker-compose.override.yml',
      'docker-compose.prod.yaml',
      'compose.override.yaml',
      'compose.ci.yml',
      'docker-compose.prod.override.yml',
    ];
    for (const name of names) expect(isDockerManifest(name), name).toBe(true);

    const skipped = [
      'dockerfile',
      'containerfile',
      'Dockerfile.',
      '.Dockerfile',
      'Dockerfiles',
      'compose.yml.bak',
      'composer.yml',
      'my-compose.yml',
      'docker-compose',
      'notes.md',
    ];
    for (const name of skipped) expect(isDockerManifest(name), name).toBe(false);
  });

  it('yields rows from Dockerfile.prod and Containerfile', async () => {
    const dir = await writeTree({
      'Dockerfile.prod': 'FROM node:20-alpine\nFROM golang:1.21\n',
      Containerfile: 'FROM alpine:3.20\nFROM node:20-alpine\n',
    });

    const expected = [
      'library/alpine:3.20',
      'library/golang:1.21',
      'library/node:20-alpine',
    ];
    const scan = await scanDocker(dir, undefined, undefined, true);
    const cached = await scanDocker(dir, new FileCache(), undefined, true);
    expect(imageRows(scan!)).toEqual(expected);
    expect(imageRows(cached!)).toEqual(expected);
  });

  it('reads api.Dockerfile', async () => {
    const dir = await writeTree({
      'api.Dockerfile': 'FROM python:3.12\n',
    });

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan!)).toEqual(['library/python:3.12']);
  });

  it('yields images from compose.yaml and compose.override.yaml', async () => {
    const dir = await writeTree({
      'compose.yaml': [
        'services:',
        '  web:',
        '    image: nginx:1.27',
        '  cache:',
        '    image: redis:7',
        '',
      ].join('\n'),
      'compose.override.yaml': [
        'services:',
        '  web:',
        '    image: nginx:1.27',
        '  db:',
        '    image: postgres:16',
        '',
      ].join('\n'),
    });

    const expected = [
      'library/nginx:1.27',
      'library/postgres:16',
      'library/redis:7',
    ];
    const scan = await scanDocker(dir, undefined, undefined, true);
    const cached = await scanDocker(dir, new FileCache(), undefined, true);
    expect(imageRows(scan!)).toEqual(expected);
    expect(imageRows(cached!)).toEqual(expected);
  });

  it('parses docker-compose.yml and compose.yaml in the same directory', async () => {
    const dir = await writeTree({
      'docker-compose.yml': 'services:\n  web:\n    image: nginx:1.25\n',
      'compose.yaml': 'services:\n  edge:\n    image: traefik:3.0\n',
    });

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan!)).toEqual([
      'library/nginx:1.25',
      'library/traefik:3.0',
    ]);
  });

  it('keeps one row when two manifests name the same image and tag', async () => {
    const dir = await writeTree({
      'Dockerfile.prod': 'FROM nginx:1.27\n',
      'docker-compose.override.yml': 'services:\n  web:\n    image: nginx:1.27\n',
    });

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan!)).toEqual(['library/nginx:1.27']);
  });

  it('scans each directory that has a manifest and orders projects by path', async () => {
    const dir = await writeTree({
      'services/api/Dockerfile.prod': 'FROM node:20\n',
      'Containerfile': 'FROM alpine:3.20\n',
      'deploy/compose.override.yaml': 'services:\n  db:\n    image: postgres:16\n',
    });

    const cache = new FileCache();
    const projects = await scanDockerProjects(dir, undefined, cache, undefined, true);
    const uncached = await scanDockerProjects(dir, undefined, undefined, undefined, true);

    const shape = (rows: typeof projects) =>
      rows.map((project) => ({
        path: project.path,
        images: project.dependencies.map((row) => `${row.package}:${row.currentSpec}`),
      }));

    const expected = [
      { path: '.', images: ['library/alpine:3.20'] },
      { path: 'deploy', images: ['library/postgres:16'] },
      { path: 'services/api', images: ['library/node:20'] },
    ];
    expect(shape(projects)).toEqual(expected);
    expect(shape(uncached)).toEqual(expected);
  });
});
