import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// scanDocker hands every row name to fetchDockerVersionsBulk, which is the
// Docker Hub lookup. Recording the refs shows exactly which names would have
// been resolved against Docker Hub.
const hub = vi.hoisted(() => {
  const calls: string[][] = [];
  const fn = vi.fn(async (imageRefs: string[]) => {
    calls.push([...imageRefs]);
    const latest: Record<string, string> = {
      'library/nginx': '1.27.0',
      'bitnami/redis': '7.4.1',
    };
    const results = new Map<string, string>();
    for (const ref of imageRefs) {
      const version = latest[ref];
      if (version) results.set(ref, version);
    }
    return results;
  });
  return { calls, fn };
});

vi.mock('../src/core-open/scanners/docker-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core-open/scanners/docker-cache.js')>();
  return { ...actual, fetchDockerVersionsBulk: hub.fn };
});

import { scanDocker } from '../src/core-open/scanners/docker-scanner.js';

async function writeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-docker-registry-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe('scanDocker keeps the registry host in row names', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    hub.calls.length = 0;
    hub.fn.mockClear();
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('keeps ghcr.io, mcr.microsoft.com and quay.io in a Dockerfile', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'FROM ghcr.io/acme/api:1.4.0',
        'FROM mcr.microsoft.com/dotnet/sdk:8.0',
        'FROM quay.io/prometheus/node-exporter:v1.8.0',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies.map((row) => row.package)).toEqual([
      'ghcr.io/acme/api',
      'mcr.microsoft.com/dotnet/sdk',
      'quay.io/prometheus/node-exporter',
    ]);
    expect(scan!.dependencies.every((row) => row.drift === 'unknown')).toBe(true);

    // None of the three may be looked up on Docker Hub under its bare path.
    const asked = hub.calls.flat();
    expect(asked).not.toContain('acme/api');
    expect(asked).not.toContain('dotnet/sdk');
    expect(asked).not.toContain('prometheus/node-exporter');
  });

  it('keeps the registry in docker-compose image references', async () => {
    const dir = await writeProject({
      'docker-compose.yml': [
        'services:',
        '  api:',
        '    image: ghcr.io/acme/api:1.4.0',
        '  metrics:',
        '    image: quay.io/prometheus/node-exporter:v1.8.0',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies.map((row) => row.package)).toEqual([
      'ghcr.io/acme/api',
      'quay.io/prometheus/node-exporter',
    ]);
    expect(scan!.dependencies.every((row) => row.drift === 'unknown')).toBe(true);
  });

  it('keeps Docker Hub names exactly as before', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM nginx:1.27.0\nFROM bitnami/redis:7.4.1\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies.map((row) => row.package)).toEqual([
      'bitnami/redis',
      'library/nginx',
    ]);
    expect(hub.calls[0]).toEqual(['bitnami/redis', 'library/nginx']);
    expect(scan!.dependencies.map((row) => row.drift)).toEqual(['current', 'current']);
  });

  it('drops Docker Hub aliases from the row name', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM docker.io/library/nginx:1.27.0\nFROM index.docker.io/bitnami/redis:7.4.1\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies.map((row) => row.package)).toEqual([
      'bitnami/redis',
      'library/nginx',
    ]);
    expect(hub.calls[0]).toEqual(['bitnami/redis', 'library/nginx']);
  });

  it('keeps the same path on two registries as two rows', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM ghcr.io/acme/api:1.4.0\nFROM quay.io/acme/api:1.4.0\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies.map((row) => row.package)).toEqual([
      'ghcr.io/acme/api',
      'quay.io/acme/api',
    ]);
  });

  it('keeps a registry port', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM localhost:5000/team/app:1.2.3\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(scan!.dependencies[0]).toMatchObject({
      package: 'localhost:5000/team/app',
      currentSpec: '1.2.3',
      drift: 'unknown',
    });
  });
});
