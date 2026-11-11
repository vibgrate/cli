import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const fetchTerraformVersionsBulk = vi.hoisted(() => vi.fn());

vi.mock('../src/core-open/scanners/terraform-cache.js', () => ({
  fetchTerraformVersionsBulk,
}));

import { scanTerraform } from '../src/core-open/scanners/terraform-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';

const LATEST: Record<string, string> = {
  'terraform-aws-modules/vpc/aws': '6.0.0',
  'hashicorp/consul/aws': '0.12.1',
};

const dirs: string[] = [];

beforeEach(() => {
  fetchTerraformVersionsBulk.mockReset();
  fetchTerraformVersionsBulk.mockImplementation(async (items: Array<{
    type: 'provider' | 'module';
    namespace: string;
    name: string;
    provider?: string;
  }>) => {
    const results = new Map<string, string>();
    for (const item of items) {
      if (item.type !== 'module' || !item.provider) continue;
      const key = `${item.namespace}/${item.name}/${item.provider}`;
      const version = LATEST[key];
      if (version) results.set(key, version);
    }
    return results;
  });
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-tf-registry-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return dir;
}

function moduleBlock(name: string, source: string, version: string): string {
  return `module "${name}" {\n  source  = "${source}"\n  version = "${version}"\n}\n`;
}

function moduleItems(): Array<{ type: string; namespace: string; name: string; provider?: string }> {
  const items = fetchTerraformVersionsBulk.mock.calls[0]?.[0] as Array<{
    type: string;
    namespace: string;
    name: string;
    provider?: string;
  }> | undefined;
  return (items ?? []).filter((item) => item.type === 'module');
}

describe('scanTerraform public registry module lookup', () => {
  it('looks up a //subdir source as the registry package and applies that latest version', async () => {
    const source = 'terraform-aws-modules/vpc/aws//modules/vpc-endpoints';
    const dir = await writeTree({
      'main.tf': moduleBlock('endpoints', source, '5.8.1'),
    });

    const scan = await scanTerraform(dir, new FileCache(), undefined, true);
    expect(moduleItems()).toEqual([
      { type: 'module', namespace: 'terraform-aws-modules', name: 'vpc', provider: 'aws' },
    ]);

    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules).toEqual([
      expect.objectContaining({
        package: `module:${source}`,
        currentSpec: '5.8.1',
        latestStable: '6.0.0',
        drift: 'major-behind',
        majorsBehind: 1,
        resolvedVersion: null,
      }),
    ]);
  });

  it('resolves a registry.terraform.io prefix as the same public module', async () => {
    const dir = await writeTree({
      'prefixed.tf': moduleBlock('consul_host', 'registry.terraform.io/hashicorp/consul/aws', '0.11.0'),
      'bare.tf': moduleBlock('consul', 'hashicorp/consul/aws', '0.11.0'),
    });

    const scan = await scanTerraform(dir, new FileCache(), undefined, true);
    expect(moduleItems()).toEqual([
      { type: 'module', namespace: 'hashicorp', name: 'consul', provider: 'aws' },
    ]);

    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules.map((row) => ({
      package: row.package,
      currentSpec: row.currentSpec,
      latestStable: row.latestStable,
      drift: row.drift,
      majorsBehind: row.majorsBehind,
    }))).toEqual([
      {
        package: 'module:hashicorp/consul/aws',
        currentSpec: '0.11.0',
        latestStable: '0.12.1',
        drift: 'minor-behind',
        majorsBehind: 0,
      },
      {
        package: 'module:registry.terraform.io/hashicorp/consul/aws',
        currentSpec: '0.11.0',
        latestStable: '0.12.1',
        drift: 'minor-behind',
        majorsBehind: 0,
      },
    ]);
  });

  it('does not look up a private-registry host on the public registry', async () => {
    const source = 'app.terraform.io/acme/network/aws';
    const dir = await writeTree({
      'main.tf': moduleBlock('net', source, '2.3.0'),
    });

    const scan = await scanTerraform(dir, new FileCache(), undefined, true);
    expect(moduleItems()).toEqual([]);
    expect(fetchTerraformVersionsBulk).toHaveBeenCalledTimes(1);

    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules).toEqual([
      expect.objectContaining({
        package: `module:${source}`,
        currentSpec: '2.3.0',
        latestStable: null,
        drift: 'unknown',
        majorsBehind: null,
      }),
    ]);
  });

  it('applies one public lookup across subdir, public host, and private host pins', async () => {
    const subdir = 'terraform-aws-modules/vpc/aws//modules/vpc-endpoints';
    const prefixedSubdir = 'registry.terraform.io/terraform-aws-modules/vpc/aws//modules/flow-log';
    const privateSource = 'app.terraform.io/acme/network/aws//modules/vpc';
    const dir = await writeTree({
      'endpoints.tf': moduleBlock('endpoints', subdir, '5.8.1'),
      'flow.tf': moduleBlock('flow', prefixedSubdir, '5.1.0'),
      'consul.tf': moduleBlock('consul', 'registry.terraform.io/hashicorp/consul/aws', '0.11.0'),
      'net.tf': moduleBlock('net', privateSource, '2.3.0'),
    });

    const scan = await scanTerraform(dir, new FileCache(), undefined, true);
    expect(moduleItems()).toEqual([
      { type: 'module', namespace: 'hashicorp', name: 'consul', provider: 'aws' },
      { type: 'module', namespace: 'terraform-aws-modules', name: 'vpc', provider: 'aws' },
    ]);

    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules.map((row) => ({
      package: row.package,
      currentSpec: row.currentSpec,
      latestStable: row.latestStable,
      drift: row.drift,
    }))).toEqual([
      {
        package: `module:${privateSource}`,
        currentSpec: '2.3.0',
        latestStable: null,
        drift: 'unknown',
      },
      {
        package: 'module:registry.terraform.io/hashicorp/consul/aws',
        currentSpec: '0.11.0',
        latestStable: '0.12.1',
        drift: 'minor-behind',
      },
      {
        package: `module:${prefixedSubdir}`,
        currentSpec: '5.1.0',
        latestStable: '6.0.0',
        drift: 'major-behind',
      },
      {
        package: `module:${subdir}`,
        currentSpec: '5.8.1',
        latestStable: '6.0.0',
        drift: 'major-behind',
      },
    ]);
  });
});
