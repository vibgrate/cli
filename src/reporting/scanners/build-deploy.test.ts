import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanBuildDeploy } from './build-deploy.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-builddeploy-test-'));
}

describe('scanBuildDeploy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty result for empty directory', async () => {
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toEqual([]);
    expect(result.ciWorkflowCount).toBe(0);
    expect(result.docker.dockerfileCount).toBe(0);
    expect(result.docker.baseImages).toEqual([]);
    expect(result.iac).toEqual([]);
    expect(result.releaseTooling).toEqual([]);
    expect(result.packageManagers).toEqual([]);
    expect(result.monorepoTools).toEqual([]);
  });

  // ── CI detection ──

  it('detects GitHub Actions', async () => {
    const workflowDir = path.join(tempDir, '.github', 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'ci.yml'), 'name: CI');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('github-actions');
  });

  it('counts GitHub Actions workflow files', async () => {
    const workflowDir = path.join(tempDir, '.github', 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'ci.yml'), 'name: CI');
    await fs.writeFile(path.join(workflowDir, 'deploy.yml'), 'name: Deploy');
    await fs.writeFile(path.join(workflowDir, 'release.yaml'), 'name: Release');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ciWorkflowCount).toBe(3);
  });

  it('detects GitLab CI', async () => {
    await fs.writeFile(path.join(tempDir, '.gitlab-ci.yml'), 'stages: [build]');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('gitlab-ci');
  });

  it('detects Azure DevOps', async () => {
    await fs.writeFile(path.join(tempDir, 'azure-pipelines.yml'), 'trigger: [main]');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('azure-devops');
  });

  it('detects Bitbucket Pipelines', async () => {
    await fs.writeFile(path.join(tempDir, 'bitbucket-pipelines.yml'), 'pipelines:');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('bitbucket-pipelines');
  });

  it('detects Jenkins', async () => {
    await fs.writeFile(path.join(tempDir, 'Jenkinsfile'), 'pipeline {}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('jenkins');
  });

  it('detects CircleCI', async () => {
    const circleDir = path.join(tempDir, '.circleci');
    await fs.mkdir(circleDir, { recursive: true });
    await fs.writeFile(path.join(circleDir, 'config.yml'), 'version: 2.1');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('circleci');
  });

  it('detects multiple CI systems simultaneously', async () => {
    const workflowDir = path.join(tempDir, '.github', 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'ci.yml'), 'name: CI');
    await fs.writeFile(path.join(tempDir, '.gitlab-ci.yml'), 'stages:');
    const result = await scanBuildDeploy(tempDir);
    expect(result.ci).toContain('github-actions');
    expect(result.ci).toContain('gitlab-ci');
  });

  // ── Docker ──

  it('detects Dockerfiles', async () => {
    await fs.writeFile(path.join(tempDir, 'Dockerfile'), 'FROM node:20\nRUN echo hi');
    const result = await scanBuildDeploy(tempDir);
    expect(result.docker.dockerfileCount).toBe(1);
    expect(result.docker.baseImages).toContain('node:20');
  });

  it('detects multiple Dockerfiles with different base images', async () => {
    await fs.writeFile(path.join(tempDir, 'Dockerfile'), 'FROM node:20-alpine');
    await fs.writeFile(
      path.join(tempDir, 'Dockerfile.api'),
      'FROM mcr.microsoft.com/dotnet/sdk:8.0',
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.docker.dockerfileCount).toBe(2);
    expect(result.docker.baseImages).toContain('node:20-alpine');
    expect(result.docker.baseImages).toContain('mcr.microsoft.com/dotnet/sdk:8.0');
  });

  // ── IaC ──

  it('detects Terraform files', async () => {
    await fs.writeFile(path.join(tempDir, 'main.tf'), 'resource "aws_instance" {}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.iac).toContain('terraform');
  });

  it('detects Bicep files', async () => {
    await fs.writeFile(path.join(tempDir, 'main.bicep'), 'resource storageAccount');
    const result = await scanBuildDeploy(tempDir);
    expect(result.iac).toContain('bicep');
  });

  it('detects Pulumi', async () => {
    await fs.writeFile(path.join(tempDir, 'Pulumi.yaml'), 'name: my-project');
    const result = await scanBuildDeploy(tempDir);
    expect(result.iac).toContain('pulumi');
  });

  it('detects CloudFormation templates', async () => {
    await fs.writeFile(path.join(tempDir, 'stack.cfn.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.iac).toContain('cloudformation');
  });

  // ── Release tooling ──

  it('detects changesets by directory', async () => {
    await fs.mkdir(path.join(tempDir, '.changeset'));
    const result = await scanBuildDeploy(tempDir);
    expect(result.releaseTooling).toContain('changesets');
  });

  it('detects semantic-release by config file', async () => {
    await fs.writeFile(path.join(tempDir, '.releaserc'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.releaseTooling).toContain('semantic-release');
  });

  it('detects release tooling from package.json devDependencies', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ devDependencies: { '@changesets/cli': '^2.0.0' } }),
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.releaseTooling).toContain('@changesets/cli');
  });

  it('detects GitVersion', async () => {
    await fs.writeFile(path.join(tempDir, 'GitVersion.yml'), 'mode: Mainline');
    const result = await scanBuildDeploy(tempDir);
    expect(result.releaseTooling).toContain('gitversion');
  });

  // ── Package managers ──

  it('detects pnpm from lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('pnpm');
  });

  it('detects npm from lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('npm');
  });

  it('detects yarn from lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '# yarn');
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('yarn');
  });

  it('detects multiple package managers', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('pnpm');
    expect(result.packageManagers).toContain('yarn');
  });

  // ── Monorepo tools ──

  it('detects pnpm workspaces', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-workspace.yaml'), 'packages: [pkg/*]');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('pnpm-workspaces');
  });

  it('detects Nx', async () => {
    await fs.writeFile(path.join(tempDir, 'nx.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('nx');
  });

  it('detects Turborepo', async () => {
    await fs.writeFile(path.join(tempDir, 'turbo.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('turbo');
  });

  it('detects Lerna', async () => {
    await fs.writeFile(path.join(tempDir, 'lerna.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('lerna');
  });

  it('detects Rush', async () => {
    await fs.writeFile(path.join(tempDir, 'rush.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('rush');
  });

  it('detects multiple monorepo tools', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-workspace.yaml'), '');
    await fs.writeFile(path.join(tempDir, 'turbo.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('pnpm-workspaces');
    expect(result.monorepoTools).toContain('turbo');
  });

  it('detects npm workspaces from root package.json workspaces field + package-lock.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('npm-workspaces');
    expect(result.packageManagers).toContain('npm');
  });

  it('detects yarn workspaces from root package.json workspaces field + yarn.lock', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '# yarn lockfile v1');
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('yarn-workspaces');
    expect(result.packageManagers).toContain('yarn');
  });

  it('falls back to npm-workspaces when workspaces field present but no lockfile', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: { packages: ['apps/*', 'libs/*'] } }),
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.monorepoTools).toContain('npm-workspaces');
  });

  it('detects package manager from corepack packageManager field (pnpm)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@9.15.4' }),
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('pnpm');
  });

  it('detects package manager from corepack packageManager field (yarn)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'yarn@4.5.3' }),
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('yarn');
  });

  it('detects package manager from corepack packageManager field (bun)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'bun@1.2.0' }),
    );
    const result = await scanBuildDeploy(tempDir);
    expect(result.packageManagers).toContain('bun');
  });
});
