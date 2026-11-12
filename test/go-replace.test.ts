import { afterEach, describe, expect, it } from 'vitest';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { DependencyRow, ProjectScan } from '../src/core-open/types.js';
import { cleanup, makeProject } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(goMod: string): string {
  const dir = makeProject({ 'go.mod': goMod });
  dirs.push(dir);
  return dir;
}

/** Live proxy stand-in. Every lookup is recorded; nothing leaves the process. */
function recordingCache(): { cache: GoCache; fetched: string[] } {
  const fetched: string[] = [];
  const cache = new GoCache(new Semaphore(1), undefined, false, {
    cacheDir: null,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      return new Response('v9.9.9\n', { status: 200 });
    }) as typeof fetch,
  });
  return { cache, fetched };
}

function fetchedModule(urls: string[], modulePath: string): boolean {
  const encoded = encodeURIComponent(modulePath);
  return urls.some((url) => url.includes(`/${encoded}/@v/list`) || url.includes(`/${modulePath}/@v/list`));
}

async function scan(goMod: string): Promise<{ project: ProjectScan; fetched: string[] }> {
  const { cache, fetched } = recordingCache();
  const [scanned] = await scanGoProjects(project(goMod), cache);
  return { project: scanned!, fetched };
}

function byPackage(project: ProjectScan): Map<string, DependencyRow> {
  return new Map(project.dependencies.map((dep) => [dep.package, dep]));
}

describe('go.mod replace directives', () => {
  it('reports a single-line fork replace that appears before its require', async () => {
    const goMod = [
      'module example.com/demo',
      '',
      'go 1.22',
      '',
      'replace github.com/upstream/thing => github.com/our-fork/thing v0.9.3',
      '',
      'require (',
      '\tgithub.com/upstream/thing v0.9.0',
      '\tgithub.com/example/kept v1.2.3',
      ')',
      '',
      'replace example.com/unused => example.com/fork-only v1.2.3',
      '',
    ].join('\n');

    const { cache, fetched } = recordingCache();
    const root = project(goMod);
    const [first] = await scanGoProjects(root, cache);
    const [second] = await scanGoProjects(root, cache);
    expect(first!.dependencies).toEqual(second!.dependencies);
    expect(first!.dependencyAgeBuckets).toEqual(second!.dependencyAgeBuckets);

    const rows = byPackage(first!);
    expect([...rows.keys()].sort()).toEqual(['github.com/example/kept', 'github.com/our-fork/thing']);
    expect(rows.has('github.com/upstream/thing')).toBe(false);
    expect(rows.has('example.com/fork-only')).toBe(false);
    expect(rows.has('example.com/unused')).toBe(false);

    const fork = rows.get('github.com/our-fork/thing')!;
    expect(fork.currentSpec).toBe('v0.9.3');
    expect(fork.resolvedVersion).toBe('0.9.3');
    expect(fork.replacedFrom).toBe('github.com/upstream/thing');
    expect(fork.drift).toBe('major-behind');
    expect(fork.latestStable).toBe('9.9.9');

    const kept = rows.get('github.com/example/kept')!;
    expect(kept.currentSpec).toBe('v1.2.3');
    expect(kept.resolvedVersion).toBe('1.2.3');
    expect(kept.replacedFrom).toBeUndefined();
    expect(kept.drift).toBe('major-behind');

    expect(fetchedModule(fetched, 'github.com/our-fork/thing')).toBe(true);
    expect(fetchedModule(fetched, 'github.com/example/kept')).toBe(true);
    expect(fetchedModule(fetched, 'github.com/upstream/thing')).toBe(false);
    expect(fetchedModule(fetched, 'example.com/unused')).toBe(false);
    expect(fetchedModule(fetched, 'example.com/fork-only')).toBe(false);
    expect(first!.projectReferences).toBeUndefined();
  });

  it('applies a replace block, including a version-scoped left side', async () => {
    const goMod = [
      'module example.com/demo',
      '',
      'go 1.22',
      '',
      'require github.com/example/lib v1.2.0',
      'require github.com/example/scoped v1.4.0',
      'require github.com/example/unmatched v2.0.0',
      'require github.com/example/kept v1.2.3',
      '',
      'replace (',
      '\tgithub.com/example/lib v1.2.0 => github.com/our-fork/lib v1.2.1',
      '\tgithub.com/example/lib => ../local',
      '\tgithub.com/example/scoped v1.4.0 => github.com/our-fork/scoped v3.0.0',
      '\tgithub.com/example/unmatched v9.9.9 => github.com/our-fork/unmatched v9.9.9',
      ')',
      '',
    ].join('\n');

    const { project, fetched } = await scan(goMod);
    const rows = byPackage(project);

    const fork = rows.get('github.com/our-fork/lib')!;
    expect(fork.currentSpec).toBe('v1.2.1');
    expect(fork.resolvedVersion).toBe('1.2.1');
    expect(fork.replacedFrom).toBe('github.com/example/lib');
    expect(rows.has('github.com/example/lib')).toBe(false);
    expect(fetchedModule(fetched, 'github.com/our-fork/lib')).toBe(true);
    expect(fetchedModule(fetched, 'github.com/example/lib')).toBe(false);

    const scoped = rows.get('github.com/our-fork/scoped')!;
    expect(scoped.currentSpec).toBe('v3.0.0');
    expect(scoped.resolvedVersion).toBe('3.0.0');
    expect(scoped.replacedFrom).toBe('github.com/example/scoped');
    expect(scoped.drift).toBe('major-behind');
    expect(scoped.majorsBehind).toBe(6);

    const unmatched = rows.get('github.com/example/unmatched')!;
    expect(unmatched.currentSpec).toBe('v2.0.0');
    expect(unmatched.resolvedVersion).toBe('2.0.0');
    expect(unmatched.replacedFrom).toBeUndefined();
    expect(fetchedModule(fetched, 'github.com/example/unmatched')).toBe(true);
    expect(fetchedModule(fetched, 'github.com/our-fork/unmatched')).toBe(false);

    const kept = rows.get('github.com/example/kept')!;
    expect(kept.currentSpec).toBe('v1.2.3');
    expect(kept.resolvedVersion).toBe('1.2.3');
    expect(kept.replacedFrom).toBeUndefined();
    expect(fetchedModule(fetched, 'github.com/example/kept')).toBe(true);
  });

  it('keeps a local-path replace and does not look it up', async () => {
    const goMod = [
      'module example.com/demo',
      '',
      'go 1.22',
      '',
      'require (',
      '\tgithub.com/example/parent v1.2.0',
      '\tgithub.com/example/dot v1.3.0',
      '\tgithub.com/example/abs v1.4.0',
      '\tgithub.com/example/win v1.6.0',
      '\tgithub.com/example/quoted v1.5.0',
      '\tgithub.com/example/kept v1.2.3',
      ')',
      '',
      'replace github.com/example/parent => ../lib',
      'replace github.com/example/dot v1.3.0 => ./lib',
      'replace github.com/example/abs => /opt/vendor/abs',
      'replace github.com/example/win v1.6.0 => C:/src/win',
      'replace github.com/example/quoted v1.5.0 => "../My Lib"',
      'replace github.com/example/dot v9.9.9 => github.com/our-fork/dot v9.9.9',
      '',
    ].join('\n');

    const { project, fetched } = await scan(goMod);
    const rows = byPackage(project);
    const local = [
      'github.com/example/parent',
      'github.com/example/dot',
      'github.com/example/abs',
      'github.com/example/win',
      'github.com/example/quoted',
    ];

    expect([...rows.keys()].sort()).toEqual([...local, 'github.com/example/kept'].sort());

    for (const name of local) {
      const row = rows.get(name)!;
      expect(row.replacedFrom).toBeUndefined();
      expect(row.drift).toBe('unknown');
      expect(row.majorsBehind).toBeNull();
      expect(row.latestStable).toBeNull();
      expect(row.resolvedVersion).not.toBeNull();
      expect(fetchedModule(fetched, name)).toBe(false);
    }

    expect(rows.get('github.com/example/parent')!.currentSpec).toBe('v1.2.0');
    expect(rows.get('github.com/example/dot')!.currentSpec).toBe('v1.3.0');
    expect(rows.get('github.com/example/abs')!.resolvedVersion).toBe('1.4.0');
    expect(rows.get('github.com/example/win')!.resolvedVersion).toBe('1.6.0');
    expect(rows.get('github.com/example/quoted')!.resolvedVersion).toBe('1.5.0');

    const kept = rows.get('github.com/example/kept')!;
    expect(kept.drift).toBe('major-behind');
    expect(kept.majorsBehind).toBe(8);
    expect(fetchedModule(fetched, 'github.com/example/kept')).toBe(true);

    expect(project.dependencyAgeBuckets).toEqual({
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 1,
      unknown: local.length,
    });
    expect(fetchedModule(fetched, 'github.com/our-fork/dot')).toBe(false);
    expect(project.projectReferences).toBeUndefined();
  });

  it('lets a version-scoped module replace win over a later local wildcard', async () => {
    const goMod = [
      'module example.com/demo',
      '',
      'go 1.22',
      '',
      'replace github.com/example/lib v1.2.0 => github.com/our-fork/lib v1.2.1',
      'replace github.com/example/lib => ../local',
      '',
      'require github.com/example/lib v1.2.0',
      '',
    ].join('\n');

    const { project, fetched } = await scan(goMod);
    const row = project.dependencies[0]!;
    expect(project.dependencies).toHaveLength(1);
    expect(row.package).toBe('github.com/our-fork/lib');
    expect(row.currentSpec).toBe('v1.2.1');
    expect(row.resolvedVersion).toBe('1.2.1');
    expect(row.replacedFrom).toBe('github.com/example/lib');
    expect(row.drift).toBe('major-behind');
    expect(fetchedModule(fetched, 'github.com/our-fork/lib')).toBe(true);
    expect(fetchedModule(fetched, 'github.com/example/lib')).toBe(false);
  });
});
