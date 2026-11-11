import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanTerraform } from '../src/core-open/scanners/terraform-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import type { DependencyRow } from '../src/core-open/types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-tf-modules-json-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return dir;
}

const manifest: PackageVersionManifest = {
  terraform: {
    'terraform-aws-modules/vpc/aws': { latest: '5.8.1' },
  },
};

const vpcConstraint = `module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
}
`;

function modulesJson(modules: Array<Record<string, string>>): string {
  return JSON.stringify({ Modules: modules });
}

function moduleRow(scan: Awaited<ReturnType<typeof scanTerraform>>): DependencyRow {
  const row = scan!.dependencies.find((dep) => dep.package.startsWith('module:'));
  expect(row).toBeDefined();
  return row!;
}

describe('scanTerraform modules.json', () => {
  it('uses the installed registry module version as resolvedVersion', async () => {
    const dir = await writeTree({
      'main.tf': vpcConstraint,
      '.terraform/modules/modules.json': modulesJson([
        { Key: '', Source: '', Dir: '.' },
        {
          Key: 'vpc',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '5.8.1',
          Dir: '.terraform/modules/vpc',
        },
        {
          Key: 'vpc.endpoints',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws//modules/vpc-endpoints',
          Version: '5.8.1',
          Dir: '.terraform/modules/vpc/modules/vpc-endpoints',
        },
      ]),
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    expect(moduleRow(scan)).toMatchObject({
      package: 'module:terraform-aws-modules/vpc/aws',
      currentSpec: '~> 5.0',
      resolvedVersion: '5.8.1',
      latestStable: '5.8.1',
      drift: 'current',
      majorsBehind: 0,
    });
    expect(scan!.dependencyAgeBuckets.current).toBe(1);
  });

  it('matches a public host and a //subdir to the same registry module', async () => {
    const source = 'registry.terraform.io/terraform-aws-modules/vpc/aws//modules/vpc-endpoints';
    const dir = await writeTree({
      'main.tf': `module "endpoints" {
  source  = "${source}"
  version = "~> 5.0"
}
`,
      '.terraform/modules/modules.json': modulesJson([
        {
          Key: 'endpoints',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws//modules/vpc-endpoints',
          Version: '5.8.1',
        },
      ]),
    });

    const scan = await scanTerraform(dir, undefined, manifest, true);
    expect(moduleRow(scan)).toMatchObject({
      package: `module:${source}`,
      currentSpec: '~> 5.0',
      resolvedVersion: '5.8.1',
      drift: 'current',
    });
  });

  it('keeps each call on its own installed version', async () => {
    const dir = await writeTree({
      'main.tf': `${vpcConstraint}
module "old" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 4.0"
}
`,
      '.terraform/modules/modules.json': modulesJson([
        {
          Key: 'vpc',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '5.8.1',
        },
        {
          Key: 'old',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '4.2.0',
        },
        {
          Key: 'old.nested',
          Source: 'git::https://example.com/nested.git',
          Version: '9.9.9',
        },
      ]),
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    const modules = scan!.dependencies.filter((row) => row.package.startsWith('module:'));
    expect(modules.map((row) => ({
      currentSpec: row.currentSpec,
      resolvedVersion: row.resolvedVersion,
      drift: row.drift,
    }))).toEqual([
      { currentSpec: '~> 4.0', resolvedVersion: '4.2.0', drift: 'major-behind' },
      { currentSpec: '~> 5.0', resolvedVersion: '5.8.1', drift: 'current' },
    ]);
  });

  it('does not take a version from a different call or a non-registry source', async () => {
    const dir = await writeTree({
      'main.tf': vpcConstraint,
      '.terraform/modules/modules.json': modulesJson([
        {
          Key: 'vpc',
          Source: 'git::https://example.com/vpc.git',
          Version: '1.2.3',
        },
        {
          Key: 'other',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '5.8.1',
        },
        {
          Key: 'vpc.child',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '5.1.0',
        },
      ]),
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    expect(moduleRow(scan)).toMatchObject({
      currentSpec: '~> 5.0',
      resolvedVersion: null,
      latestStable: '5.8.1',
      drift: 'minor-behind',
      majorsBehind: 0,
    });
  });

  it('leaves output unchanged when modules.json is absent', async () => {
    const dir = await writeTree({ 'main.tf': vpcConstraint });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    expect(scan!.dependencies).toEqual([
      {
        package: 'module:terraform-aws-modules/vpc/aws',
        section: 'dependencies',
        currentSpec: '~> 5.0',
        resolvedVersion: null,
        latestStable: '5.8.1',
        majorsBehind: 0,
        drift: 'minor-behind',
      },
    ]);
    expect(scan!.dependencyAgeBuckets).toEqual({
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 0,
      unknown: 1,
    });
  });

  it('ignores malformed modules.json', async () => {
    const dir = await writeTree({
      'main.tf': vpcConstraint,
      '.terraform/modules/modules.json': '{ Modules: [',
    });

    const scan = await scanTerraform(dir, new FileCache(), manifest, true);
    expect(moduleRow(scan)).toMatchObject({
      package: 'module:terraform-aws-modules/vpc/aws',
      currentSpec: '~> 5.0',
      resolvedVersion: null,
      latestStable: '5.8.1',
      drift: 'minor-behind',
      majorsBehind: 0,
    });
  });

  it('ignores modules.json that is not the manifest shape', async () => {
    const dir = await writeTree({
      'main.tf': vpcConstraint,
      '.terraform/modules/modules.json': JSON.stringify({ Modules: { Version: '5.8.1' } }),
    });

    const scan = await scanTerraform(dir, undefined, manifest, true);
    expect(moduleRow(scan).resolvedVersion).toBeNull();
    expect(moduleRow(scan).drift).toBe('minor-behind');
  });
});
