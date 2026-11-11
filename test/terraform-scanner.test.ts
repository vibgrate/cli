import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isTerraformManifest,
  scanTerraform,
  scanTerraformProjects,
} from '../src/core-open/scanners/terraform-scanner.js';
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

function terraformBlock(body: string): string {
  return `terraform {\n${body}\n}\n`;
}

function versionsTofu(): string {
  return `${terraformBlock(`  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }`)}
${moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '5.1.0')}`;
}

function providerFile(localName: string, source: string, version: string, required = '>= 1.5.0'): string {
  return terraformBlock(`  required_version = "${required}"
  required_providers {
    ${localName} = {
      source  = "${source}"
      version = "${version}"
    }
  }`);
}

function rows(scan: Awaited<ReturnType<typeof scanTerraform>>) {
  return (scan?.dependencies ?? []).map((row) => ({
    package: row.package,
    currentSpec: row.currentSpec,
  }));
}

describe('OpenTofu .tofu files', () => {
  it('treats .tf and .tofu as Terraform manifests', () => {
    expect(isTerraformManifest('versions.tf')).toBe(true);
    expect(isTerraformManifest('versions.tofu')).toBe(true);
    expect(isTerraformManifest('main.tf.json')).toBe(false);
    expect(isTerraformManifest('readme.md')).toBe(false);
  });

  it('reports providers, required_version, and modules declared only in versions.tofu', async () => {
    const dir = await writeTree({ 'versions.tofu': versionsTofu() });

    const cached = await scanTerraform(dir, new FileCache(), manifest, true);
    const uncached = await scanTerraform(dir, undefined, manifest, true);

    for (const scan of [cached, uncached]) {
      expect(scan).not.toBeNull();
      expect(scan!.runtime).toBe('>= 1.8.0');
      expect(rows(scan)).toEqual([
        { package: 'provider:hashicorp/aws', currentSpec: '~> 5.0' },
        { package: 'module:terraform-aws-modules/vpc/aws', currentSpec: '5.1.0' },
      ]);
    }
  });

  it('reads terraform.tf and terraform.tofu when there is no file index', async () => {
    const tfDir = await writeTree({
      'terraform.tf': providerFile('google', 'hashicorp/google', '~> 5.0', '>= 1.6.0'),
    });
    const tofuDir = await writeTree({
      'terraform.tofu': providerFile('google', 'hashicorp/google', '~> 6.0', '>= 1.9.0'),
    });

    const fromTf = await scanTerraform(tfDir, undefined, undefined, true);
    const fromTofu = await scanTerraform(tofuDir, undefined, undefined, true);

    expect(fromTf!.runtime).toBe('>= 1.6.0');
    expect(rows(fromTf)).toEqual([
      { package: 'provider:hashicorp/google', currentSpec: '~> 5.0' },
    ]);
    expect(fromTofu!.runtime).toBe('>= 1.9.0');
    expect(rows(fromTofu)).toEqual([
      { package: 'provider:hashicorp/google', currentSpec: '~> 6.0' },
    ]);
  });

  it('reads only main.tofu when main.tf is in the same directory', async () => {
    const files = {
      'main.tf': `${providerFile('aws', 'hashicorp/aws', '~> 4.0', '>= 1.5.0')}
${moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '4.0.2')}`,
      'main.tofu': `${providerFile('azurerm', 'hashicorp/azurerm', '~> 3.0', '>= 1.8.0')}
${moduleBlock('eks', 'terraform-aws-modules/eks/aws', '19.0.0')}`,
    };
    const cachedDir = await writeTree(files);
    const uncachedDir = await writeTree(files);

    const expected = [
      { package: 'provider:hashicorp/azurerm', currentSpec: '~> 3.0' },
      { package: 'module:terraform-aws-modules/eks/aws', currentSpec: '19.0.0' },
    ];

    for (const scan of [
      await scanTerraform(cachedDir, new FileCache(), manifest, true),
      await scanTerraform(uncachedDir, undefined, manifest, true),
    ]) {
      expect(scan!.runtime).toBe('>= 1.8.0');
      expect(rows(scan)).toEqual(expected);
    }
  });

  it('still reads a .tf file whose stem has no .tofu sibling', async () => {
    const dir = await writeTree({
      'main.tf': providerFile('aws', 'hashicorp/aws', '~> 4.0'),
      'main.tofu': providerFile('azurerm', 'hashicorp/azurerm', '~> 3.0', '>= 1.8.0'),
      'variables.tf': providerFile('google', 'hashicorp/google', '~> 5.0'),
    });

    const scan = await scanTerraform(dir, undefined, undefined, true);
    expect(scan!.runtime).toBe('>= 1.8.0');
    expect(rows(scan)).toEqual([
      { package: 'provider:hashicorp/azurerm', currentSpec: '~> 3.0' },
      { package: 'provider:hashicorp/google', currentSpec: '~> 5.0' },
    ]);
  });

  it('does not let a .tofu file in one directory hide a .tf file in another', async () => {
    const dir = await writeTree({
      'envs/prod/main.tf': providerFile('aws', 'hashicorp/aws', '~> 4.0'),
      'envs/staging/main.tofu': providerFile('azurerm', 'hashicorp/azurerm', '~> 3.0', '>= 1.8.0'),
    });

    const scan = await scanTerraform(dir, new FileCache(), undefined, true);
    expect(rows(scan).sort((a, b) => a.package.localeCompare(b.package))).toEqual([
      { package: 'provider:hashicorp/aws', currentSpec: '~> 4.0' },
      { package: 'provider:hashicorp/azurerm', currentSpec: '~> 3.0' },
    ]);
  });

  it('keeps .tf-only rows, including terraform.tf on the no-cache path', async () => {
    const files = {
      'main.tf': providerFile('aws', 'hashicorp/aws', '~> 5.0', '>= 1.5.0'),
      'versions.tf': providerFile('google', 'hashicorp/google', '~> 4.0'),
      'terraform.tf': `${providerFile('azurerm', 'hashicorp/azurerm', '~> 3.0')}
${moduleBlock('vpc', 'terraform-aws-modules/vpc/aws', '5.8.1')}`,
    };
    const cachedDir = await writeTree(files);
    const uncachedDir = await writeTree(files);

    const expected = [
      { package: 'provider:hashicorp/aws', currentSpec: '~> 5.0' },
      { package: 'provider:hashicorp/google', currentSpec: '~> 4.0' },
      { package: 'provider:hashicorp/azurerm', currentSpec: '~> 3.0' },
      { package: 'module:terraform-aws-modules/vpc/aws', currentSpec: '5.8.1' },
    ];

    const uncached = await scanTerraform(uncachedDir, undefined, manifest, true);
    expect(uncached!.runtime).toBe('>= 1.5.0');
    expect(rows(uncached)).toEqual(expected);

    const cached = await scanTerraform(cachedDir, new FileCache(), manifest, true);
    expect(cached!.runtime).toBe('>= 1.5.0');
    expect(rows(cached).sort((a, b) => a.package.localeCompare(b.package))).toEqual(
      [...expected].sort((a, b) => a.package.localeCompare(b.package)),
    );
  });

  it('discovers a project whose only configuration is versions.tofu', async () => {
    const dir = await writeTree({ 'stack/versions.tofu': versionsTofu() });
    const projects = await scanTerraformProjects(dir, manifest, new FileCache(), undefined, true);

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe('stack');
    expect(projects[0].runtime).toBe('>= 1.8.0');
    expect(rows(projects[0])).toEqual([
      { package: 'provider:hashicorp/aws', currentSpec: '~> 5.0' },
      { package: 'module:terraform-aws-modules/vpc/aws', currentSpec: '5.1.0' },
    ]);
  });
});
