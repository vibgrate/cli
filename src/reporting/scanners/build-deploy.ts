import * as path from 'node:path';
import { findFiles, findPackageJsonFiles, readJsonFile, readTextFile, pathExists, FileCache } from '../../core-open/index.js';
import type { PackageJson, BuildDeployResult } from '../../core-open/index.js';

/** CI configuration files → system name */
const CI_FILES: Record<string, string> = {
  '.github/workflows': 'github-actions',
  '.gitlab-ci.yml': 'gitlab-ci',
  'azure-pipelines.yml': 'azure-devops',
  'bitbucket-pipelines.yml': 'bitbucket-pipelines',
  'Jenkinsfile': 'jenkins',
  '.circleci/config.yml': 'circleci',
  '.travis.yml': 'travis-ci',
};

/** Release tooling — detected by package name or file existence */
const RELEASE_PACKAGES = new Set([
  'semantic-release', '@changesets/cli', 'standard-version',
  'release-it', 'auto', 'lerna',
]);

const RELEASE_FILES: Record<string, string> = {
  '.changeset': 'changesets',
  '.releaserc': 'semantic-release',
  '.releaserc.json': 'semantic-release',
  '.releaserc.yml': 'semantic-release',
  'release.config.js': 'semantic-release',
  'release.config.cjs': 'semantic-release',
  'GitVersion.yml': 'gitversion',
};

/** Monorepo tool detection */
const MONOREPO_FILES: Record<string, string> = {
  'pnpm-workspace.yaml': 'pnpm-workspaces',
  'lerna.json': 'lerna',
  'nx.json': 'nx',
  'turbo.json': 'turbo',
  'rush.json': 'rush',
};

/** IaC file extensions */
const IAC_EXTENSIONS: Record<string, string> = {
  '.tf': 'terraform',
  '.bicep': 'bicep',
};

export async function scanBuildDeploy(rootDir: string, cache?: FileCache): Promise<BuildDeployResult> {
  const result: BuildDeployResult = {
    ci: [],
    ciWorkflowCount: 0,
    docker: { dockerfileCount: 0, baseImages: [] },
    iac: [],
    releaseTooling: [],
    packageManagers: [],
    monorepoTools: [],
  };

  const _pathExists = cache ? (p: string) => cache.pathExists(p) : pathExists;
  const _findFiles = cache
    ? (dir: string, pred: (name: string) => boolean) => cache.findFiles(dir, pred)
    : findFiles;
  const _readTextFile = cache ? (p: string) => cache.readTextFile(p) : readTextFile;

  // Detect CI systems
  const ciSystems = new Set<string>();
  for (const [file, system] of Object.entries(CI_FILES)) {
    const fullPath = path.join(rootDir, file);
    if (await _pathExists(fullPath)) {
      ciSystems.add(system);
    }
  }

  // Count GitHub Actions workflows
  const ghWorkflowDir = path.join(rootDir, '.github', 'workflows');
  if (await _pathExists(ghWorkflowDir)) {
    try {
      // When using the cache, filter from the root walk instead of triggering
      // a separate sub-walk for .github/workflows
      if (cache) {
        const entries = await cache.walkDir(rootDir);
        const ghPrefix = path.relative(rootDir, ghWorkflowDir) + path.sep;
        result.ciWorkflowCount = entries.filter(
          (e) => e.isFile && e.relPath.startsWith(ghPrefix) &&
            (e.name.endsWith('.yml') || e.name.endsWith('.yaml')),
        ).length;
      } else {
        const files = await _findFiles(ghWorkflowDir, (name) =>
          name.endsWith('.yml') || name.endsWith('.yaml'),
        );
        result.ciWorkflowCount = files.length;
      }
    } catch { /* skip */ }
  }

  result.ci = [...ciSystems].sort();

  // Docker
  const dockerfiles = await _findFiles(rootDir, (name) =>
    name === 'Dockerfile' || name.startsWith('Dockerfile.'),
  );
  result.docker.dockerfileCount = dockerfiles.length;

  const baseImages = new Set<string>();
  for (const df of dockerfiles) {
    try {
      const content = await _readTextFile(df);
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (/^FROM\s+/i.test(trimmed)) {
          const parts = trimmed.split(/\s+/);
          let imageIdx = 1;
          if (parts[1]?.startsWith('--')) {
            imageIdx = parts[1].includes('=') ? 2 : 3;
          }
          if (parts[imageIdx]) {
            baseImages.add(parts[imageIdx]);
          }
        }
      }
    } catch { /* skip */ }
  }
  result.docker.baseImages = [...baseImages].sort();

  // IaC detection
  const iacSystems = new Set<string>();
  for (const [ext, system] of Object.entries(IAC_EXTENSIONS)) {
    const files = await _findFiles(rootDir, (name) => name.endsWith(ext));
    if (files.length > 0) iacSystems.add(system);
  }
  // CloudFormation
  const cfnFiles = await _findFiles(rootDir, (name) =>
    name.endsWith('.cfn.json') || name.endsWith('.cfn.yaml'),
  );
  if (cfnFiles.length > 0) iacSystems.add('cloudformation');
  // Pulumi
  if (await _pathExists(path.join(rootDir, 'Pulumi.yaml'))) iacSystems.add('pulumi');
  result.iac = [...iacSystems].sort();

  // Release tooling
  const releaseTools = new Set<string>();
  // From files
  for (const [file, tool] of Object.entries(RELEASE_FILES)) {
    if (await _pathExists(path.join(rootDir, file))) releaseTools.add(tool);
  }
  // From packages
  const pkgFiles = cache
    ? await cache.findPackageJsonFiles(rootDir)
    : await findPackageJsonFiles(rootDir);
  for (const pjPath of pkgFiles) {
    try {
      const pj = cache
        ? await cache.readJsonFile<PackageJson>(pjPath)
        : await readJsonFile<PackageJson>(pjPath);
      for (const section of ['dependencies', 'devDependencies'] as const) {
        const deps = pj[section];
        if (!deps) continue;
        for (const name of Object.keys(deps)) {
          if (RELEASE_PACKAGES.has(name)) releaseTools.add(name);
        }
      }
    } catch { /* skip */ }
  }
  result.releaseTooling = [...releaseTools].sort();

  // Package managers (by lockfile)
  const lockfileMap: Record<string, string> = {
    'pnpm-lock.yaml': 'pnpm',
    'package-lock.json': 'npm',
    'yarn.lock': 'yarn',
    'bun.lockb': 'bun',
  };
  const managers = new Set<string>();
  for (const [file, manager] of Object.entries(lockfileMap)) {
    if (await _pathExists(path.join(rootDir, file))) managers.add(manager);
  }

  // Read root package.json for corepack `packageManager` field and workspace config
  let rootPkg: PackageJson | null = null;
  const rootPkgPath = path.join(rootDir, 'package.json');
  if (await _pathExists(rootPkgPath)) {
    try {
      rootPkg = cache
        ? await cache.readJsonFile<PackageJson>(rootPkgPath)
        : await readJsonFile<PackageJson>(rootPkgPath);
    } catch { /* ignore unreadable root package.json */ }
  }

  // Corepack `packageManager` field supplements lockfile detection
  // e.g. "packageManager": "pnpm@9.15.4" or "yarn@4.5.3"
  if (rootPkg?.packageManager) {
    const pm = rootPkg.packageManager.split('@')[0]?.toLowerCase();
    if (pm && ['pnpm', 'yarn', 'npm', 'bun'].includes(pm)) {
      managers.add(pm);
    }
  }

  result.packageManagers = [...managers].sort();

  // Monorepo tools
  const monoTools = new Set<string>();
  for (const [file, tool] of Object.entries(MONOREPO_FILES)) {
    if (await _pathExists(path.join(rootDir, file))) monoTools.add(tool);
  }

  // npm/yarn workspaces: detected from `workspaces` field in root package.json
  // pnpm uses pnpm-workspace.yaml (handled above); npm and yarn share the same field
  if (rootPkg?.workspaces) {
    monoTools.add(managers.has('yarn') ? 'yarn-workspaces' : 'npm-workspaces');
  }

  result.monorepoTools = [...monoTools].sort();

  return result;
}
