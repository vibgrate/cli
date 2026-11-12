import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { ProjectReference, ProjectScan } from '../src/core-open/types.js';
import { cleanup, makeProject } from './helpers.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-local-modules');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function offlineCache(): GoCache {
  return new GoCache(new Semaphore(1), undefined, true);
}

function byPath(projects: ProjectScan[]): Map<string, ProjectScan> {
  return new Map(projects.map((project) => [project.path, project]));
}

describe('Go project references', () => {
  it('links local replace directories and go.work modules a project requires', async () => {
    const first = byPath(await scanGoProjects(fixtureDir, offlineCache()));
    const second = byPath(await scanGoProjects(fixtureDir, offlineCache()));

    const linked: ProjectReference[] = [
      { path: 'extra', name: 'extra', refType: 'project' },
      { path: 'lib', name: 'lib', refType: 'project' },
      { path: 'shared', name: 'shared', refType: 'project' },
    ];
    expect(first.get('api')!.projectReferences).toEqual(linked);
    expect(second.get('api')!.projectReferences).toEqual(linked);

    // lib is in go.work but does not require another workspace module.
    // shared is required by api only through go.work (no replace).
    // extra is not in go.work; api reaches it only through a local replace.
    // A remote replace, and a local replace whose directory was not scanned,
    // add no reference.
    for (const name of ['lib', 'shared', 'extra']) {
      expect(first.get(name)!.projectReferences).toBeUndefined();
      expect(second.get(name)!.projectReferences).toBeUndefined();
    }

    const remote = first.get('extra')!.dependencies.find((dep) => dep.package === 'github.com/other/remote');
    expect(remote?.replacedFrom).toBe('github.com/example/remote');
    expect(first.get('api')!.dependencies.some((dep) => dep.package === 'github.com/other/remote')).toBe(true);
    expect(first.get('api')!.dependencies.some((dep) => dep.package === 'example.com/lib')).toBe(true);
  });

  it('resolves a quoted replace path and does not link a remote replace', async () => {
    const root = makeProject({
      'app/go.mod': [
        'module example.com/app',
        '',
        'go 1.22',
        '',
        'require example.com/lib v0.1.0',
        'require github.com/example/remote v1.2.3',
        '',
        'replace example.com/lib => "../My Lib"',
        'replace github.com/example/remote => github.com/other/remote v9.9.9',
        '',
      ].join('\n'),
      'My Lib/go.mod': ['module example.com/lib', '', 'go 1.22', ''].join('\n'),
    });
    dirs.push(root);

    const projects = byPath(await scanGoProjects(root, offlineCache()));
    expect(projects.get('app')!.projectReferences).toEqual([
      { path: 'My Lib', name: 'My Lib', refType: 'project' },
    ]);
    expect(projects.get('My Lib')!.projectReferences).toBeUndefined();
    expect(projects.get('app')!.dependencies.map((dep) => dep.package).sort()).toEqual([
      'example.com/lib',
      'github.com/other/remote',
    ]);
  });
});
