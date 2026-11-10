import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyTerraformModuleSource,
  extractTerraformRequirements,
  scanTerraform,
  type TerraformModuleSourceKind,
} from '../src/core-open/scanners/terraform-scanner.js';

const SOURCE_KINDS: ReadonlyArray<readonly [string, TerraformModuleSourceKind]> = [
  ['hashicorp/consul/aws', 'registry'],
  ['registry.terraform.io/hashicorp/consul/aws', 'registry'],
  ['app.terraform.io/example_corp/vpc/aws', 'registry'],
  ['terraform-aws-modules/vpc/aws', 'registry'],
  ['hashicorp/consul/aws//modules/consul-cluster', 'registry'],
  ['./modules/vpc', 'local'],
  ['../modules/vpc', 'local'],
  ['.\\modules\\vpc', 'local'],
  ['github.com/acme/terraform-modules//vpc?ref=v1.2.0', 'git'],
  ['git@github.com:acme/modules.git', 'git'],
  ['git::https://example.com/x.git', 'git'],
  ['bitbucket.org/acme/modules', 'git'],
  ['https://example.com/vpc-module.zip', 'http'],
  ['s3::https://s3-eu-west-1.amazonaws.com/examplecorp-terraform-modules/vpc.zip', 's3'],
  ['gcs::https://www.googleapis.com/storage/v1/modules/foomodule.zip', 'gcs'],
  ['hg::https://example.com/vpc.hg', 'mercurial'],
  ['modules/not-a-registry', 'remote'],
];

const NON_REGISTRY_SOURCES = [
  'github.com/acme/terraform-modules//vpc?ref=v1.2.0',
  'git@github.com:acme/modules.git',
  'bitbucket.org/acme/modules',
  'https://example.com/vpc-module.zip',
  's3::https://s3-eu-west-1.amazonaws.com/examplecorp-terraform-modules/vpc.zip',
  'gcs::https://www.googleapis.com/storage/v1/modules/foomodule.zip',
  'hg::https://example.com/vpc.hg',
  './modules/vpc',
  'git::https://example.com/x.git',
];

describe('classifyTerraformModuleSource', () => {
  it.each(SOURCE_KINDS)('%j is %s', (source, kind) => {
    expect(classifyTerraformModuleSource(source)).toBe(kind);
  });
});

describe('extractTerraformRequirements module sources', () => {
  it('keeps registry addresses and drops every non-registry source', () => {
    const blocks = [
      'module "consul" { source = "hashicorp/consul/aws" version = "0.11.0" }',
      'module "prefixed" { source = "registry.terraform.io/hashicorp/consul/aws" version = "0.11.0" }',
      ...NON_REGISTRY_SOURCES.map((source, index) =>
        `module "skip_${index}" { source = ${JSON.stringify(source)} version = "9.9.9" }`),
    ];
    const { modules } = extractTerraformRequirements(blocks.join('\n'));
    expect(modules).toEqual([
      { source: 'hashicorp/consul/aws', version: '0.11.0' },
      { source: 'registry.terraform.io/hashicorp/consul/aws', version: '0.11.0' },
    ]);
  });
});

describe('scanTerraform module rows', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('emits module: rows only for registry sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-terraform-scan-'));
    dirs.push(dir);
    const blocks = [
      'module "consul" { source = "hashicorp/consul/aws" version = "0.11.0" }',
      'module "prefixed" { source = "registry.terraform.io/hashicorp/consul/aws" version = "0.11.0" }',
      ...NON_REGISTRY_SOURCES.map((source, index) =>
        `module "skip_${index}" { source = ${JSON.stringify(source)} }`),
    ];
    await fs.writeFile(path.join(dir, 'main.tf'), `${blocks.join('\n')}\n`);

    const scan = await scanTerraform(dir, undefined, undefined, true);
    const moduleRows = (scan?.dependencies ?? []).filter((row) => row.package.startsWith('module:'));

    expect(moduleRows.map((row) => row.package)).toEqual([
      'module:hashicorp/consul/aws',
      'module:registry.terraform.io/hashicorp/consul/aws',
    ]);
    expect(moduleRows[0]).toMatchObject({ currentSpec: '0.11.0', section: 'dependencies' });
    expect(moduleRows[1]).toMatchObject({ currentSpec: '0.11.0', section: 'dependencies' });
    for (const source of NON_REGISTRY_SOURCES) {
      expect(moduleRows.some((row) => row.package === `module:${source}`)).toBe(false);
    }
  });
});
