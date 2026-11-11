import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanTerraform } from '../src/core-open/scanners/terraform-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-tf-scan-'));
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

const manifest: PackageVersionManifest = {
  terraform: {
    'terraform-aws-modules/vpc/aws': { latest: '5.8.1' },
    'terraform-aws-modules/eks/aws': { latest: '20.0.0' },
  },
};

describe('scanTerraform module pins', () => {
  it('keeps each source and version, with drift computed for that pin', async () => {
    // A source-only dedupe keeps whichever version is seen first and drops
    // the other. copy.tf repeats 4.0.2 and must not add a third row. The
    // expected order is source, then version, not filesystem walk order.
    const dir = await writeTree({
      'envs/prod/aaa.tf': moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '5.8.1'),
      'envs/staging/zzz.tf': moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '4.0.2'),
      'envs/staging/copy.tf': moduleBlock('vpc_again', 'terraform-aws-modules/vpc/aws', '4.0.2'),
      'envs/edge/eks.tf': moduleBlock('eks', 'terraform-aws-modules/eks/aws', '19.0.0'),
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    expect(scan).not.toBeNull();

    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules.map((row) => ({
      package: row.package,
      currentSpec: row.currentSpec,
      latestStable: row.latestStable,
      drift: row.drift,
      majorsBehind: row.majorsBehind,
      resolvedVersion: row.resolvedVersion,
    }))).toEqual([
      {
        package: 'module:terraform-aws-modules/eks/aws',
        currentSpec: '19.0.0',
        latestStable: '20.0.0',
        drift: 'major-behind',
        majorsBehind: 1,
        resolvedVersion: null,
      },
      {
        package: 'module:terraform-aws-modules/vpc/aws',
        currentSpec: '4.0.2',
        latestStable: '5.8.1',
        drift: 'major-behind',
        majorsBehind: 1,
        resolvedVersion: null,
      },
      {
        package: 'module:terraform-aws-modules/vpc/aws',
        currentSpec: '5.8.1',
        latestStable: '5.8.1',
        drift: 'current',
        majorsBehind: 0,
        resolvedVersion: null,
      },
    ]);

    expect(scan!.dependencyAgeBuckets).toEqual({
      current: 1,
      oneBehind: 2,
      twoPlusBehind: 0,
      unknown: 0,
    });
  });

  it('collapses a repeated source and version to one row', async () => {
    const dir = await writeTree({
      'envs/staging/main.tf': moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '5.8.1'),
      'envs/prod/main.tf': moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '5.8.1'),
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({
      package: 'module:terraform-aws-modules/vpc/aws',
      currentSpec: '5.8.1',
      drift: 'current',
      majorsBehind: 0,
    });
    expect(scan!.dependencyAgeBuckets.current).toBe(1);
  });
});
