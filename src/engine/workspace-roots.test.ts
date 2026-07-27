import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathInside, normalizeWorkspaceRoots, selectPrimaryRoot } from './workspace-roots.js';

describe('normalizeWorkspaceRoots', () => {
  it('dedupes and sorts absolute roots', () => {
    const base = '/repos';
    const roots = normalizeWorkspaceRoots(['app', 'app', './app', 'lib'], base);
    expect(roots.map((r) => r.label).sort()).toEqual(['app', 'lib']);
    expect(roots.every((r) => path.isAbsolute(r.root))).toBe(true);
    expect(roots[0].id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('selectPrimaryRoot prefers explicit path', () => {
    const roots = normalizeWorkspaceRoots(['/a/lib', '/a/app'], '/a');
    const primary = selectPrimaryRoot(roots, '/a/app');
    expect(primary?.root).toBe(path.resolve('/a/app'));
  });

  it('isPathInside is safe against traversal', () => {
    expect(isPathInside('/repo/src', '/repo')).toBe(true);
    expect(isPathInside('/repo', '/repo')).toBe(true);
    expect(isPathInside('/other', '/repo')).toBe(false);
  });
});
