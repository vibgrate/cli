import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanHelm } from '../src/core-open/scanners/helm-scanner.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-helm-test-'));
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeChart(chart: string, lock?: string): Promise<string> {
  const dir = await createTempDir();
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'Chart.yaml'), chart);
  if (lock !== undefined) {
    await fs.writeFile(path.join(dir, 'Chart.lock'), lock);
  }
  return dir;
}

describe('scanHelm dependency bounds', () => {
  it('does not treat maintainers after dependencies as chart dependencies', async () => {
    const dir = await writeChart(`apiVersion: v2
appVersion: "2.0.0"
dependencies:
  - name: redis
    version: "20.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
description: A demo chart
maintainers:
  - name: Jane Doe
    email: jane@example.com
    url: https://example.com
name: demo
version: 1.4.2
`);

    const manifest: PackageVersionManifest = {
      helm: {
        'https://charts.bitnami.com/bitnami/redis': { latest: '21.0.0' },
        'Jane Doe': { latest: '9.9.9' },
        redis: { latest: '1.0.0' },
      },
    };

    const scan = await scanHelm(dir, undefined, manifest, true);
    expect(scan).not.toBeNull();
    expect(scan!.name).toBe('demo');
    expect(scan!.runtime).toBe('2.0.0');
    expect(scan!.dependencies).toHaveLength(1);
    expect(scan!.dependencies[0]).toMatchObject({
      package: 'redis',
      section: 'dependencies',
      currentSpec: '20.x.x',
      resolvedVersion: null,
      latestStable: '21.0.0',
    });
  });

  it('does not inherit the chart version when a dependency has none of its own', async () => {
    const dir = await writeChart(`name: demo
dependencies:
  - name: redis
    version: 20.x.x
    repository: https://charts.example.com
  - name: postgresql
    repository: https://charts.example.com
version: 1.4.2
`);

    const scan = await scanHelm(dir, undefined, undefined, true);
    expect(scan!.dependencies.map((d) => ({
      package: d.package,
      currentSpec: d.currentSpec,
    }))).toEqual([
      { package: 'redis', currentSpec: '20.x.x' },
      { package: 'postgresql', currentSpec: '*' },
    ]);
    expect(scan!.dependencies.some((d) => d.currentSpec === '1.4.2' || d.package === '1.4.2')).toBe(false);
  });

  it('bounds Chart.lock to the dependencies section', async () => {
    const dir = await writeChart(
      `name: demo
dependencies:
  - name: redis
    version: 20.x.x
    repository: https://charts.bitnami.com/bitnami
  - name: postgresql
    repository: https://charts.bitnami.com/bitnami
maintainers:
  - name: Jane Doe
version: 1.4.2
`,
      `dependencies:
- name: redis
  repository: https://charts.bitnami.com/bitnami
  version: 20.11.3
- name: postgresql
  repository: https://charts.bitnami.com/bitnami
digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
generated: "2024-01-15T00:00:00.000000000Z"
maintainers:
- name: Jane Doe
  email: jane@example.com
version: 1.4.2
`,
    );

    const scan = await scanHelm(dir, undefined, undefined, true);
    expect(scan!.dependencies.map((d) => ({
      package: d.package,
      currentSpec: d.currentSpec,
      resolvedVersion: d.resolvedVersion,
    }))).toEqual([
      { package: 'redis', currentSpec: '20.x.x', resolvedVersion: '20.11.3' },
      { package: 'postgresql', currentSpec: '*', resolvedVersion: null },
    ]);
  });
});
