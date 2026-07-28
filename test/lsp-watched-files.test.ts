import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isDependencyFile } from '../src/lsp/scan-cache.js';

// The filter behind `workspace/didChangeWatchedFiles`: an external manifest or
// lockfile change (a terminal `vg fix`, a git checkout) must schedule a rescan,
// while changes in skipped trees or to ordinary source files must not.
describe('isDependencyFile', () => {
  const root = path.join(path.sep, 'ws');
  const at = (...p: string[]) => path.join(root, ...p);

  it('accepts manifests, including nested and .NET project files', () => {
    expect(isDependencyFile(root, at('package.json'))).toBe(true);
    expect(isDependencyFile(root, at('src', 'Bridge.Api', 'Bridge.Api.csproj'))).toBe(true);
    expect(isDependencyFile(root, at('services', 'go.mod'))).toBe(true);
    expect(isDependencyFile(root, at('pyproject.toml'))).toBe(true);
  });

  it('accepts lockfiles', () => {
    expect(isDependencyFile(root, at('package-lock.json'))).toBe(true);
    expect(isDependencyFile(root, at('pnpm-lock.yaml'))).toBe(true);
    expect(isDependencyFile(root, at('app', 'packages.lock.json'))).toBe(true);
  });

  it('rejects files inside skipped trees, whatever their name', () => {
    expect(isDependencyFile(root, at('node_modules', 'left-pad', 'package.json'))).toBe(false);
    expect(isDependencyFile(root, at('api', 'bin', 'Debug', 'Api.csproj'))).toBe(false);
    expect(isDependencyFile(root, at('api', 'obj', 'project.assets.json'))).toBe(false);
    expect(isDependencyFile(root, at('.git', 'package.json'))).toBe(false);
  });

  it('rejects ordinary source files', () => {
    expect(isDependencyFile(root, at('src', 'index.ts'))).toBe(false);
    expect(isDependencyFile(root, at('README.md'))).toBe(false);
  });

  it('rejects paths outside the workspace root', () => {
    expect(isDependencyFile(root, path.join(path.sep, 'elsewhere', 'package.json'))).toBe(false);
    expect(isDependencyFile(root, at('..', 'package.json'))).toBe(false);
  });
});
