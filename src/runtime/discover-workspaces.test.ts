import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { discoverWorkspaceRoots, type DiscoverFs } from './discover-workspaces.js';

/** In-memory fs for pure discovery tests. */
function memFs(files: Record<string, string>, dirs: string[] = []): DiscoverFs {
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  const dirSet = new Set(dirs.map((d) => path.resolve(d)));
  for (const f of fileMap.keys()) {
    let cur = path.dirname(f);
    for (let i = 0; i < 12; i++) {
      dirSet.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return {
    readFile(abs) {
      return fileMap.get(path.resolve(abs)) ?? null;
    },
    readdir(abs) {
      const root = path.resolve(abs);
      const names = new Set<string>();
      for (const d of dirSet) {
        if (path.dirname(d) === root) names.add(path.basename(d));
      }
      for (const f of fileMap.keys()) {
        if (path.dirname(f) === root) names.add(path.basename(f));
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    },
    isDirectory(abs) {
      const p = path.resolve(abs);
      if (dirSet.has(p)) return true;
      // package dirs inferred from package.json parent
      return [...fileMap.keys()].some((f) => path.dirname(f) === p);
    },
    exists(abs) {
      const p = path.resolve(abs);
      return fileMap.has(p) || dirSet.has(p) || [...fileMap.keys()].some((f) => f === p || path.dirname(f) === p);
    },
  };
}

describe('discoverWorkspaceRoots', () => {
  it('always includes the primary root', () => {
    const primary = '/mono/app';
    const fs = memFs({ [`${primary}/package.json`]: '{"name":"app"}' });
    const r = discoverWorkspaceRoots(primary, fs);
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0]?.root).toBe(path.resolve(primary));
    expect(r.roots[0]?.source).toBe('explicit');
  });

  it('expands package.json workspaces globs', () => {
    const primary = '/mono';
    const fs = memFs({
      [`${primary}/package.json`]: JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      }),
      [`${primary}/packages/a/package.json`]: '{"name":"@m/a"}',
      [`${primary}/packages/b/package.json`]: '{"name":"@m/b"}',
    }, [
      `${primary}/packages`,
      `${primary}/packages/a`,
      `${primary}/packages/b`,
    ]);
    const r = discoverWorkspaceRoots(primary, fs);
    const labels = r.roots.map((x) => x.label).sort();
    expect(labels).toEqual(['a', 'b', 'mono']);
    expect(r.roots.filter((x) => x.source === 'package-workspaces')).toHaveLength(2);
  });

  it('expands pnpm-workspace.yaml packages', () => {
    const primary = '/pnpm-mono';
    const fs = memFs({
      [`${primary}/package.json`]: '{"name":"root"}',
      [`${primary}/pnpm-workspace.yaml`]: 'packages:\n  - apps/*\n',
      [`${primary}/apps/web/package.json`]: '{"name":"web"}',
    }, [`${primary}/apps`, `${primary}/apps/web`]);
    const r = discoverWorkspaceRoots(primary, fs);
    expect(r.roots.some((x) => x.root.endsWith(`${path.sep}web`) && x.source === 'pnpm-workspace')).toBe(true);
  });

  it('reads git submodule paths', () => {
    const primary = '/with-sub';
    const fs = memFs({
      [`${primary}/package.json`]: '{"name":"root"}',
      [`${primary}/.gitmodules`]: '[submodule "vendor/lib"]\n\tpath = vendor/lib\n',
      [`${primary}/vendor/lib/package.json`]: '{"name":"lib"}',
    }, [`${primary}/vendor`, `${primary}/vendor/lib`]);
    const r = discoverWorkspaceRoots(primary, fs);
    expect(r.roots.some((x) => x.source === 'git-submodule' && x.root.endsWith(`vendor${path.sep}lib`))).toBe(true);
  });

  it('reads .code-workspace folder list', () => {
    const primary = '/ws';
    const fs = memFs({
      [`${primary}/package.json`]: '{"name":"root"}',
      [`${primary}/multi.code-workspace`]: JSON.stringify({
        folders: [{ path: '.' }, { path: '../other' }],
      }),
    }, ['/other']);
    // other needs package.json to be included as package root from code-workspace... 
    // code-workspace expand doesn't require package.json
    const r = discoverWorkspaceRoots(primary, fs);
    expect(r.roots.some((x) => x.root === path.resolve('/other') && x.source === 'code-workspace')).toBe(true);
  });

  it('does not expand workspace globs into hidden agent worktrees', () => {
    const primary = '/mono';
    const fs = memFs({
      [`${primary}/package.json`]: JSON.stringify({
        name: 'root',
        workspaces: ['*'],
      }),
      [`${primary}/app/package.json`]: '{"name":"app"}',
      [`${primary}/.claude/worktrees/agent/package.json`]: '{"name":"leaked"}',
    }, [
      `${primary}/app`,
      `${primary}/.claude`,
      `${primary}/.claude/worktrees`,
      `${primary}/.claude/worktrees/agent`,
    ]);
    const r = discoverWorkspaceRoots(primary, fs);
    expect(r.roots.map((x) => x.label).sort()).toEqual(['app', 'mono']);
    expect(r.roots.some((x) => x.root.includes('.claude'))).toBe(false);
  });
});
