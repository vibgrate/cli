import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullDependencyGraph, fullDependencyTree, lockfileVersion } from '../src/engine/lockfile.js';
import { makeProject, cleanup } from './helpers.js';

/**
 * Regression coverage for #211: pnpm v9 lockfiles increasingly mix catalog
 * entries (`catalogs:` + `specifier: catalog:`) with `engines`/runtime keys.
 * Adjacent SBOM catalogers have aborted on such keys; Vibgrate's dependency
 * detection must keep extracting the same deterministic graph and must not
 * silently drop packages.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'pnpm-catalog-engines');

const dirs: string[] = [];
function projectFromFixture(): string {
  const files: Record<string, string> = {};
  for (const rel of ['package.json', 'pnpm-lock.yaml']) {
    files[rel] = fs.readFileSync(path.join(FIXTURE, rel), 'utf8');
  }
  const dir = makeProject(files);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('pnpm v9 lockfile with catalogs and engines keys (#211)', () => {
  it('resolves catalog-pinned and plain dependencies from importers', () => {
    const root = projectFromFixture();
    expect(lockfileVersion(root, 'npm', 'react')).toBe('19.0.0');
    expect(lockfileVersion(root, 'npm', 'left-pad')).toBe('1.3.0');
  });

  it('extracts the full packages graph without dropping engines-keyed packages', () => {
    const root = projectFromFixture();
    const components = fullDependencyTree(root);
    expect(components).toBeDefined();
    expect(components!.map((c) => `${c.package}@${c.version}`)).toEqual([
      '@types/react@19.0.0',
      'left-pad@1.3.0',
      'react@19.0.0',
      'typescript@5.6.3',
    ]);
  });

  it('is deterministic across repeated reads (same input, same graph)', () => {
    const root = projectFromFixture();
    const first = JSON.stringify(fullDependencyGraph(root));
    const second = JSON.stringify(fullDependencyGraph(root));
    expect(second).toBe(first);
  });
});
