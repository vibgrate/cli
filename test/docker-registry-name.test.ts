import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { scanDocker } from '../src/core-open/scanners/docker-scanner.js';

const HUB = 'https://hub.docker.com/v2/repositories';

async function writeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-docker-registry-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

function hubTags(tags: string[]) {
  return {
    ok: true,
    json: async () => ({ results: tags.map((name) => ({ name })) }),
  };
}

describe('scanDocker registry names', () => {
  const dirs: string[] = [];
  let fetched: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    fetched = [];
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  function stubHub(): void {
    fetched = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const href = String(url);
        fetched.push(href);
        if (href === `${HUB}/library/nginx/tags?page_size=100`) return hubTags(['1.27.2', 'latest']);
        if (href === `${HUB}/bitnami/redis/tags?page_size=100`) return hubTags(['7.4.2']);
        return hubTags(['9.9.9']);
      }),
    );
  }

  function rows(scan: NonNullable<Awaited<ReturnType<typeof scanDocker>>>) {
    return scan.dependencies.map((row) => ({
      package: row.package,
      currentSpec: row.currentSpec,
      latestStable: row.latestStable,
      drift: row.drift,
      majorsBehind: row.majorsBehind,
    }));
  }

  // `1.27` and `7.4` are not strict semver, so drift stays unknown. A filled
  // latestStable is the proof the Docker Hub lookup still ran.
  const mixedRows = [
    {
      package: 'bitnami/redis',
      currentSpec: '7.4',
      latestStable: '7.4.2',
      drift: 'unknown',
      majorsBehind: null,
    },
    {
      package: 'ghcr.io/acme/api',
      currentSpec: '1.4.0',
      latestStable: null,
      drift: 'unknown',
      majorsBehind: null,
    },
    {
      package: 'library/nginx',
      currentSpec: '1.27',
      latestStable: '1.27.2',
      drift: 'unknown',
      majorsBehind: null,
    },
    {
      package: 'mcr.microsoft.com/dotnet/sdk',
      currentSpec: '8.0',
      latestStable: null,
      drift: 'unknown',
      majorsBehind: null,
    },
    {
      package: 'quay.io/prometheus/node-exporter',
      currentSpec: 'v1.8.0',
      latestStable: null,
      drift: 'unknown',
      majorsBehind: null,
    },
  ];

  it('keeps non-Hub registries in Dockerfile rows and does not ask Docker Hub', async () => {
    stubHub();
    const dir = await writeProject({
      Dockerfile: [
        'FROM nginx:1.27',
        'FROM --platform=linux/amd64 ghcr.io/acme/api:1.4.0',
        'FROM mcr.microsoft.com/dotnet/sdk:8.0',
        'FROM quay.io/prometheus/node-exporter:v1.8.0',
        'FROM bitnami/redis:7.4',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(rows(scan!)).toEqual(mixedRows);
    expect(fetched.slice().sort()).toEqual([
      `${HUB}/bitnami/redis/tags?page_size=100`,
      `${HUB}/library/nginx/tags?page_size=100`,
    ]);
  });

  it('keeps non-Hub registries in Compose rows and does not ask Docker Hub', async () => {
    stubHub();
    const dir = await writeProject({
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    image: nginx:1.27',
        '  api:',
        '    image: ghcr.io/acme/api:1.4.0',
        '  sdk:',
        '    image: "mcr.microsoft.com/dotnet/sdk:8.0"',
        '  exporter:',
        '    image: quay.io/prometheus/node-exporter:v1.8.0',
        '  cache:',
        '    image: bitnami/redis:7.4',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(rows(scan!)).toEqual(mixedRows);
    expect(fetched.slice().sort()).toEqual([
      `${HUB}/bitnami/redis/tags?page_size=100`,
      `${HUB}/library/nginx/tags?page_size=100`,
    ]);
  });

  it('records Docker Hub aliases as library/<image> or <namespace>/<image>', async () => {
    stubHub();
    const dir = await writeProject({
      Dockerfile: [
        'FROM Docker.IO/library/nginx:1.27',
        'FROM index.docker.io/bitnami/redis:7.4',
        'FROM registry-1.docker.io/nginx:1.27',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir);
    expect(rows(scan!)).toEqual([
      mixedRows[0],
      mixedRows[2],
    ]);
    expect(fetched.slice().sort()).toEqual([
      `${HUB}/bitnami/redis/tags?page_size=100`,
      `${HUB}/library/nginx/tags?page_size=100`,
    ]);
  });

  it('uses a manifest entry for a non-Hub name and ignores the Hub name', async () => {
    stubHub();
    const dir = await writeProject({
      Dockerfile: [
        'FROM ghcr.io/acme/api:1.4.0',
        'FROM nginx:1.27',
        'FROM bitnami/redis:7.4',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const manifest: PackageVersionManifest = {
      docker: {
        'acme/api': { latest: '9.9.9' },
        'ghcr.io/acme/api': { latest: '1.5.0' },
        'library/nginx': { latest: '1.28.0' },
      },
    };

    const scan = await scanDocker(dir, undefined, manifest, false);
    expect(rows(scan!)).toEqual([
      mixedRows[0],
      {
        package: 'ghcr.io/acme/api',
        currentSpec: '1.4.0',
        latestStable: '1.5.0',
        drift: 'minor-behind',
        majorsBehind: 0,
      },
      {
        package: 'library/nginx',
        currentSpec: '1.27',
        latestStable: '1.28.0',
        drift: 'unknown',
        majorsBehind: null,
      },
    ]);
    expect(fetched).toEqual([`${HUB}/bitnami/redis/tags?page_size=100`]);
  });
});
