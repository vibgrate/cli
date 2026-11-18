import { describe, it, expect, afterEach } from 'vitest';
import { scanNodeProjects } from '../src/core-open/scanners/node-scanner.js';
import { NpmCache } from '../src/core-open/scanners/npm-cache.js';
import { parsePnpmCatalogs, resolvePnpmCatalogSpec, type PnpmCatalogs } from '../src/core-open/scanners/pnpm-catalog.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import type { DependencyRow, ProjectScan } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { makeProject, cleanup } from './helpers.js';

/**
 * pnpm `catalog:` / `catalog:<name>` specifiers (#664). The range lives in
 * the root pnpm-workspace.yaml; the manifest text stays on the row.
 */
const MANIFEST: PackageVersionManifest = {
  npm: {
    react: { latest: '19.0.0', versions: ['17.0.2', '18.3.1', '18.3.5', '19.0.0'] },
    lodash: { latest: '4.17.21', versions: ['4.17.15', '4.17.20', '4.17.21'] },
    'left-pad': { latest: '1.3.0', versions: ['1.2.0', '1.3.0'] },
    debug: { latest: '4.4.0', versions: ['4.3.4', '4.4.0'] },
    'string-width': { latest: '5.1.0', versions: ['4.2.0', '4.2.3', '5.1.0'] },
    chalk: { latest: '5.4.0', versions: ['5.3.0', '5.4.0'] },
    ms: { latest: '2.1.3', versions: ['2.1.3'] },
  },
};

const WORKSPACE = [
  'packages:',
  "  - 'packages/*'",
  'catalog:',
  '  react: ^18.3.1',
  '  left-pad: 1.3.0',
  '  string-width-cjs: npm:string-width@^4.2.0',
  'catalogs:',
  '  legacy:',
  '    lodash: ^4.17.15',
  '    debug: ^4.3.4',
  '',
].join('\n');

// Decoy keys are versions that also satisfy the resolved range. Looking the
// dependency up as the raw `catalog:` text would select the decoy.
const YARN_LOCK = [
  'react@^18.3.1:',
  '  version "18.3.1"',
  '',
  '"react@catalog:":',
  '  version "18.3.5"',
  '',
  'lodash@^4.17.15:',
  '  version "4.17.21"',
  '',
  '"lodash@catalog:legacy":',
  '  version "4.17.20"',
  '',
  'left-pad@1.3.0:',
  '  version "1.3.0"',
  '',
  '"string-width-cjs@npm:string-width@^4.2.0":',
  '  version "4.2.3"',
  '',
  'string-width-cjs@^4.2.0:',
  '  version "4.2.0"',
  '',
  'debug@^4.3.4:',
  '  version "4.3.4"',
  '',
  'chalk@^5.0.0:',
  '  version "5.3.0"',
  '',
].join('\n');

const ROOT_PACKAGE = JSON.stringify({
  name: 'catalog-root',
  version: '1.0.0',
  dependencies: {
    react: 'catalog:',
    lodash: 'catalog:legacy',
    'left-pad': 'catalog:default',
    ms: 'catalog:',
    invariant: 'catalog:nope',
    'string-width-cjs': 'catalog:',
    chalk: '^5.0.0',
  },
  optionalDependencies: {
    debug: 'catalog:legacy',
  },
});

const WEB_PACKAGE = JSON.stringify({
  name: 'web',
  version: '1.0.0',
  dependencies: { react: 'catalog:' },
});

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function scan(files: Record<string, string>): Promise<ProjectScan[]> {
  const root = makeProject(files);
  dirs.push(root);
  return scanNodeProjects(root, new NpmCache(root, new Semaphore(1), MANIFEST, true));
}

function row(project: ProjectScan | undefined, name: string, section?: DependencyRow['section']): DependencyRow {
  const found = project?.dependencies.find((dep) =>
    dep.package === name && (section === undefined || dep.section === section));
  expect(found, `${name}${section ? ` (${section})` : ''}`).toBeDefined();
  return found!;
}

function fingerprint(projects: ProjectScan[]): string {
  const normalized = projects
    .map((project) => ({
      path: project.path,
      dependencies: project.dependencies.map((dep) => ({
        package: dep.package,
        section: dep.section,
        currentSpec: dep.currentSpec,
        resolvedVersion: dep.resolvedVersion,
        latestSatisfying: dep.latestSatisfying ?? null,
        latestStable: dep.latestStable,
        drift: dep.drift,
        registryPackage: dep.registryPackage ?? null,
      })),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(normalized);
}

describe('pnpm catalog: protocol (#664)', () => {
  it('resolves catalog:, catalog:default, and catalog:<name>, and keeps a missing entry', async () => {
    const projects = await scan({
      'pnpm-workspace.yaml': WORKSPACE,
      'package.json': ROOT_PACKAGE,
      'packages/web/package.json': WEB_PACKAGE,
      'yarn.lock': YARN_LOCK,
    });
    const root = projects.find((project) => project.path === '.');
    const web = projects.find((project) => project.path === 'packages/web');

    const react = row(root, 'react');
    expect(react).toMatchObject({
      section: 'dependencies',
      currentSpec: 'catalog:',
      resolvedVersion: '18.3.1',
      latestSatisfying: '18.3.5',
      latestStable: '19.0.0',
      drift: 'major-behind',
    });
    expect(react.registryPackage).toBeUndefined();

    expect(row(root, 'lodash')).toMatchObject({
      currentSpec: 'catalog:legacy',
      resolvedVersion: '4.17.21',
      latestSatisfying: '4.17.21',
      latestStable: '4.17.21',
      drift: 'current',
    });

    expect(row(root, 'left-pad')).toMatchObject({
      currentSpec: 'catalog:default',
      resolvedVersion: '1.3.0',
      latestSatisfying: '1.3.0',
      drift: 'current',
    });

    expect(row(root, 'debug', 'optionalDependencies')).toMatchObject({
      currentSpec: 'catalog:legacy',
      resolvedVersion: '4.3.4',
      latestSatisfying: '4.4.0',
    });

    // The catalog entry is an npm alias. Lockfile lookup uses that alias
    // spec, not the inner range and not the raw `catalog:` text.
    expect(row(root, 'string-width-cjs')).toMatchObject({
      currentSpec: 'catalog:',
      registryPackage: 'string-width',
      resolvedVersion: '4.2.3',
      latestSatisfying: '4.2.3',
      latestStable: '5.1.0',
    });

    expect(row(root, 'chalk')).toMatchObject({
      currentSpec: '^5.0.0',
      resolvedVersion: '5.3.0',
      latestSatisfying: '5.4.0',
    });

    for (const name of ['ms', 'invariant']) {
      const missing = row(root, name);
      expect(missing.currentSpec.startsWith('catalog:')).toBe(true);
      expect(missing.resolvedVersion).toBeNull();
      expect(missing.latestStable).toBeNull();
      expect(missing.latestSatisfying).toBeUndefined();
      expect(missing.drift).toBe('unknown');
      expect(missing.majorsBehind).toBeNull();
    }

    expect(row(web, 'react')).toMatchObject({
      currentSpec: 'catalog:',
      resolvedVersion: '18.3.1',
      latestSatisfying: '18.3.5',
    });
    expect(root?.frameworks).toEqual([
      expect.objectContaining({ name: 'React', currentVersion: '18.3.1', latestVersion: '19.0.0' }),
    ]);
  });

  it('rejects a lockfile version that does not satisfy the resolved catalog range', async () => {
    const projects = await scan({
      'pnpm-workspace.yaml': 'catalog:\n  react: ^18.3.1\n',
      'package.json': JSON.stringify({ name: 'locked', dependencies: { react: 'catalog:' } }),
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      react:',
        "        specifier: 'catalog:'",
        '        version: 17.0.2',
        '',
      ].join('\n'),
    });
    expect(row(projects[0], 'react')).toMatchObject({
      currentSpec: 'catalog:',
      resolvedVersion: '18.3.5',
      latestSatisfying: '18.3.5',
    });
  });

  it('uses catalogs.default when the top-level catalog map is absent', async () => {
    const projects = await scan({
      'pnpm-workspace.yaml': [
        'catalogs:',
        '  default:',
        '    react: ^18.3.1',
        '  legacy:',
        '    react: ^17.0.2',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'named-default',
        dependencies: { react: 'catalog:' },
        devDependencies: { react: 'catalog:legacy' },
      }),
      'yarn.lock': [
        'react@^18.3.1:',
        '  version "18.3.1"',
        '',
        'react@^17.0.2:',
        '  version "17.0.2"',
        '',
      ].join('\n'),
    });
    const project = projects[0];
    expect(row(project, 'react', 'dependencies')).toMatchObject({
      currentSpec: 'catalog:',
      resolvedVersion: '18.3.1',
      latestSatisfying: '18.3.5',
    });
    expect(row(project, 'react', 'devDependencies')).toMatchObject({
      currentSpec: 'catalog:legacy',
      resolvedVersion: '17.0.2',
      latestSatisfying: '17.0.2',
    });
  });

  it('is deterministic across repeated scans', async () => {
    const files = {
      'pnpm-workspace.yaml': WORKSPACE,
      'package.json': ROOT_PACKAGE,
      'packages/web/package.json': WEB_PACKAGE,
      'yarn.lock': YARN_LOCK,
    };
    const first = fingerprint(await scan(files));
    const second = fingerprint(await scan(files));
    expect(second).toBe(first);
  });
});

describe('parsePnpmCatalogs', () => {
  const catalogs: PnpmCatalogs = parsePnpmCatalogs(WORKSPACE);

  it('reads the default catalog and a named catalog', () => {
    expect(resolvePnpmCatalogSpec('react', 'catalog:', catalogs)).toEqual({ kind: 'resolved', spec: '^18.3.1' });
    expect(resolvePnpmCatalogSpec('react', 'catalog:default', catalogs)).toEqual({ kind: 'resolved', spec: '^18.3.1' });
    expect(resolvePnpmCatalogSpec('lodash', 'catalog:legacy', catalogs)).toEqual({ kind: 'resolved', spec: '^4.17.15' });
    expect(resolvePnpmCatalogSpec('ms', 'catalog:', catalogs)).toEqual({ kind: 'missing' });
    expect(resolvePnpmCatalogSpec('react', 'catalog:nope', catalogs)).toEqual({ kind: 'missing' });
    expect(resolvePnpmCatalogSpec('react', '^18.3.1', catalogs)).toEqual({ kind: 'not-catalog' });
  });

  it('lets the top-level catalog map win over catalogs.default', () => {
    const both = parsePnpmCatalogs([
      'catalog:',
      '  react: ^18.3.1',
      'catalogs:',
      '  default:',
      '    react: ^17.0.2',
      '  legacy:',
      '    lodash: ^4.17.15',
      '',
    ].join('\n'));
    expect(resolvePnpmCatalogSpec('react', 'catalog:', both)).toEqual({ kind: 'resolved', spec: '^18.3.1' });
    expect(resolvePnpmCatalogSpec('react', 'catalog:default', both)).toEqual({ kind: 'resolved', spec: '^18.3.1' });
    expect(resolvePnpmCatalogSpec('lodash', 'catalog:legacy', both)).toEqual({ kind: 'resolved', spec: '^4.17.15' });
  });

  it('returns no catalogs for an unreadable document', () => {
    const empty = parsePnpmCatalogs('catalog: [\n');
    expect(resolvePnpmCatalogSpec('react', 'catalog:', empty)).toEqual({ kind: 'missing' });
  });
});
